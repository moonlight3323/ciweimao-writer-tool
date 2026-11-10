'use strict';

/**
 * 摸鱼码字：一个几乎隐形的透明浮层，内容实时回推到码字台当前章节。
 *
 * 为什么放在主进程：
 *   1. 浮层必须是**独立窗口**（置顶、无边框、逐像素透明），渲染层做不出来；
 *   2. 打开浮层时要把主窗口藏起来、退出时再拉回来，这是窗口生命周期；
 *   3. 隐藏/唤回要有**全局**快捷键 —— 用户那时候焦点在别的程序上。
 *
 * 数据只走一条线：浮层 textarea --input--> 这里 --'moyu:text'--> 码字台。
 * 反向不推（码字台在浮层打开期间是隐藏的，改不了），恢复窗口时以浮层为准。
 *
 * 与 src/main/miaoyu.js（喵语数据站）是两个东西，命名只差一个字母，别改混。
 */

const path = require('path');
const { BrowserWindow, globalShortcut, screen } = require('electron');
const { DEFAULTS, normaliseSettings, normaliseAccelerator, normaliseFontStack, hotkeyCandidates, pickHotkey } = require('./moyu-config');

/** 设置存在 ui-prefs.json 的这个键下，别和其它偏好混在一起 */
const PREF_KEY = 'moyu';

/** 浮层尺寸预设：用户点「窄 / 中 / 宽」，比让他去拖边框省事 */
const SIZE_PRESETS = {
  small: { width: 560, height: 240 },
  medium: { width: 680, height: 320 },
  large: { width: 880, height: 420 },
};

/** @type {{getWindow: () => any, readPrefs: () => object, writePrefs: (prefs: object) => void, onRestore: () => void}} */
let deps = {
  getWindow: () => null,
  readPrefs: () => ({}),
  writePrefs: () => {},
  onRestore: () => {},
};

/** @type {BrowserWindow|null} */
let overlay = null;
/** 当前生效的设置（已归一化） */
let settings = { ...DEFAULTS };
/** 当前注册成功的全局快捷键，空串表示没注册上 */
let activeHotkey = '';
/** 用户自己设的组合（空串表示用内置降级链）；注册失败时要拿它跟 activeHotkey 对比 */
let wantedHotkey = '';
/** 会话：{ bookId, chapterId, title, bookName }；null 表示没有在用的浮层 */
let session = null;
/**
 * 正文字体族，由码字台的「字体」设置随 open 一起传进来。
 * 不写进 settings 落盘 —— 它是「跟着码字台走」的派生值，存下来只会跟码字台对不上。
 */
let sessionFont = '';
/** 最后一次收到的正文，恢复窗口时补推一次，防止末尾几个字丢掉 */
let lastText = '';
/** 正在关闭，避免 moved/resize 把一次退出又写回设置 */
let closing = false;
/** 拖动/缩放写盘的防抖定时器 */
let boundsTimer = null;
/** 拖动会话：{ cursor: {x,y}, window: {x,y}, startedAt } */
let dragOrigin = null;
/** 拖动时的跟随定时器（16ms 一帧） */
let dragTimer = null;

function updateDeps(next) {
  deps = { ...deps, ...(next || {}) };
}

function loadSettings() {
  const prefs = deps.readPrefs() || {};
  settings = normaliseSettings(prefs[PREF_KEY]);
  return settings;
}

/**
 * 写回设置。
 *
 * `notify` 为 false 时不回推给浮层 —— 拖动窗口时每 400ms 就会存一次位置，
 * 每次都往页面里塞一遍完整设置会让设置面板闪。
 */
function persistSettings(patch, notify) {
  settings = normaliseSettings({ ...settings, ...patch });
  try {
    const prefs = deps.readPrefs() || {};
    prefs[PREF_KEY] = settings;
    deps.writePrefs(prefs);
  } catch (_) { /* 偏好写不进去不影响浮层使用 */ }
  if (notify !== false && overlay && !overlay.isDestroyed()) {
    overlay.webContents.send('overlay:settings', settings);
  }
  return settings;
}

/** 鼠标所在屏的可用区域：多显示器时用户多半在副屏摸鱼，按主屏摆会摆到别的屏上 */
function workArea() {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  } catch (_) {
    return { x: 0, y: 0, width: 1280, height: 800 };
  }
}

