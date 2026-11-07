'use strict';

/**
 * 刺猬猫作家助手 — 主进程入口
 *
 * 架构要点：
 * 1. 本地 UI 由渲染进程（renderer/index.html）承载。
 * 2. 平台页面通过独立的 WebContentsView 承载，使用 persist:ciweimao 分区，
 *    登录态由 Chromium 自行落盘，应用不保存任何账号密码。
 * 3. 所有对平台的读取动作，都在该 View 的页面上下文里执行，天然携带
 *    cookie / referer / 浏览器指纹，无需逆向登录与签名。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, net, dialog, nativeTheme, Tray, Menu } = require('electron');
const vault = require('./vault');
const miaoyu = require('./miaoyu');
const pubside = require('./pubside');
const aiApiModule = require('./api');
const library = require('./library');
const plugins = require('./plugins');
const aiexportModule = require('./aiexport');
const updater = require('./updater');
const closeBehavior = require('./closebehavior');
const badwordlib = require('./badwordlib');
const adapter = require('../adapters/ciweimao');
const { spawn } = require('child_process');

const PARTITION = 'persist:ciweimao';
const AUTHOR_HOME = 'https://author.ciweimao.com/homepage';

// 某些虚拟显示适配器会让 Chromium 的 GPU 进程沙箱启动失败。
if (process.env.CW_KEEP_GPU_SANDBOX !== '1') app.commandLine.appendSwitch('disable-gpu-sandbox');
/** 窗口与任务栏图标（未打包运行时不指定就会退回 Electron 默认图标） */
const APP_ICON = path.join(__dirname, '..', '..', 'assets', 'icon.ico');

/** @type {BrowserWindow|null} */
let win = null;
/** @type {WebContentsView|null} */
let browserView = null;
/** 当前平台页面是否已挂载到窗口上 */
let attached = false;
/** 进专注模式之前窗口是不是最大化的，退出时按它还原 */
let focusRestoreMaximized = false;

/** 退出兜底定时器：正常退出时会被 will-quit 清掉 */
let quitFallback = null;
/** 正在退出：防止 before-quit 里销毁窗口时重入 */
let quitting = false;
/** before-quit 的清理只跑一次；和 quitting 分开，否则 close 里先置位会把清理整段跳过 */
let beforeQuitDone = false;
/** 托盘图标：必须留引用，否则会被 GC 掉，图标就从右下角消失了 */
let tray = null;
/** 正在弹「关闭时怎么处理」的询问框，防止连点关闭叠出好几个 */
let closeAskPending = false;
/** 等待渲染层回答「关闭时怎么处理」的 resolver */
let closeAskResolver = null;

// ---------------------------------------------------------------- 关闭行为

/**
 * 点窗口关闭按钮之后怎么办：`minimize` 收进托盘、`quit` 直接退出、
 * 空串表示还没问过。
 *
 * 每次现读文件而不是缓存：设置页改完立刻生效，关闭又不频繁，读一次磁盘无所谓。
 */
function readCloseBehavior() {
  const v = readPrefsFile().closeBehavior;
  return v === 'minimize' || v === 'quit' ? v : '';
}

function writeCloseBehavior(value) {
  const prefs = readPrefsFile();
  prefs.closeBehavior = value;
  writePrefsFile(prefs);
}

/**
 * 首次关闭时问一次。
 *
 * 不用 dialog.showMessageBox：那是系统灰底框，跟软件整体的主题完全不搭。
 * 改成让渲染层弹自己的 notice-card，这里只等一个 Promise。
 */
function askCloseBehavior() {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed() || !win.webContents) {
      resolve('minimize');
      return;
    }
    closeAskResolver = resolve;
    win.webContents.send('window:ask-close-behavior');
    // 兜底：30 秒没回答就按最小化处理，别让窗口卡在「点了关闭却没反应」的状态
    setTimeout(() => {
      if (closeAskResolver === resolve) {
        closeAskResolver = null;
        resolve('minimize');
      }
    }, 30000);
  });
}

function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(fs.existsSync(APP_ICON) ? APP_ICON : undefined);
  } catch (_) {
    return; // 图标缺失时宁可不建托盘，也不能让启动挂掉
  }
  tray.setToolTip('刺猬猫作家助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}


function isLoginUrl(url) {
  if (!url) return false;
  return /\/login\b|\/login\/|\/login\/index/i.test(url);
}

/** 只有正牌登录页才允许注入/读取凭据 */
function isAuthorLoginUrl(url) {
  return /^https:\/\/author\.ciweimao\.com\/login(\/|$|\?)/i.test(String(url || ''));
}

// ---- 前进后退：Electron 新版把方法挪到了 navigationHistory 上，旧版还在 webContents ----
function canGoBack(wc) {
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === 'function') {
      return wc.navigationHistory.canGoBack();
    }
    if (typeof wc.canGoBack === 'function') return wc.canGoBack();
  } catch (_) { /* ignore */ }
  return false;
}

function canGoForward(wc) {
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoForward === 'function') {
      return wc.navigationHistory.canGoForward();
    }
    if (typeof wc.canGoForward === 'function') return wc.canGoForward();
  } catch (_) { /* ignore */ }
  return false;
}

function goBack(wc) {
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.goBack === 'function') {
      wc.navigationHistory.goBack();
      return true;
    }
    if (typeof wc.goBack === 'function') { wc.goBack(); return true; }
  } catch (_) { /* ignore */ }
  return false;
}

function goForward(wc) {
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.goForward === 'function') {
      wc.navigationHistory.goForward();
      return true;
    }
    if (typeof wc.goForward === 'function') { wc.goForward(); return true; }
  } catch (_) { /* ignore */ }
  return false;
}

const BG_LIGHT = '#f8f3e7';
const BG_DARK = '#17150f';

/** 读取界面偏好里的主题，决定窗口启动底色（渲染进程自己也会再应用一次） */
function bootBackground() {
  try {
    const p = path.join(dataDir(), 'ui-prefs.json');
    const pref = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (pref && pref.theme === 'dark') return BG_DARK;
    if (pref && pref.theme === 'light') return BG_LIGHT;
    if (pref && pref.theme === 'auto') {
      return nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT;
    }
  } catch (_) { /* 没有偏好文件就按浅色 */ }
  return BG_LIGHT;
}

