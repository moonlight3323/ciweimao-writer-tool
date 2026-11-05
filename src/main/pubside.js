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
  let lastState = null;

  function send(channel, payload) {
    if (sideWin && !sideWin.isDestroyed()) {
      try { sideWin.webContents.send(channel, payload); } catch (_) { /* ignore */ }
    }
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
    sideWin.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: WIDTH,
      height: Math.round(height),
    });
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
    sideWin.loadFile(path.join(__dirname, '..', 'renderer', 'side.html'));
    // 页面还没加载完就 send 会丢消息（第一次打开必然是这种情况），加载完补发一次
    sideWin.webContents.on('did-finish-load', () => {
      if (lastState) send('pubside:state', lastState);
    });
    sideWin.on('closed', () => { sideWin = null; wanted = false; manual = false; });
    // 作者自己拖过就记为「手动定位」，之后不再被主窗口移动拽回来
    sideWin.on('move', () => { if (!placing) manual = true; });
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
    if (!w.isVisible()) w.showInactive();
    // showInactive 在页面还没加载完时偶尔不生效（窗口停在 show:false），兜一次
    setTimeout(() => {
      if (wanted && w && !w.isDestroyed() && !w.isVisible()) {
        try { w.show(); } catch (_) { /* ignore */ }
      }
    }, 320);
    if (lastState) send('pubside:state', lastState);
    return { ok: true, visible: true };
  }

  function hideSide() {
    wanted = false;
    if (sideWin && !sideWin.isDestroyed()) sideWin.hide();
    return { ok: true, visible: false };
  }

  function destroy() {
    wanted = false;
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
    /** 侧栏窗口是否已创建（测试用） */
    window() { return sideWin; },
  };
}

module.exports = { createPubSide, PUB_SIDE_WIDTH: WIDTH };