function clampToArea(value, size, origin, areaSize) {
  const max = origin + areaSize - size;
  return Math.round(Math.max(origin, Math.min(value, Math.max(origin, max))));
}

function initialBounds() {
  const area = workArea();
  const width = Math.min(settings.width, area.width);
  const height = Math.min(settings.height, area.height);
  const x = settings.x === null
    ? Math.round(area.x + (area.width - width) / 2)
    : clampToArea(settings.x, width, area.x, area.width);
  const y = settings.y === null
    ? Math.round(area.y + area.height * 0.22)
    : clampToArea(settings.y, height, area.y, area.height);
  return { x, y, width, height };
}

function rememberBounds() {
  if (closing) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!overlay || overlay.isDestroyed()) return;
    const b = overlay.getBounds();
    persistSettings({ x: b.x, y: b.y, width: b.width, height: b.height }, false);
  }, 400);
}

/**
 * 停止拖动跟随。幂等：没在拖的时候调用什么也不做。
 */
function endDrag() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  dragOrigin = null;
  return true;
}

/**
 * 开始拖动浮层。
 *
 * 为什么不用 `-webkit-app-region: drag`：那是系统级拖拽区，鼠标按下后事件不交给页面，
 * 页面既拿不到 mousedown，也没法把光标显示成十字箭头；透明无边框窗口上它还会整个失灵
 * （用户反馈过「拖不动」）。所以改成自己跟：
 *
 *   1. 记下按下瞬间的系统光标位置与窗口位置；
 *   2. 之后每 16ms 采一次光标，光标走了多少，窗口就走多少；
 *   3. 页面松开鼠标（或焦点被抢走）时 endDrag。
 *
 * 用主进程采样而不是渲染层的 mousemove：窗口跟着光标走的时候，光标的屏幕坐标是稳定的，
 * 而渲染层的事件会受窗口移动、节流影响，容易一顿一顿。
 */
function startDrag() {
  const win = overlay;
  if (!win || win.isDestroyed()) return { ok: false };
  endDrag();
  dragOrigin = {
    cursor: screen.getCursorScreenPoint(),
    window: win.getBounds(),
    startedAt: Date.now(),
  };
  dragTimer = setInterval(() => {
    if (!overlay || overlay.isDestroyed() || !dragOrigin) { endDrag(); return; }
    // 60 秒兜底：万一 mouseup 丢了，不能让定时器一直把窗口拴在光标上
    if (Date.now() - dragOrigin.startedAt > 60000) { endDrag(); return; }
    const cur = screen.getCursorScreenPoint();
    const x = dragOrigin.window.x + (cur.x - dragOrigin.cursor.x);
    const y = dragOrigin.window.y + (cur.y - dragOrigin.cursor.y);
    const now = overlay.getBounds();
    if (now.x !== x || now.y !== y) overlay.setPosition(x, y);
  }, 16);
  return { ok: true };
}

function ensureWindow() {
  if (overlay && !overlay.isDestroyed()) return overlay;

  const bounds = initialBounds();
  overlay = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 摸鱼场景经常压在全屏网页 / 视频上：screen-saver 层才不会被盖住
    alwaysOnTop: true,
    title: '摸鱼码字',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'moyu-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 浮层本身就是个小输入框，没必要为它单独降频；保持默认即可
    },
  });

  try { overlay.setMenuBarVisibility(false); } catch (_) { /* 无边框窗口一般没有菜单栏 */ }
  try { overlay.setAlwaysOnTop(true, 'screen-saver'); } catch (_) { /* 老系统忽略层级 */ }
  try { overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) { /* ignore */ }

  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlay.on('move', rememberBounds);
  overlay.on('resize', rememberBounds);
  // 焦点被别的窗口抢走时鼠标松开事件就收不到了：兜底把拖动停掉
  overlay.on('blur', () => endDrag());
  overlay.on('closed', () => {
    overlay = null;
    endDrag();
    // 用户用 Alt+F4 / 任务管理器把浮层关掉了：这时主窗口还是 hide 的状态，
    // 不还回去人就等于被锁在外面了（托盘还能救，但不该指望用户知道）。
    // 自己走 closeSession 时 session 已经先清空，不会重复触发。
    if (session) {
      session = null;
      sessionFont = '';
      unregisterHotkey();
      try { deps.onRestore(); } catch (_) { /* ignore */ }
    }
  });
  return overlay;
}