function broadcast(payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('browser:event', payload);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    title: '刺猬猫作家助手',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    // 启动瞬间的底色要跟当前主题一致，否则深色主题下会闪一下白
    backgroundColor: bootBackground(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('resize', () => broadcast({ type: 'window-resized' }));
  pubSideApi.attach();

  /*
   * 关闭按钮的处理：默认收进托盘继续后台运行，只有明确退出才结束进程。
   * 第一次关闭时问一次并记住选择，之后可以在设置里改。
   */
  win.on('close', (e) => {
    // 判定逻辑在 closebehavior.js，纯函数、有测试盯着（这块错过两次）
    const action = closeBehavior.decide(quitting, readCloseBehavior());

    if (action === 'pass') {
      // 放行这次关闭。必须把 quitting 置位：否则窗口关了、进程还在，
      // 托盘图标一直挂着，点一下又能把界面拉起来（用户实测就是这样）
      quitting = true;
      return;
    }

    e.preventDefault();
    if (action === 'hide') {
      win.hide();
      return;
    }

    // 还没选过：这次先拦下来，问完再决定
    if (closeAskPending) return;
    closeAskPending = true;
    askCloseBehavior().then((choice) => {
      if (!win || win.isDestroyed()) return;
      writeCloseBehavior(choice);
      // 让渲染层里的偏好缓存跟上，否则设置页还会显示「未选择」
      try { win.webContents.send('window:close-behavior', choice); } catch (_) { /* ignore */ }
      if (choice === 'minimize') {
        win.hide();
      } else {
        quitting = true;
        app.quit();
      }
    }).catch(() => { /* 对话框异常就保持窗口不动，别把用户锁死在外面 */ })
      .finally(() => { closeAskPending = false; });
  });

  win.on('closed', () => {
    if (browserView) {
      try { browserView.webContents.close(); } catch (_) { /* ignore */ }
      browserView = null;
    }
    pubSideApi.destroy();
    miaoyuApi.destroy();
    win = null;
    // 主窗口被真正销毁（不是 hide）就意味着没有界面了，进程留着也没用：
    // 托盘点一下只会重建一个空壳窗口，还会拖着一堆后台进程。
    // 「最小化到托盘」那条路是 hide()，不会走到这里。
    if (process.platform !== 'darwin') app.quit();
  });
}

/** 惰性创建平台页面视图（含登录态分区） */
function ensureBrowserView() {
  if (browserView && !browserView.webContents.isDestroyed()) return browserView;

  const ses = session.fromPartition(PARTITION);

  browserView = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 平台是老站，关闭不必要的特性以降低资源占用
      spellcheck: false,
    },
  });

  const wc = browserView.webContents;

  wc.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );

  const pushState = () => {
    const url = wc.getURL();
    broadcast({
      type: 'browser-state',
      url,
      title: wc.getTitle(),
      isLoginPage: isLoginUrl(url),
      isLoading: wc.isLoading(),
      canGoBack: canGoBack(wc),
      canGoForward: canGoForward(wc),
    });
  };

  wc.on('did-start-loading', pushState);
  wc.on('did-stop-loading', pushState);
  wc.on('did-navigate', pushState);
  wc.on('did-navigate-in-page', pushState);
  wc.on('page-title-updated', pushState);

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 是中止（多为重定向引起），忽略
    if (code === -3) return;
    broadcast({ type: 'browser-error', code, desc, url });
  });

  // 平台页面自身弹出的 window.open 一律拦下，改为当前视图内导航
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url);
    return { action: 'deny' };
  });

  return browserView;
}

/** 把平台视图挂到窗口的指定矩形上 */
function attachBrowser(rect) {
  const view = ensureBrowserView();
  if (!win) return;

  if (!attached) {
    win.contentView.addChildView(view);
    attached = true;
  }
  applyBounds(rect);
}

function applyBounds(rect) {
  if (!browserView || !attached) return;
  const r = rect || {};
  const x = Math.max(0, Math.round(r.x ?? 0));
  const y = Math.max(0, Math.round(r.y ?? 0));
  const width = Math.max(1, Math.round(r.width ?? 800));
  const height = Math.max(1, Math.round(r.height ?? 600));
  browserView.setBounds({ x, y, width, height });
}

function detachBrowser() {
  if (!browserView || !win || !attached) return;
  win.contentView.removeChildView(browserView);
  attached = false;
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('browser:open', async (_e, rect, url) => {
  // 喵语视图与后台视图共用同一块区域，进来前先把另一个摘掉
  miaoyuApi.detach();
  attachBrowser(rect);
  const view = ensureBrowserView();
  const wc = view.webContents;
  const target = url || AUTHOR_HOME;
  const current = wc.getURL();
  // 「打开作者后台」是要看整个后台，不是回到上次停留的某个功能页（比如间贴管理）。
  // 只有已经停在后台首页时才保留原位置，避免刷新掉用户当前正在填的东西。
  const onBackendHome = /^https:\/\/author\.ciweimao\.com\/homepage/i.test(current || '');
  if (!current || !onBackendHome) {
    await wc.loadURL(target);
  } else {
    wc.focus();
  }
  return { url: wc.getURL() };
});

ipcMain.handle('browser:navigate', async (_e, url) => {
  const view = ensureBrowserView();
  await view.webContents.loadURL(url || AUTHOR_HOME);
});

// 只重新挂载已经加载好的后台页面，不导航，避免冲掉已填入的章节表单。
ipcMain.handle('browser:show', async (_e, rect) => {
  miaoyuApi.detach();
  attachBrowser(rect);
  const view = ensureBrowserView();
  view.webContents.focus();
  return { url: view.webContents.getURL() };
});

ipcMain.handle('browser:back', () => {
  const view = ensureBrowserView();
  return goBack(view.webContents);
});

ipcMain.handle('browser:forward', () => {
  const view = ensureBrowserView();
  return goForward(view.webContents);
});

ipcMain.handle('browser:home', async () => {
  const view = ensureBrowserView();
  await view.webContents.loadURL(AUTHOR_HOME);
  return view.webContents.getURL();
});

ipcMain.handle('browser:nav-state', () => {
  if (!browserView || browserView.webContents.isDestroyed()) {
    return { canGoBack: false, canGoForward: false };
  }
  return {
    canGoBack: canGoBack(browserView.webContents),
    canGoForward: canGoForward(browserView.webContents),
  };
});

ipcMain.handle('browser:reload', async () => {
  const view = ensureBrowserView();
  view.webContents.reload();
});

ipcMain.handle('browser:close', async () => {
  detachBrowser();
  return true;
});

ipcMain.handle('browser:bounds', async (_e, rect) => {
  applyBounds(rect);
  return true;
});

ipcMain.handle('browser:state', async () => {
  if (!browserView || browserView.webContents.isDestroyed()) {
    return { ready: false, url: '', isLoginPage: true };
  }
  const wc = browserView.webContents;
  const url = wc.getURL();
  return {
    ready: true,
    url,
    title: wc.getTitle(),
    isLoginPage: isLoginUrl(url),
    isLoading: wc.isLoading(),
    attached,
  };
});

/**
 * 在平台页面上下文执行脚本。
 * 这是所有数据抓取的统一入口：脚本运行在 author.ciweimao.com 源下，
 * 因此自带登录 cookie，可直接 fetch 同源接口或读取 DOM。
 */
ipcMain.handle('browser:eval', async (_e, code) => {
  const view = ensureBrowserView();
  const wc = view.webContents;
  if (!wc.getURL()) {
    throw new Error('平台页面尚未加载，请先打开作者后台');
  }
  return await wc.executeJavaScript(code, true);
});

/** 跳转到指定后台路径（相对 author.ciweimao.com） */
ipcMain.handle('browser:goto', async (_e, p) => {
  const view = ensureBrowserView();
  const url = p.startsWith('http') ? p : new URL(p, AUTHOR_HOME).toString();
  await view.webContents.loadURL(url);
  return view.webContents.getURL();
});

/** 等待页面加载完成，供抓取流程使用 */
ipcMain.handle('browser:wait-idle', async (_e, timeoutMs = 20000) => {
  const view = ensureBrowserView();
  const wc = view.webContents;
  if (!wc.isLoading()) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const done = () => { cleanup(); resolve(true); };
    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', done);
      wc.removeListener('did-fail-load', done);
    };
    wc.once('did-stop-loading', done);
    wc.once('did-fail-load', done);
  });
});

