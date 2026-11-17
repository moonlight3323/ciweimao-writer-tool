'use strict';

/**
 * 敏感词侧栏（独立悬浮窗）。
 *
 * 为什么不是主窗口里的一条 DOM：
 * 后台页面是原生 WebContentsView，层级高于网页 DOM —— 侧栏若留在主窗口里，只能靠
 * 「让页面视图让出宽度」来解决遮挡，而刺猬猫后台是固定宽度布局，一被挤到 756px 就重排变形。
 * 所以侧栏单独开一个无边框窗口浮在主窗口右侧（屏幕上放不下时压在主窗口右缘）：
 * **页面视图宽度一点不变，排版不会动**。
 *
 * 该窗口只负责显示与收集选择，所有业务动作（校验、改正文、提交）仍由主窗口的
 * renderer/publish.js 执行 —— 逻辑只有一份。
 */

const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');

const WIDTH = 372;
/** 让开应用自己的顶栏，侧栏从内容区顶部开始，看起来像贴在页面边上 */
const TOP_OFFSET = 56;

function createPubSide(deps) {
  const getWindow = deps.getWindow;

  /** @type {BrowserWindow|null} */
  let sideWin = null;
  /** 用户是「想看」状态还是手动关掉了；主窗口最小化/还原时按它决定要不要跟着显示 */
  let wanted = false;
  let attachedTo = null;
  /** 作者自己拖动过侧栏（比如拖到副屏），就别再被主窗口的移动拽回来 */
  let manual = false;
  let placing = false;
  /** 上一次由 place() 写入的位置：用来识别「自己造成的 move」 */
  let lastPlaced = null;
  let lastState = null;
  /** 侧栏页面自身的加载错误（有值就说明窗口是白板，界面要据此报错） */
  let loadError = '';

  function send(channel, payload) {
    if (sideWin && !sideWin.isDestroyed()) {
      try { sideWin.webContents.send(channel, payload); } catch (_) { /* ignore */ }
    }
  }

  /** 把主进程这边的故障转给主窗口，走它那条盖不住的顶栏状态条 */
  function reportToMain(text) {
    const main = getWindow();
    if (!main || main.isDestroyed()) return;
    try {
      main.webContents.send('pubside:fault', { text: String(text || '') });
    } catch (_) { /* ignore */ }
  }

  /** 贴主窗口右缘摆放：优先放到窗口右侧外面，屏幕不够就压在窗口右缘上 */
  function place() {
    const main = getWindow();
    if (!main || main.isDestroyed() || !sideWin || sideWin.isDestroyed()) return;
    if (manual) return;
    // 主窗口最小化时 getContentBounds() 会返回 -32000 与 0×0（Windows 的老毛病），
    // 照着算会把侧栏摆到屏幕左上角、高度塌成最小值。这种情况直接跳过摆位。
    const b = main.getContentBounds();
    if (!b || b.width < 100 || b.height < 100 || b.x < -20000) return;
    const area = screen.getDisplayMatching(b).workArea;
    const height = Math.max(280, Math.min(b.height - TOP_OFFSET, area.height));
    const y = Math.max(area.y, Math.min(b.y + TOP_OFFSET, area.y + area.height - height));

    let x = b.x + b.width;
    if (x + WIDTH > area.x + area.width) x = b.x + b.width - WIDTH;
    if (x < area.x) x = area.x;

    placing = true;
    const next = {
      x: Math.round(x),
      y: Math.round(y),
      width: WIDTH,
      height: Math.round(height),
    };
    lastPlaced = next;
    sideWin.setBounds(next);
    // setBounds 也会触发 move 事件，得把这一段自己造成的位移排除掉
    setTimeout(() => { placing = false; }, 160);
  }

  function ensure() {
    if (sideWin && !sideWin.isDestroyed()) return sideWin;
    const main = getWindow();

    sideWin = new BrowserWindow({
      width: WIDTH,
      height: 600,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // 无 parent：它要能自己待在主窗口外面（甚至拖到副屏）；位置由 place() 跟住主窗口
      backgroundColor: '#fdfaf1',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'side-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    try { sideWin.setMenuBarVisibility(false); } catch (_) { /* ignore */ }
    // 贴在主窗口右缘时必然和主窗口重叠十几像素；无边框窗口若压在普通窗口下面，
    // 用户看到的就是「点了按钮但侧栏没出来」，再点一次反而把它收起来。
    // 置顶到 floating 层级，保证它总在应用窗口之上（不抢焦点，hide 后立刻消失）。
    try { sideWin.setAlwaysOnTop(true, 'floating'); } catch (_) { /* 老版本不支持就退回普通窗口 */ }
    sideWin.loadFile(path.join(__dirname, '..', 'renderer', 'side.html'));
    // 页面还没加载完就 send 会丢消息（第一次打开必然是这种情况），加载完补发一次
    sideWin.webContents.on('did-finish-load', () => {
      if (lastState) send('pubside:state', lastState);
    });
    /*
     * 侧栏自己的页面没加载起来（side.html 缺失、被杀软拦住、磁盘读错）时，
     * 窗口会挂在全白状态 —— 从作者角度这就是「打不开」。把原因写进主窗口顶栏，
     * 别让人对着一块白板猜。
     */
    sideWin.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = 主动中断（切换/关闭），不算失败
      loadError = `侧栏页面加载失败（${code} ${desc || ''}）`.trim();
      reportToMain(loadError);
    });
    sideWin.on('closed', () => {
      sideWin = null; wanted = false; manual = false; lastPlaced = null; loadError = '';
    });
    /*
     * 作者自己拖过就记为「手动定位」，之后不再被主窗口移动拽回来。
     * 不能只靠 placing 的 160ms 窗口：系统卡顿时 setBounds 的 move 可能晚到，
     * 会被误判成用户拖动，此后再也不跟随主窗口。位置和上次写入的一致就忽略。
     */
    sideWin.on('move', () => {
      if (placing) return;
      try {
        const b = sideWin.getBounds();
        if (lastPlaced
            && b.x === lastPlaced.x && b.y === lastPlaced.y
            && b.width === lastPlaced.width && b.height === lastPlaced.height) return;
      } catch (_) { /* 拿不到就按手动处理 */ }
      manual = true;
    });
    return sideWin;
  }

  /** 主窗口移动/缩放时跟着走；最小化时收起来，还原时再出现 */
  function attach() {
    const main = getWindow();
    if (!main || main === attachedTo) return;
    attachedTo = main;
    main.on('move', () => { if (wanted) place(); });
    main.on('resize', () => { if (wanted) place(); });
    main.on('minimize', () => { if (sideWin && !sideWin.isDestroyed()) sideWin.hide(); });
    main.on('restore', () => { if (wanted) openSide(null, { keepPosition: true }); });
    main.on('closed', () => { destroy(); attachedTo = null; });
  }

  /**
   * @param {object|null} state 要显示的内容
   * @param {object} [opts] { keepPosition: true } = 保留作者手动摆放的位置
   *        （最小化后还原走这条路，否则副屏上的侧栏每次都被拽回主窗口边上）
   */
  function openSide(state, opts) {
    const o = opts || {};
    if (state) lastState = state;
    wanted = true;
    // 作者点顶栏重新打开时回到默认位置；系统触发的显示则保留原位
    if (!o.keepPosition) manual = false;
    const w = ensure();
    attach();
    place();
    // 主窗口最小化时不把侧栏单独亮出来，等还原时 attach 里的 restore 处理
    const main = getWindow();
    if (main && main.isMinimized()) return { ok: true, visible: false, deferred: true };
    if (!w.isVisible()) {
      try { w.showInactive(); } catch (_) { /* 某些 Windows 环境下会抛，交给下面兜底 */ }
    }
    // showInactive 在页面还没加载完时偶尔不生效（窗口停在 show:false）。
    // 以前只靠 320ms 后的一次补 show，冷启动时页面更慢，补的时候可能已经错过；
    // 这里先同步补一次并回读真实可见性，让调用方知道「到底有没有显示出来」。
    let visible = false;
    try { visible = w.isVisible(); } catch (_) { visible = false; }
    if (!visible) {
      try { w.show(); visible = w.isVisible(); } catch (_) { /* ignore */ }
    }
    setTimeout(() => {
      if (wanted && w && !w.isDestroyed() && !w.isVisible()) {
        try { w.show(); } catch (_) { /* ignore */ }
      }
    }, 320);
    if (lastState) send('pubside:state', lastState);
    return { ok: true, visible, error: loadError };
  }

  /**
   * 侧栏是否和主窗口在同一块屏幕上。
   *
   * 多显示器 + 作者手动拖过窗口时，侧栏可能开在另一块屏上：主屏上看不到任何变化，
   * 再点顶栏按钮反而把它收起来。界面据此把它移回主窗口旁边，而不是当成「已打开」。
   */
  function locate() {
    if (!sideWin || sideWin.isDestroyed()) {
      return { ready: false, visible: false, sameDisplay: false, bounds: null };
    }
    const b = sideWin.getBounds();
    const main = getWindow();
    const mb = main && !main.isDestroyed() ? main.getContentBounds() : null;
    let sameDisplay = true;
    try {
      const disp = screen.getDisplayMatching(b);
      const mainDisp = mb ? screen.getDisplayMatching(mb) : null;
      sameDisplay = !!(disp && mainDisp && disp.id === mainDisp.id);
    } catch (_) { sameDisplay = true; }
    return { ready: true, visible: sideWin.isVisible(), sameDisplay, bounds: b };
  }

  function hideSide() {
    wanted = false;
    if (sideWin && !sideWin.isDestroyed()) sideWin.hide();
    return { ok: true, visible: false };
  }

  function destroy() {
    wanted = false;
    loadError = '';
    if (sideWin && !sideWin.isDestroyed()) {
      try { sideWin.destroy(); } catch (_) { /* ignore */ }
    }
    sideWin = null;
  }

  function setState(state) {
    lastState = state;
    send('pubside:state', state);
    return true;
  }

  // ------------------------------------------------------------ IPC

  ipcMain.handle('pubside:open', (_e, state) => openSide(state));
  ipcMain.handle('pubside:close', () => hideSide());
  ipcMain.handle('pubside:set-state', (_e, state) => setState(state));
  ipcMain.handle('pubside:is-open', () => ({
    visible: !!(sideWin && !sideWin.isDestroyed() && sideWin.isVisible()),
  }));
  ipcMain.handle('pubside:locate', () => locate());
  ipcMain.handle('pubside:reflow', () => { manual = false; place(); return locate(); });

  // 侧栏窗口自己的动作：× 收起
  ipcMain.on('pubside:hide', () => hideSide());

  // 内容变高变矮时可以让主进程重摆一次（目前窗口高度随主窗口走，留个口子）
  ipcMain.on('pubside:reflow', () => { manual = false; place(); });

  // 侧栏里的按钮 → 转给主窗口去执行（它才掌握页面与本地稿）
  ipcMain.on('pubside:command', (_e, cmd) => {
    const main = getWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('pubside:command', cmd || {});
    }
  });

  return {
    open: openSide,
    hide: hideSide,
    close: hideSide,
    destroy,
    attach,
    setState,
    locate,
    /** 侧栏窗口是否已创建（测试用） */
    window() { return sideWin; },
  };
}

module.exports = { createPubSide, PUB_SIDE_WIDTH: WIDTH };