function unregisterHotkey() {
  if (!activeHotkey) return;
  try { globalShortcut.unregister(activeHotkey); } catch (_) { /* 已经没了也不影响 */ }
  activeHotkey = '';
}

/** 把「实际生效 / 用户想要 / 是否被占用」一起推给浮层，界面才说得清为什么换了个键 */
function notifyHotkey() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.webContents.send('overlay:hotkey', {
    combo: activeHotkey,
    wanted: wantedHotkey,
    ok: !wantedHotkey || wantedHotkey === activeHotkey,
  });
}

/**
 * 注册隐藏/唤回用的全局快捷键。
 * 只在浮层会话期间注册 —— 平时不占用系统热键，也就不会和别的软件抢。
 *
 * 用户设了自定义组合就优先试它；被别人占用时自动退回内置链，
 * 但 wantedHotkey 保留用户的选择，浮层会显示「你设的没用上」。
 */
function registerHotkey() {
  const nextWanted = normaliseAccelerator(settings.hotkey);
  const candidates = hotkeyCandidates(settings.hotkey);
  // 组合没变就别 unregister 再 register 折腾一遍系统热键（重设成同一个键时会走这里）
  const sameWanted = nextWanted === wantedHotkey;
  if (activeHotkey && sameWanted && (!nextWanted || activeHotkey === nextWanted)) {
    notifyHotkey();
    return activeHotkey;
  }

  unregisterHotkey();
  wantedHotkey = nextWanted;
  activeHotkey = pickHotkey(candidates, (combo) => globalShortcut.register(combo, onHotkey));
  notifyHotkey();
  return activeHotkey;
}

/** 快捷键：浮层显示中就藏起来，藏着就拉回来（主窗口保持原样） */
function onHotkey() {
  if (!overlay || overlay.isDestroyed()) return;
  if (overlay.isVisible()) {
    overlay.hide();
  } else {
    overlay.show();
    overlay.focus();
  }
}

function hideOverlay() {
  if (!overlay || overlay.isDestroyed()) return false;
  overlay.hide();
  return true;
}

function forwardText(text) {
  if (typeof text !== 'string') return;
  if (text === lastText) return;
  lastText = text;
  const main = deps.getWindow();
  if (main && !main.isDestroyed()) main.webContents.send('moyu:text', { text });
}

/**
 * 打开浮层。
 *
 * @param {{bookId?:string, bookName?:string, chapterId?:string, title?:string, content?:string}} payload
 *        码字台把当前章节的标题与正文一起递进来，浮层里接着写，不用重新读取文件。
 */
async function open(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  session = {
    bookId: String(data.bookId || ''),
    chapterId: String(data.chapterId || ''),
    title: String(data.title || ''),
    bookName: String(data.bookName || ''),
  };
  lastText = typeof data.content === 'string' ? data.content : '';
  // 字体只跟字体：字号/行距仍由浮层自己的设置控制（浮层悬在别的窗口上，字小看不清）
  sessionFont = normaliseFontStack(data.font);
  closing = false;
  loadSettings();

  const win = ensureWindow();
  const main = deps.getWindow();

  const present = () => {
    if (!win || win.isDestroyed()) return;
    // 先把浮层显示出来，再藏主窗口：反过来的话中间会闪一下桌面
    win.show();
    win.focus();
    win.webContents.send('overlay:init', {
      text: lastText,
      title: session ? session.title : '',
      bookName: session ? session.bookName : '',
      settings,
      font: sessionFont,
      hotkey: activeHotkey,
      hotkeyWanted: wantedHotkey,
      hotkeyOk: !wantedHotkey || wantedHotkey === activeHotkey,
    });
    if (main && !main.isDestroyed() && main.isVisible()) main.hide();
  };

  // 先注册再推 init：反过来 init 里的快捷键永远是上一次会话的值
  registerHotkey();

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', present);
  } else {
    present();
  }

  return { ok: true, hotkey: activeHotkey, hotkeyWanted: wantedHotkey };
}