// ---------------------------------------------------------------- 敏感词侧栏（独立悬浮窗）

const pubSideApi = pubside.createPubSide({ getWindow: () => win });

// ---------------------------------------------------------------- 喵语数据站
//
// 内嵌控制全部在 ./miaoyu 里（可脱离整个应用单独起窗口测试），这里只挂 IPC。

const miaoyuApi = miaoyu.createMiaoyu({
  getWindow: () => win,
  broadcast,
  canGoBack,
  canGoForward,
  goBack,
  goForward,
});

ipcMain.handle('miaoyu:open', (_e, rect) => miaoyuApi.open(rect));
ipcMain.handle('miaoyu:bounds', (_e, rect) => { miaoyuApi.applyBounds(rect); return true; });
ipcMain.handle('miaoyu:close', () => { miaoyuApi.detach(); return true; });
ipcMain.handle('miaoyu:goto', (_e, which) => miaoyuApi.goto(which));
ipcMain.handle('miaoyu:reload', () => miaoyuApi.reload());
ipcMain.handle('miaoyu:back', () => miaoyuApi.back());
ipcMain.handle('miaoyu:forward', () => miaoyuApi.forward());
ipcMain.handle('miaoyu:external', () => miaoyuApi.external());
ipcMain.handle('miaoyu:state', () => miaoyuApi.state());

// ---------------------------------------------------------------- AI 接入
//
// 底座是「导出成文件」，加速器是本机只读接口 + MCP 桥。
// 接口默认关闭，用户在「设置 → AI 接入」里手动打开；关闭即销毁监听。

const aiApi = aiApiModule.createApi({
  getDataDir: () => dataDir(),
  getVersion: () => app.getVersion(),
});

const aiExport = aiexportModule.createAiexport({
  getDataDir: () => dataDir(),
  getVersion: () => app.getVersion(),
});

/** 便携包里 MCP 桥脚本的位置（开发态是项目根，打包后是 resources/app） */
function bridgePath() {
  return path.join(app.getAppPath(), 'tools', 'mcp-bridge.js');
}

/** 生成可直接粘贴的 MCP 配置。用 Electron 自身当 Node 跑桥，用户不必安装 Node。 */
function mcpConfig() {
  return {
    exe: process.execPath,
    bridge: bridgePath(),
    mcpServers: {
      ciweimao: {
        command: process.execPath,
        args: [bridgePath()],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    },
  };
}

ipcMain.handle('ai:status', () => {
  const st = aiApi.status();
  return Object.assign(st, { config: mcpConfig(), exportDir: aiExport.dir() });
});

ipcMain.handle('ai:start', async () => {
  try {
    const st = await aiApi.start();
    return Object.assign(st, { ok: true, config: mcpConfig(), exportDir: aiExport.dir() });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), running: false };
  }
});

ipcMain.handle('ai:stop', () => aiApi.stop());