/**
 * 把浮层里最后的状态读出来（输入是 120ms 防抖的，点「回到软件」时可能还压在页面里）。
 * 必须显式传窗口：closeSession 会先把模块级 overlay 置空再调用这里，
 * 读全局变量的话永远拿到 null，最后一段输入就静默丢了。
 */
async function readOverlayText(win) {
  if (!win || win.isDestroyed()) return '';
  try {
    const text = await win.webContents.executeJavaScript(
      '(document.getElementById("editor")||{}).value || ""', true);
    return typeof text === 'string' ? text : '';
  } catch (_) {
    return '';
  }
}

/**
 * 结束浮层会话。
 *
 * @param {{restore?: boolean}} [opts] restore=true 表示用户点「回到软件」，
 *        结束后把主窗口拉回来；false 用于托盘「显示主界面」这类外部触发。
 */
async function closeSession(opts) {
  const restore = !!(opts && opts.restore);
  const win = overlay;
  const had = !!session;
  overlay = null;
  // 先清会话：destroy 会同步触发 'closed'，那里也有一次「还回主窗口」的兜底，
  // 不清空就会走两遍。
  session = null;
  sessionFont = '';
  closing = true;
  clearTimeout(boundsTimer);
  endDrag();
  unregisterHotkey();

  if (win && !win.isDestroyed()) {
    const text = await readOverlayText(win);
    if (text) forwardText(text);
    try { win.hide(); } catch (_) { /* ignore */ }
    try { win.destroy(); } catch (_) { /* ignore */ }
  }

  closing = false;

  if (restore && had) {
    try { deps.onRestore(); } catch (_) { /* 拉不起窗口也不能把关闭流程搞崩 */ }
    const main = deps.getWindow();
    if (main && !main.isDestroyed()) main.webContents.send('moyu:closed', { text: lastText });
  }
  return { ok: true, restored: restore && had };
}

/** 浮层页面发来的设置补丁（字号、底色、窄中宽、快捷键） */
function applySettings(patch) {
  if (!patch || typeof patch !== 'object') return settings;
  const preset = patch.size && SIZE_PRESETS[patch.size];
  const next = preset ? { ...patch, ...preset } : patch;
  if (preset) delete next.size;
  const hotkeyChanged = Object.prototype.hasOwnProperty.call(patch, 'hotkey');
  const before = { width: settings.width, height: settings.height };
  const saved = persistSettings(next, true);
  // 换了快捷键要立刻重注册：不然用户以为生效了，实际还按着旧键
  if (hotkeyChanged && overlay && !overlay.isDestroyed()) registerHotkey();
  if (overlay && !overlay.isDestroyed() && (saved.width !== before.width || saved.height !== before.height)) {
    const b = overlay.getBounds();
    const area = workArea();
    const width = Math.min(saved.width, area.width);
    const height = Math.min(saved.height, area.height);
    overlay.setBounds({
      x: clampToArea(b.x, width, area.x, area.width),
      y: clampToArea(b.y, height, area.y, area.height),
      width,
      height,
    });
  }
  return saved;
}

function state() {
  return {
    open: !!overlay && !overlay.isDestroyed(),
    visible: !!overlay && !overlay.isDestroyed() && overlay.isVisible(),
    hotkey: activeHotkey,
    hotkeyWanted: wantedHotkey,
    hotkeyOk: !wantedHotkey || wantedHotkey === activeHotkey,
    settings,
    session: session ? { ...session } : null,
  };
}

/** 退出前收尾：热键必须还回去，否则进程没了系统里还占着组合键 */
function dispose() {
  clearTimeout(boundsTimer);
  endDrag();
  unregisterHotkey();
  if (overlay && !overlay.isDestroyed()) {
    try { overlay.destroy(); } catch (_) { /* ignore */ }
  }
  overlay = null;
  session = null;
  sessionFont = '';
}

module.exports = {
  PREF_KEY,
  SIZE_PRESETS,
  updateDeps,
  open,
  closeSession,
  hideOverlay,
  applySettings,
  forwardText,
  readOverlayText,
  registerHotkey,
  unregisterHotkey,
  startDrag,
  endDrag,
  state,
  dispose,
  // 测试用：不建窗口也能验证设置读写
  _loadSettings: loadSettings,
  _persistSettings: persistSettings,
};