ipcMain.handle('ai:export', () => {
  try {
    const r = aiExport.generate();
    return Object.assign({ ok: true }, r);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('ai:open-folder', () => {
  const dir = aiExport.dir();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return dir;
});

ipcMain.handle('ai:open-endpoint-folder', () => {
  shell.showItemInFolder(aiApi.endpointPath());
  return aiApi.endpointPath();
});

// ---- 正文归档：导出的同时留一份，供 AI 读剧情 ----

ipcMain.handle('library:archive', (_e, payload) => {
  try {
    return Object.assign({ ok: true }, library.archive(dataDir(), payload));
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('library:list', () => ({ books: library.listBooks(dataDir()) }));

ipcMain.handle('library:clear', () => ({ removed: library.clearAll(dataDir()) }));

// ---- 创作中心：作品库、新建、导入与章节保存 ----

function importedTextToBook(file, text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const fallbackName = path.basename(file, path.extname(file));
  if (path.extname(file).toLowerCase() === '.json') {
    const parsed = JSON.parse(raw);
    const src = Array.isArray(parsed) ? { name: fallbackName, chapters: parsed } : parsed;
    if (!src || !Array.isArray(src.chapters)) throw new Error('JSON 中没有 chapters 章节数组');
    return {
      name: String(src.name || fallbackName),
      chapters: src.chapters.map((c, i) => ({
        id: `chapter_${i + 1}`,
        title: String(c.title || `第${i + 1}章`),
        volume: String(c.volume || '正文'),
        content: String(c.content || ''),
      })),
    };
  }

  const lines = raw.split('\n');
  const chapterRe = /^\s*(第[零〇一二三四五六七八九十百千万两\d]+[章节回篇]\s*.*)$/;
  const volumeRe = /^\s*(第[零〇一二三四五六七八九十百千万两\d]+卷\s*.*)$/;
  const chapters = [];
  let volume = '正文';
  let title = '';
  let body = [];
  const flush = () => {
    const content = body.join('\n').trim();
    if (title || content) chapters.push({
      id: `chapter_${chapters.length + 1}`,
      title: title || (chapters.length ? `第${chapters.length + 1}章` : '正文'),
      volume,
      content,
    });
    title = '';
    body = [];
  };
  lines.forEach((line) => {
    const vol = line.match(volumeRe);
    if (vol) {
      flush();
      volume = vol[1].trim();
      return;
    }
    const ch = line.match(chapterRe);
    if (ch) {
      flush();
      title = ch[1].trim();
      return;
    }
    body.push(line);
  });
  flush();
  if (!chapters.length) chapters.push({ id: 'chapter_1', title: '正文', volume: '正文', content: raw.trim() });
  return { name: fallbackName, chapters };
}

ipcMain.handle('writer:list', () => ({ books: library.listBooks(dataDir()) }));
ipcMain.handle('writer:open', (_e, bookId) => ({ book: library.getBook(dataDir(), bookId) }));
ipcMain.handle('writer:create', (_e, name) => library.createBook(dataDir(), name));
// 后台新建的书补进本地作品库并绑定作品号，省掉投递时手动选一次
ipcMain.handle('writer:adopt', (_e, books) => library.adoptPlatformBooks(dataDir(), books));
ipcMain.handle('writer:save', (_e, book) => library.saveBook(dataDir(), book));
ipcMain.handle('writer:covers', (_e, list) => library.updateCovers(dataDir(), list));
ipcMain.handle('writer:pin', (_e, bookId, pinned) => ({
  result: library.setPinned(dataDir(), bookId, pinned),
}));
ipcMain.handle('writer:delete', (_e, bookId) => ({ deleted: library.deleteBook(dataDir(), bookId) }));
ipcMain.handle('writer:import', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: '导入书籍',
    properties: ['openFile'],
    filters: [
      { name: '书籍文件', extensions: ['txt', 'json'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
  try {
    const file = picked.filePaths[0];
    const parsed = importedTextToBook(file, fs.readFileSync(file, 'utf8'));
    const saved = library.saveBook(dataDir(), { ...parsed, source: 'import' });
    return { ok: true, book: saved.book };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ---- 插件中心：插件只读入沙箱页面，通过白名单 API 与应用通信 ----

ipcMain.handle('plugins:list', () => ({ plugins: plugins.list(dataDir()) }));
ipcMain.handle('plugins:get', (_e, id) => plugins.get(dataDir(), id));
ipcMain.handle('plugins:enable', (_e, id, enabled) => ({
  enabled: plugins.setEnabled(dataDir(), id, enabled),
}));
ipcMain.handle('plugins:open-folder', () => {
  const dir = plugins.pluginsDir(dataDir());
  shell.openPath(dir);
  return dir;
});
ipcMain.handle('plugins:import', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: '选择插件压缩包',
    properties: ['openFile'],
    filters: [{ name: '插件压缩包', extensions: ['zip'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
  try {
    return { ok: true, plugin: plugins.importZip(dataDir(), picked.filePaths[0]) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle('plugins:create-template', () => {
  try { return { ok: true, ...plugins.createTemplate(dataDir()) }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
ipcMain.handle('plugins:remove', (_e, id) => ({ removed: plugins.remove(dataDir(), id) }));
ipcMain.handle('plugins:storage-get', (_e, id, key) => plugins.storageGet(dataDir(), id, key));
ipcMain.handle('plugins:storage-set', (_e, id, key, value) => plugins.storageSet(dataDir(), id, key, value));

ipcMain.handle('app:user-data', () => dataDir());

// 专注模式：进的时候最大化，退出时还原「进之前是不是已经最大化」，
// 否则用户本来就用着最大化窗口，退出专注反而被缩小了
ipcMain.handle('window:focus-mode', (_e, on) => {
  if (!win || win.isDestroyed()) return { maximized: false };
  if (on) {
    focusRestoreMaximized = win.isMaximized();
    if (!focusRestoreMaximized) win.maximize();
  } else if (!focusRestoreMaximized) {
    win.unmaximize();
  }
  return { maximized: win.isMaximized() };
});

/**
 * 诊断包写盘。
 * 解析适配层依赖真实页面结构，站点改版时用同一机制重新测绘。
 */
ipcMain.handle('diag:save', async (_e, filename, content) => {
  const dir = path.join(dataDir(), 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const target = path.join(dir, safe);
  fs.writeFileSync(target, content, 'utf8');
  return target;
});

ipcMain.handle('diag:dir', () => path.join(dataDir(), 'diagnostics'));

// ---------------------------------------------------------------- 本地数据

function storageConfigPath() {
  return path.join(app.getPath('userData'), 'storage-location.json');
}

function readStorageConfig() {
  try { return JSON.parse(fs.readFileSync(storageConfigPath(), 'utf8')) || {}; }
  catch (_) { return {}; }
}

function writeStorageConfig(config) {
  fs.mkdirSync(path.dirname(storageConfigPath()), { recursive: true });
  fs.writeFileSync(storageConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

function configuredDataDir() {
  const cfg = readStorageConfig();
  if (typeof cfg.path === 'string' && path.isAbsolute(cfg.path)) return cfg.path;
  return '';
}

async function ensureInitialStorageChoice() {
  const cfg = readStorageConfig();
  if (cfg.choiceMade) return;
  const answer = await dialog.showMessageBox({
    type: 'question',
    title: '选择数据保存位置',
    message: '作品、章节草稿和本地数据保存在哪里？',
    detail: '你可以选择任意磁盘上的文件夹。若跳过或使用默认位置，数据会保存在系统默认目录，之后也能在设置中更改。',
    buttons: ['选择文件夹', '使用默认位置'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (answer.response === 0) {
    const picked = await dialog.showOpenDialog({
      title: '选择数据保存文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!picked.canceled && picked.filePaths[0]) {
      const chosen = path.resolve(picked.filePaths[0]);
      fs.mkdirSync(chosen, { recursive: true });
      writeStorageConfig({ path: chosen, choiceMade: true });
      return;
    }
  }
  writeStorageConfig({ path: '', choiceMade: true });
}

function dataDir() {
  const dir = configuredDataDir() || path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('storage:status', () => ({
  path: dataDir(),
  custom: !!configuredDataDir(),
  defaultPath: path.join(app.getPath('userData'), 'data'),
}));

ipcMain.handle('storage:choose', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: '选择数据保存文件夹',
    defaultPath: dataDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
  const chosen = path.resolve(picked.filePaths[0]);
  fs.mkdirSync(chosen, { recursive: true });
  writeStorageConfig({ path: chosen, choiceMade: true });
  return { ok: true, path: dataDir(), custom: true };
});

ipcMain.handle('storage:reset', () => {
  writeStorageConfig({ path: '', choiceMade: true });
  return { ok: true, path: dataDir(), custom: false };
});

ipcMain.handle('data:dir', () => dataDir());

ipcMain.handle('data:read', async (_e, name) => {
  const f = path.join(dataDir(), String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'));
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return null;
  }
});

ipcMain.handle('data:write', async (_e, name, content) => {
  const f = path.join(dataDir(), String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'));
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  fs.renameSync(tmp, f);
  return f;
});

ipcMain.handle('app:open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('app:open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('app:reveal', (_e, p) => shell.showItemInFolder(String(p)));

// 关闭行为：设置页读写它，close 事件也读它
ipcMain.handle('app:close-behavior:get', () => ({ value: readCloseBehavior() }));
ipcMain.handle('app:close-behavior:set', (_e, value) => {
  const v = value === 'quit' ? 'quit' : 'minimize';
  writeCloseBehavior(v);
  return { value: v };
});

// 渲染层回答「关闭时怎么处理」，把等待中的 Promise 解开
ipcMain.handle('window:close-behavior-answer', (_e, value) => {
  const resolve = closeAskResolver;
  closeAskResolver = null;
  if (resolve) resolve(value === 'quit' ? 'quit' : 'minimize');
  return { ok: true };
});

// ---------------------------------------------------------------- 执行动作
//
// 这是整个应用里唯一会改动平台状态的入口，守卫放在主进程：
// 1. 动作白名单，参数必须是纯数字；
// 2. 平台页面必须已打开且不是登录页；
// 3. 每一次真实动作都写进 data/actions-log.json，删了也能查到。
// 界面上的「演练」不会走到这里，只在渲染进程里生成请求预览。

const EXEC_ACTIONS = { delete: 'execDeleteTsukkomi', mute: 'execMuteReader' };
const VERIFY_ACTIONS = { delete: 'verifyTsukkomi', mute: 'verifyMuted' };
const ACTIONS_LOG = 'actions-log.json';

function actionsLogPath() {
  return path.join(dataDir(), ACTIONS_LOG);
}

function readActionsLog() {
  try {
    const raw = JSON.parse(fs.readFileSync(actionsLogPath(), 'utf8'));
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch (_) {
    return [];
  }
}

function appendActionLog(entry) {
  const entries = readActionsLog();
  entries.push(entry);
  // 只留最近 500 条，避免文件无限膨胀
  const trimmed = entries.slice(-500);
  fs.writeFileSync(actionsLogPath(), JSON.stringify({ entries: trimmed }, null, 2), 'utf8');
  return trimmed.length;
}

/** 校验目标参数；不合法直接抛错，绝不放行 */
function normalizeTarget(action, target) {
  const t = target || {};
  const out = {
    tsukkomiId: String(t.tsukkomiId || ''),
    readerId: String(t.readerId || ''),
    bookId: String(t.bookId || ''),
    chapterId: String(t.chapterId || '0') || '0',
  };
  if (!/^\d+$/.test(out.bookId)) throw new Error('作品编号不合法，已中止');
  if (!/^\d+$/.test(out.chapterId)) out.chapterId = '0';
  if (action === 'delete' && !/^\d{3,}$/.test(out.tsukkomiId)) {
    throw new Error('间贴编号不合法，已中止');
  }
  if (action === 'mute') {
    if (!/^\d{2,}$/.test(out.readerId)) throw new Error('读者编号不合法，已中止');
    if (!/^\d+$/.test(out.tsukkomiId || '0')) out.tsukkomiId = '0';
  }
  return out;
}

function platformPage() {
  if (!browserView || browserView.webContents.isDestroyed()) {
    throw new Error('平台页面尚未加载，请先打开作者后台');
  }
  const wc = browserView.webContents;
  const url = wc.getURL();
  if (!url) throw new Error('平台页面尚未加载，请先打开作者后台');
  if (isLoginUrl(url)) throw new Error('登录态已失效，请重新登录作者后台后再执行');
  return wc;
}

/** 给界面的请求预览：说明这条动作会发到哪个地址 */
function describeRequest(action, t) {
  if (action === 'delete') {
    return `POST /review_manage/delete_tsukkomi?book_id=${t.bookId}&page=1&chapter_id=${t.chapterId}`
      + `\n  body: tsukkomi_id[]=${t.tsukkomiId}`;
  }
  return `GET /review_manage/speak_tsukkomi?speak=${t.readerId}`
    + `&tsukkomi_id=${t.tsukkomiId}&book_id=${t.bookId}&page=1&set_value=0&chapter_id=${t.chapterId}`;
}

ipcMain.handle('exec:run', async (_e, req) => {
  const r = req || {};
  const action = String(r.action || '');
  const fnName = EXEC_ACTIONS[action];
  if (!fnName) throw new Error('不支持的动作：' + action);

  const target = normalizeTarget(action, r.target);

  if (r.dryRun) {
    return {
      dryRun: true,
      ok: true,
      action,
      target,
      request: describeRequest(action, target),
    };
  }

  const wc = platformPage();
  const res = await wc.executeJavaScript(adapter.pageSource(fnName, target), true);

  appendActionLog({
    at: new Date().toISOString(),
    action,
    target,
    ok: !!(res && res.ok),
    status: (res && res.status) || 0,
    note: (res && (res.note || res.error)) || '',
    title: String(r.title || ''),
    content: String(r.content || '').slice(0, 200),
  });

  return res || { ok: false, error: '平台没有返回结果' };
});

ipcMain.handle('exec:verify', async (_e, req) => {
  const r = req || {};
  const action = String(r.action || '');
  const fnName = VERIFY_ACTIONS[action];
  if (!fnName) throw new Error('不支持的动作：' + action);
  const target = normalizeTarget(action, r.target);
  const wc = platformPage();
  const res = await wc.executeJavaScript(adapter.pageSource(fnName, target), true);
  return res || { ok: false };
});

ipcMain.handle('exec:log', () => readActionsLog());

// ---------------------------------------------------------------- 密码本
//
// 凭据只在主进程解密，并直接注入到平台登录页；渲染进程永远拿不到密码。

function vaultPage() {
  if (!browserView || browserView.webContents.isDestroyed()) {
    throw new Error('作者后台页面尚未打开');
  }
  return browserView.webContents;
}

ipcMain.handle('vault:status', () => ({
  available: vault.available(),
  file: vault.vaultFile(),
  items: vault.list(),
}));

/** 把登录页当前输入的内容存下来：密码由页面直接交给主进程，界面不接触 */
ipcMain.handle('vault:capture', async () => {
  const wc = vaultPage();
  if (!isAuthorLoginUrl(wc.getURL())) {
    throw new Error('当前不在作者后台登录页，已取消保存');
  }
  const got = await wc.executeJavaScript(adapter.pageSource('readLoginForm'), true);
  if (!got || !got.username || !got.password) {
    throw new Error('登录框里还没有内容——先在页面里把账号和密码填好，再点保存');
  }
  const item = vault.save({
    mode: got.mode,
    username: got.username,
    password: got.password,
    label: got.username,
  });
  return { item, items: vault.list() };
});

/** 填入：解密只发生在主进程，密码不进渲染进程 */
ipcMain.handle('vault:fill', async (_e, id) => {
  const wc = vaultPage();
  if (!isAuthorLoginUrl(wc.getURL())) {
    throw new Error('当前不在作者后台登录页，已取消填入');
  }
  const cred = vault.reveal(id);
  if (!cred) throw new Error('这条记录不存在，可能已被删除');

  const res = await wc.executeJavaScript(adapter.pageSource('fillLoginForm', {
    mode: cred.mode,
    username: cred.username,
    password: cred.password,
  }), true);
  if (res && res.ok) vault.markUsed(id);
  return res || { ok: false };
});

ipcMain.handle('vault:remove', (_e, id) => ({ ok: vault.remove(String(id)), items: vault.list() }));

/**
 * 导出 TXT：弹保存对话框后写盘。
 * 统一加 UTF-8 BOM —— Windows 记事本与不少国产编辑器对无 BOM 的 UTF-8
 * 仍会按 GBK 猜，中文会变乱码。
 */
ipcMain.handle('file:save-text', async (_e, opts) => {
  const o = opts || {};
  const name = String(o.defaultName || '导出.txt');
  const dir = String(o.defaultDir || '');

  let defaultPath = path.join(app.getPath('documents'), name);
  if (dir) {
    try {
      if (fs.statSync(dir).isDirectory()) defaultPath = path.join(dir, name);
    } catch (_) { /* 目录已不存在就用系统默认 */ }
  }

  const res = await dialog.showSaveDialog(win || undefined, {
    title: o.title || '导出为 TXT',
    defaultPath,
    filters: [
      { name: '文本文件', extensions: ['txt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });

  if (res.canceled || !res.filePath) return { canceled: true };

  const body = '\ufeff' + String(o.content || '');
  fs.writeFileSync(res.filePath, body, 'utf8');
  return {
    canceled: false,
    filePath: res.filePath,
    dir: path.dirname(res.filePath),
    bytes: fs.statSync(res.filePath).size,
  };
});

/**
 * 抓取平台公开榜单页。
 * rank-index 是未登录可访问的静态页，因此走主进程网络栈即可，
 * 不占用内嵌浏览器的视图，也不会打断用户正在看的后台页面。
 */
ipcMain.handle('rank:fetch', async () => {
  const url = 'https://www.ciweimao.com/rank-index';
  const res = await net.fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`榜单页返回 ${res.status}`);
  return await res.text();
});

// ------------------------------------------------------------ 敏感词库

/**
 * 发布校验时站点报出来的词的本地记录。
 *
 * 只做存取，不做判断：要不要收、收哪些由渲染层决定（见 publish.js）。
 * 所有写盘异常都在 badwordlib 里被吞掉，这里的 IPC 不会因为磁盘问题抛给界面。
 */
ipcMain.handle('badword:list', () => badwordlib.list(dataDir()));
ipcMain.handle('badword:add', (_e, words) => badwordlib.addMany(dataDir(), words));
ipcMain.handle('badword:stats', () => badwordlib.stats(dataDir()));
ipcMain.handle('badword:remove', (_e, w) => badwordlib.remove(dataDir(), w));
ipcMain.handle('badword:clear', () => badwordlib.clear(dataDir()));
ipcMain.handle('badword:dir', () => badwordlib.dir(dataDir()));

// ---------------------------------------------------------------- updater


/**
 * 自动更新。
 *
 * 分工：判定逻辑全在 updater.js（纯 Node，可测）；这里只管三件事 ——
 * 读写 ui-prefs 里的 skippedVersions、调度下载/解压、在合适的时机退出自己。
 *
 * 安全边界：下载地址、哈希、版本号一律以重新拉取的清单为准，
 * 不采信渲染进程传上来的任何字段，避免界面被注入后能指定任意 URL。
 */

/** 本次启动需要告知用户的一次性消息（回滚提示等），渲染进程起来后来领 */
let updateNotice = null;
/** 最近一次 check 的清单，下载时复用，避免连点两次打两遍网络 */
let cachedManifest = null;
/** 正在下载时挡住重复请求 */
let downloading = false;

/**
 * 清单地址。环境变量优先，方便本地对着一个手工改过的清单演练整个流程，
 * 不必真的发一个版本出来。
 */
// Contents API 的 raw 响应优先：它直接读取 main 当前内容；raw.githubusercontent.com
// 保留为兜底。两条请求都会由 updater 加 no-cache 头和唯一查询参数。
const MANIFEST_URLS = [
  process.env.CW_UPDATE_MANIFEST_URL,
  updater.DEFAULT_MANIFEST_API_URL,
  updater.DEFAULT_MANIFEST_URL,
].filter(Boolean);

function prefsPath() { return path.join(dataDir(), 'ui-prefs.json'); }

function readPrefsFile() {
  try {
    const v = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch (_) {
    return {};
  }
}

function writePrefsFile(prefs) {
  try {
    fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2), 'utf8');
  } catch (_) { /* 偏好写不进去不影响主流程 */ }
}

function skippedList() {
  const p = readPrefsFile();
  return Array.isArray(p.skippedVersions) ? p.skippedVersions : [];
}

/**
 * 启动自检：处理上一次升级留下的痕迹。
 *
 * 三种情况必须分清楚，否则用户会遇到「更新完还是旧版」或「每次启动都提示」：
 * 1. state.to === 当前版本 → 新版本起来了，写 ok 标记给 cmd、删备份、清状态
 * 2. state.from === 当前版本 → 新版本没起来，cmd 已经回滚，提示一次
 * 3. 版本对不上 → 清掉，避免状态永远卡住
 */
function recoverUpdateState() {
  const dir = dataDir();
  const version = app.getVersion();
  const st = updater.readState(dir);

  /*
   * 清掉上一次更新留下的下载包和解压目录。
   * 每个版本约占 3 MB（1.2 MB 的包 + 1.7 MB 的解压结果），
   * 不清的话会一直堆在 %TEMP% 里，一年下来很可观。
   * 唯独「已下载、等用户点重启」的那一份必须留下，否则点稍后重启还得重下。
   */
  const keepDir = st && st.stage === 'ready' ? String(st.to || '') : '';
  try {
    const root = updater.tempRoot();
    for (const name of fs.readdirSync(root)) {
      if (name === keepDir) continue;
      if (/^\d+\.\d+\.\d+$/.test(name) || name.endsWith('.vbs') || name.endsWith('.cmd')) {
        try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  } catch (_) { /* 临时目录不存在或清不掉，都不影响升级 */ }

  // 能走到这里说明更新脚本要么没跑起来、要么已经结束。锁一律清掉，
  // 否则残留的锁会让下一次更新被误判成「脚本正在运行」而不启动。
  try { fs.rmSync(path.join(updater.tempRoot(), 'run-update.lock'), { force: true }); } catch (_) { /* ignore */ }

  const failed = updater.readFailed(dir);
  if (failed && failed.to) {
    updateNotice = {
      kind: 'rolled-back',
      to: String(failed.to || ''),
      at: String(failed.at || ''),
      reason: String(failed.reason || '启动失败'),
    };
    updater.clearFailed(dir);
  }

  if (!st || st.stage !== 'installing') return;

  if (st.to === version) {
    // 新版本已经跑起来了：先落 ok 标记（cmd 靠它判断成功），再清状态与备份
    try { fs.writeFileSync(updater.okFlagPath(dir), version, 'utf8'); } catch (_) { /* ignore */ }
    updateNotice = {
      kind: 'updated',
      from: String(st.from || ''),
      to: String(version),
      at: String(st.at || ''),
    };
    updater.clearState(dir);
    if (st.bakPath) {
      try { fs.rmSync(st.bakPath, { recursive: true, force: true }); } catch (_) { /* 删不掉就留着 */ }
    }
    return;
  }

  if (st.from === version) {
    if (!updateNotice) {
      updateNotice = {
        kind: 'rolled-back',
        to: st.to,
        at: st.at,
        reason: '启动失败',
      };
    }
    updater.clearState(dir);
    return;
  }

  updater.clearState(dir);
}

/** 拉清单并算出要不要提示；不落任何文件，纯只读 */
async function checkForUpdate() {
  const dir = dataDir();
  const current = app.getVersion();
  const manifest = await updater.fetchManifest(MANIFEST_URLS);
  cachedManifest = manifest;

  let cmp;
  try {
    cmp = updater.compareVersions(manifest.version, current);
  } catch (e) {
    throw new Error(`清单里的版本号读不懂：${manifest.version}`);
  }
  if (cmp <= 0) {
    return {
      available: false,
      current,
      version: manifest.version,
      changes: Array.isArray(manifest.changes) ? manifest.changes : [],
      releasesPage: manifest.releasesPage,
    };
  }

  const skipped = skippedList();
  const changes = updater.pickChanges(current, manifest.version, manifest.changes);

  // 目标版本高于已跳过的记录时顺手清理，别让数组越攒越长
  const pruned = updater.pruneSkipped(manifest.version, skipped);
  if (pruned.length !== skipped.length) {
    const prefs = readPrefsFile();
    prefs.skippedVersions = pruned;
    writePrefsFile(prefs);
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:event', { type: 'skipped-pruned', skippedVersions: pruned });
    }
  }

  const st = updater.readState(dir);
  return {
    available: true,
    skipped: updater.isSkipped(manifest.version, skipped),
    current,
    version: manifest.version,
    type: manifest.type,
    size: manifest.size,
    sizeText: updater.humanSize(manifest.size),
    bundle: changes.bundle,
    fallback: changes.fallback,
    across: changes.across,
    releasesPage: manifest.releasesPage,
    readyToRestart: !!(st && st.stage === 'ready' && st.to === manifest.version),
  };
}

/** 下载并校验；失败一律回到干净状态，不留半截文件 */
async function downloadUpdate() {
  if (downloading) throw new Error('正在下载，请稍候再试');
  downloading = true;

  const dir = dataDir();
  const current = app.getVersion();
  try {
    const manifest = cachedManifest || await updater.fetchManifest(MANIFEST_URLS);
    cachedManifest = manifest;

    const workDir = path.join(updater.tempRoot(), manifest.version);
    const pkgFile = path.join(workDir, 'package.zip');

    updater.writeState(dir, {
      to: manifest.version,
      from: current,
      at: new Date().toISOString(),
      stage: 'downloading',
      bakPath: '',
      attempts: 0,
    });
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:event', { type: 'progress', phase: 'downloading' });
    }

    const got = await updater.downloadWithFallback(
      manifest.urls,
      pkgFile,
      manifest.sha256,
      (bytes) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('update:event', { type: 'progress', phase: 'downloading', bytes });
        }
      },
    );

    updater.writeState(dir, {
      to: manifest.version,
      from: current,
      at: new Date().toISOString(),
      stage: 'ready',
      bakPath: '',
      attempts: 0,
    });

    return {
      ok: true,
      stage: 'ready',
      version: manifest.version,
      bytes: got.bytes,
      sizeText: updater.humanSize(got.bytes),
      type: manifest.type,
    };
  } catch (e) {
    updater.clearState(dir);
    const detail = String(e.message || e);
    const kind = /校验不通过/.test(detail) ? 'verify' : (/HTTP|超时|ENOTFOUND|ECONN|fetch/i.test(detail) ? 'network' : 'unknown');
    return {
      ok: false,
      kind,
      detail,
      current: app.getVersion(),
      message: kind === 'verify'
        ? `下载不完整（校验不通过），当前版本 v${app.getVersion()} 可继续使用`
        : `没能下到更新包，当前版本 v${app.getVersion()} 可继续使用`,
    };
  } finally {
    downloading = false;
  }
}

/**
 * 执行替换：解压 → 写脚本 → 交棒给 cmd → 退出自己。
 *
 * 备份改名刻意放在脚本里做，而不是现在做：Windows 上正在运行的程序
 * 还持有 resources\app 的句柄，此刻改名大概率失败；等进程真正退出再 mv 才稳。
 */
async function installUpdate() {
  const dir = dataDir();
  const current = app.getVersion();
  const st = updater.readState(dir);
  if (!st || st.stage !== 'ready') {
    return { ok: false, message: `更新包还没准备好，当前版本 v${current} 可继续使用` };
  }

  const manifest = cachedManifest;
  const pkgFile = path.join(updater.tempRoot(), st.to, 'package.zip');
  if (!fs.existsSync(pkgFile)) {
    updater.clearState(dir);
    return { ok: false, message: `更新包已不在临时目录，当前版本 v${current} 可继续使用` };
  }

  // 完整包（含运行时）不自动替换：里面的目录结构和安装目录不同，
  // 硬套替换规则只会把程序目录搅乱，交给用户解压反而安全。
  if (manifest && manifest.type === 'full') {
    return {
      ok: true,
      manual: true,
      version: st.to,
      packagePath: pkgFile,
      sizeText: updater.humanSize(fs.statSync(pkgFile).size),
      message: `完整包已下载到临时目录，解压后覆盖安装目录即可；当前版本 v${current} 可继续使用`,
    };
  }

  // app.getAppPath() 在打包后就是 <install>\resources\app，不要再 dirname 一层，
  // 否则会把整个 resources 目录当成应用代码目录备份走。
  const appPath = app.getAppPath();
  if (!/[\\/]resources[\\/]app$/i.test(appPath)) {
    return {
      ok: false,
      message: `当前不是打包后的运行形态，自动替换不可用；当前版本 v${current} 可继续使用`,
    };
  }
  const appDir = appPath;
  const bakDir = path.join(path.dirname(appDir), `app.bak-${current}`);
  const newDir = path.join(updater.tempRoot(), st.to, 'new');

  try {
    await updater.extractZip(pkgFile, newDir);
  } catch (e) {
    return { ok: false, message: `解压更新包失败，当前版本 v${current} 可继续使用（${e.message}）` };
  }

  updater.writeState(dir, {
    to: st.to,
    from: current,
    at: new Date().toISOString(),
    stage: 'installing',
    bakPath: bakDir,
    attempts: 0,
  });

  const cmdText = updater.buildUpdateCommand({
    pid: process.pid,
    appDir,
    newDir,
    bakDir,
    exePath: process.execPath,
    args: process.argv.slice(1).map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' '),
    dataDir: dir,
    to: st.to,
    waitSeconds: 15,
  });

  const cmdPath = path.join(updater.tempRoot(), 'run-update.cmd');
  fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
  fs.writeFileSync(cmdPath, cmdText, 'utf8');

  // 防重复：连点「立即重启」或上一次脚本没跑完时，不再堆出第二个窗口
  const lockPath = path.join(updater.tempRoot(), 'run-update.lock');
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age < 60000) {
      return { ok: false, message: '更新脚本已在运行，稍等一下；当前版本可以继续使用' };
    }
  } catch (_) { /* 没有锁文件是正常情况 */ }
  try { fs.writeFileSync(lockPath, String(process.pid), 'utf8'); } catch (_) { /* ignore */ }

  /*
   * 用 wscript 转一层，而不是直接 spawn cmd.exe。
   * 直接 spawn 时 Node 在 detached 模式下用的是 DETACHED_PROCESS，
   * cmd.exe 作为控制台程序会给自己建一个窗口 —— windowsHide 拦不住，
   * 用户就会看到那个一直闪的 findstr 黑窗口。
   * WScript.Shell.Run 的第二个参数 0 就是「不显示窗口」，最稳。
   */
  const vbsPath = path.join(updater.tempRoot(), 'run-update.vbs');
  fs.writeFileSync(
    vbsPath,
    [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "cmd /c " & Chr(34) & "${cmdPath.replace(/"/g, '""')}" & Chr(34), 0, False`,
      '',
    ].join('\r\n'),
    'utf8',
  );

  spawn('wscript.exe', [vbsPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(vbsPath),
  }).unref();

  // 用 exit 而不是 quit：脚本正在等这个进程消失，quit 还要走一遍关闭流程，
  // 万一某个窗口拦一下就变成「脚本一直等、窗口一直闪」。
  setTimeout(() => {
    app.exit(0);
  }, 600);

  return { ok: true, restarting: true, version: st.to, type: manifest ? manifest.type : 'app' };
}

ipcMain.handle('update:notice', async () => {
  const n = updateNotice;
  updateNotice = null;
  if (n && n.kind === 'updated') {
    try {
      const manifest = await updater.fetchManifest(MANIFEST_URLS);
      const changes = updater.pickChanges(n.from, n.to, manifest.changes);
      return {
        ...n,
        bundle: changes.bundle,
        fallback: changes.fallback,
        across: changes.across,
        releasesPage: manifest.releasesPage,
      };
    } catch (_) {
      // 更新已经完成，清单暂时不可用时仍要显示独立的完成页。
      return { ...n, bundle: [], fallback: true, across: 0 };
    }
  }
  return n;
});

ipcMain.handle('update:check', () => checkForUpdate());

ipcMain.handle('update:download', () => downloadUpdate());

ipcMain.handle('update:install', () => installUpdate());

ipcMain.handle('update:skip', (_e, version) => {
  const v = String(version || '').trim();
  if (!updater.parseVersion(v)) return { ok: false };
  const prefs = readPrefsFile();
  const list = Array.isArray(prefs.skippedVersions) ? prefs.skippedVersions : [];
  if (!list.includes(v)) list.push(v);
  // 只保留不低于当前目标的记录，避免历史越攒越多
  prefs.skippedVersions = updater.pruneSkipped(v, list).concat(
    updater.isSkipped(v, list) ? [v] : [],
  );
  writePrefsFile(prefs);
  return { ok: true, skippedVersions: prefs.skippedVersions };
});

ipcMain.handle('update:open-releases', async (_e, url) => {
  const target = /^https:\/\/github\.com\//i.test(String(url || ''))
    ? String(url)
    : updater.RELEASES_PAGE;
  await shell.openExternal(target);
  return { ok: true };
});

// ---------------------------------------------------------------- lifecycle

// 单实例锁：多开会争抢同一份 userData 缓存与登录态分区，导致缓存损坏
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // 第二实例必须立即结束：app.quit() 会排队等到 ready 之后才真正退出，
  // 期间进程挂起不销毁，用户反复双击就会堆出一串空壳进程占内存。
  // 此处尚未创建窗口、未启动服务，直接 exit 不会有任何清理遗漏。
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // Windows 任务栏图标与分组归属，需与快捷方式一致，否则会回落到 electron.exe 的图标
    app.setAppUserModelId('com.ciweimao.author.tool');
    // 升级自检要尽早做：run-update.cmd 正在等新版本写 ok 标记，超过 15 秒它就会回滚
    try { recoverUpdateState(); } catch (_) { /* 自检失败不阻断启动 */ }
    await ensureInitialStorageChoice();
    plugins.installBundled(dataDir(), path.join(app.getAppPath(), 'bundled-plugins'));
    createWindow();
    // 托盘常驻：关闭窗口只是收起来，靠右下角图标再打开或退出
    createTray();

    // 上次退出时若开着 AI 接入，这里直接恢复；否则保持关闭（默认不监听任何端口）
    try {
      const p = path.join(dataDir(), 'ui-prefs.json');
      const pref = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pref && pref.aiEnabled) {
        aiApi.start().catch((err) => {
          console.error('AI 接口启动失败：', err && err.message);
        });
      }
    } catch (_) { /* 没有偏好文件就是没开过 */ }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    // 这段清理只跑一次。判断不能复用 quitting：close 拦截里选了「直接退出」
    // 会先把 quitting 置位，用同一个标志会让清理整段被跳过。
    if (beforeQuitDone) return;
    beforeQuitDone = true;
    quitting = true;

    // 端口不留在后台：进程要退了就把监听销毁
    try { aiApi.stop(); } catch (_) { /* ignore */ }

    // 兜底收尾：把还挂着的窗口全部销毁。侧栏/喵语平时是 hide() 的，
    // 不主动销毁的话它们会拖着渲染进程一起留在后台。
    BrowserWindow.getAllWindows().forEach((w) => {
      try { if (!w.isDestroyed()) w.destroy(); } catch (_) { /* ignore */ }
    });

    // 再兜一层：某些异步句柄（HTTP 连接、文件句柄）会让退出卡住，
    // 2 秒还没走干净就强制结束，别让用户看到「关了但进程还在」。
    if (!quitFallback) {
      quitFallback = setTimeout(() => {
        quitFallback = null;
        app.exit(0);
      }, 2000);
    }
  });

  app.on('will-quit', () => {
    if (quitFallback) {
      clearTimeout(quitFallback);
      quitFallback = null;
    }
  });

  app.on('window-all-closed', () => {
    // 常驻托盘时不能因为「窗口都关了」就退出：用户可能只是把界面收起来了。
    // 真正退出走托盘菜单的「退出」，那条路径会把 quitting 置位。
    if (quitting && process.platform !== 'darwin') app.quit();
  });
}
