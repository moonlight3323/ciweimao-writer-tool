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
// 摸鱼码字（透明浮层）。与 miaoyu（喵语数据站）不是一回事，两个名字只差一个字母
const moyuWriter = require('./moyu-writer');
const pubside = require('./pubside');
const aiApiModule = require('./api');
const library = require('./library');
const plugins = require('./plugins');
const aiexportModule = require('./aiexport');
const updater = require('./updater');
const closeBehavior = require('./closebehavior');
const badwordlib = require('./badwordlib');
const datamanager = require('./datamanager');
// 优先级规则放在渲染层目录里（那边要直接用），这里 require 进来复用同一份逻辑，
// 避免主进程和界面各写一套判断 —— 两套一旦分叉，就会出现「界面点亮了、看板不认」。
const bookPriority = require('../renderer/book-priority');
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

/**
 * 托盘「显示主界面」/ 点托盘图标走的路径。
 *
 * 摸鱼浮层还开着就先收掉：两个界面同时在场，用户不知道哪边是准的。
 * 收的时候不带 restore，避免 showMainWindow 再被反向调一次。
 */
async function bringBackMain() {
  try {
    await moyuWriter.closeSession({ restore: false });
  } catch (_) { /* 浮层收不掉也必须把主窗口叫回来 */ }
  showMainWindow();
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
    { label: '显示主界面', click: () => { bringBackMain(); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { bringBackMain(); });
  tray.on('double-click', () => { bringBackMain(); });
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
    if (pref && pref.pluginTheme) {
      const owner = plugins.list(dataDir()).find(item => item.enabled && !item.invalid
        && item.id === pref.pluginTheme.pluginId);
      const recipe = owner && owner.contributes.themes.find(item => item.id === pref.pluginTheme.themeId);
      if (recipe) return recipe.variables['--bg']
        || (recipe.base === 'dark' ? BG_DARK : (recipe.base === 'pink' ? '#fff4f8' : BG_LIGHT));
    }
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
      // 摸鱼码字打开时主窗口是 hide() 的，默认的后台节流会把 900ms 的自动保存
      // 拖到 1s 以上；正文还在浮层里实时推，保存节奏不该跟着变慢。
      backgroundThrottling: false,
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
 * 在平台页面执行脚本，带硬超时。
 *
 * 页面正在跳转时 executeJavaScript 可能永远不 resolve：旧文档已经销毁、
 * 新文档还没就绪，请求就那么挂着。所有执行入口都必须走这里，
 * 否则一次挂住就会让按钮永远转圈（发布轮询还会被 pollBusy 闸门卡死）。
 */
function runPageScript(wc, code, timeoutMs) {
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000;
  let timer = null;
  return Promise.race([
    wc.executeJavaScript(code, true),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('页面响应超时（可能正在跳转）')), limit);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 这是所有数据抓取的统一入口：脚本运行在 author.ciweimao.com 源下，
 * 因此自带登录 cookie，可直接 fetch 同源接口或读取 DOM。
 */
ipcMain.handle('browser:eval', async (_e, code, timeoutMs) => {
  const view = ensureBrowserView();
  const wc = view.webContents;
  if (!wc.getURL()) {
    throw new Error('平台页面尚未加载，请先打开作者后台');
  }
  return runPageScript(wc, code, timeoutMs);
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

// ---------------------------------------------------------------- 摸鱼码字（透明浮层）
//
// 窗口与全局快捷键都在 moyu-writer 里，这里只做转发：
// 主界面点按钮 → 打开；浮层里打字 / 藏起来 / 回到软件 → 回推或收尾。
ipcMain.handle('moyu:open', (_e, payload) => moyuWriter.open(payload));
ipcMain.handle('moyu:close', () => moyuWriter.closeSession({ restore: false }));
ipcMain.handle('moyu:state', () => moyuWriter.state());
// 浮层窗口用 send 而不是 invoke：每 120ms 一次，没必要等回执
ipcMain.on('moyu:input', (_e, text) => moyuWriter.forwardText(text));
ipcMain.on('moyu:hide', () => moyuWriter.hideOverlay());
ipcMain.on('moyu:restore', () => {
  // 这是 on 通道，没人接 rejection；浮层销毁失败时至少留下原因，
  // 并且和 bringBackMain 一样不让异常冒到主进程。
  Promise.resolve(moyuWriter.closeSession({ restore: true })).catch((err) => {
    console.error('摸鱼浮层恢复失败：', err && err.message);
    showMainWindow();
  });
});
ipcMain.on('moyu:settings', (_e, patch) => moyuWriter.applySettings(patch));
// 拖把手：浮层只报「按下 / 松开」，位移由 moyu-writer 跟着系统光标算
ipcMain.on('moyu:drag-start', () => moyuWriter.startDrag());
ipcMain.on('moyu:drag-end', () => moyuWriter.endDrag());

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

/**
 * 退出前的同步保存。
 *
 * 码字台自动保存是 900ms 防抖，退出时主进程会直接销毁窗口，
 * 渲染层的定时器和未完成的异步 IPC 都来不及跑 —— 最后敲的字就丢了。
 * 渲染层在 beforeunload 里用 sendSync 调这里，主进程同步写盘后再放行关闭。
 * 这本书的上限在 library.saveBook 里统一校验。
 */
ipcMain.on('app:flush-sync', (event, book) => {
  try {
    if (!book || typeof book !== 'object') throw new Error('没有可保存的数据');
    library.saveBook(dataDir(), book);
    event.returnValue = true;
  } catch (err) {
    console.error('退出前保存失败：', err && err.message);
    event.returnValue = false;
  }
});
ipcMain.handle('writer:covers', (_e, list) => library.updateCovers(dataDir(), list));
/**
 * 设置 / 取消优先级。
 *
 * 返回里带上**写入之后的完整书目**：渲染层拿到就能直接重画，
 * 不必再发一次 `writer:list` 去读。少一次往返，也就没有
 * 「pin 已成功、界面还显示 0 本」这种读了旧数据的空档。
 */
ipcMain.handle('writer:pin', (_e, bookId, pinned) => {
  const result = library.setPinned(dataDir(), bookId, pinned);
  return { result, books: library.listBooks(dataDir()) };
});

/**
 * 只查「哪本是优先级作品」，不返回作品列表。
 *
 * 为什么要单独一个接口：数据看板默认要定位到优先级作品，但作品列表只在
 * 进入「创作中心」时才加载。用户开机后直接点「数据看板」，渲染层手里没有书目，
 * 就不知道哪一本是优先级，于是看板「维持原样」——这正是本次要修的问题。
 * 这个接口只读 index.json，很轻，所以可以在启动时先取一次。
 *
 * 排序规则复用 book-priority.js（渲染层那份），保证两边判断完全一致。
 */
ipcMain.handle('writer:priority', () => {
  const books = library.listBooks(dataDir());
  // 内置功能：远程书没有平台书号，看板里对不上号，不能用来定位
  const hit = bookPriority.pickPriority(books, { requirePlatform: true });
  if (!hit) return null;
  return {
    bookId: String(hit.bookId || ''),
    platformBookId: String(hit.platformBookId || ''),
    name: String(hit.name || ''),
    pinnedAt: Number(hit.pinnedAt) || 0,
  };
});
ipcMain.handle('writer:delete', (_e, bookId) => ({ deleted: library.deleteBook(dataDir(), bookId) }));

/**
 * 读取文本文件并自动识别编码。
 *
 * 以前固定按 UTF-8 读：GBK/ANSI 的 txt 会被解码成一串 U+FFFD，而且不可逆，
 * 保存入库后整本正文就废了。中文网文作者手里的 txt 有大量是 GBK 编码，
 * 所以这里先用严格 UTF-8 试解，失败再回退 GBK（Electron 自带完整 ICU）。
 */
function readTextFileAuto(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.slice(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.slice(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    try { return new TextDecoder('gbk').decode(buf); }
    catch (_e) { return buf.toString('utf8'); }
  }
}

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
    const parsed = importedTextToBook(file, readTextFileAuto(file));
    const saved = library.saveBook(dataDir(), { ...parsed, source: 'import' });
    return { ok: true, book: saved.book };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ---- 功能中心：内置功能与自装扩展都只读入沙箱页面，通过白名单 API 与应用通信 ----

ipcMain.handle('plugins:list', () => ({ plugins: plugins.list(dataDir()) }));
ipcMain.handle('plugins:theme-configure', (_e, id, themeId, options) => plugins.configureTheme(dataDir(), id, themeId, options));
/**
 * 补装/修复内置功能。
 *
 * 「重新加载」按钮走这里。内置功能没有单独的重装入口，
 * 一旦 plugins 目录被清掉或写坏，用户就只能重装整个软件 ——
 * 有了这个接口，点一下「重新加载」就能自己修回来。
 */
ipcMain.handle('plugins:repair', () => {
  const installed = plugins.installBundled(dataDir(), path.join(app.getAppPath(), 'bundled-plugins'));
  return { installed, plugins: plugins.list(dataDir()) };
});
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
 * 主题切换时同步窗口原生底色。
 *
 * BrowserWindow 的 backgroundColor 是创建时定死的（bootBackground()）。
 * 运行时换主题如果只改渲染层，重绘空档或窗口边缘可能露出上一套底色，
 * 看起来像闪了一下。这里只接受 #rgb/#rrggbb/#rrggbbaa。
 */
ipcMain.handle('window:set-background', (_e, color) => {
  const value = String(color || '').trim();
  if (!/^#[0-9a-f]{3,8}$/i.test(value)) return false;
  if (win && !win.isDestroyed()) {
    try { win.setBackgroundColor(value); } catch (_) { return false; }
  }
  return true;
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
  const target = storageConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  /*
   * 自愈：v1.1.0 的「恢复数据」会把这个配置文件误建成一个同名目录。
   * 不先清掉的话，writeFileSync 会抛 EISDIR —— 而这里发生在启动流程里，
   * 会直接让窗口永远建不出来（用户看到的是进程活着、没有界面）。
   * 该目录里只可能有那次错误恢复留下的副本，删掉是正确的。
   */
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  } catch (_) { /* 删不掉就让下面的写入自己报错 */ }
  fs.writeFileSync(target, JSON.stringify(config, null, 2), 'utf8');
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

// ---------------------------------------------------------------- 版本变化
//
// 手动下载完整包覆盖安装时，问一句「要不要接着用旧数据」；
// 软件自己提示并安装的更新直接跳过——数据本来就该接着用，不必打断用户。
// 判定在启动时做一次（evaluateVersionChange），记录上次版本后就不再重复问。

/**
 * 启动时算一次「这次版本是怎么变的」，并把当前版本写回偏好。
 *
 * 必须写回：否则每次启动都会重新判定成「手动安装」，变成天天弹窗。
 */
function evaluateVersionChange() {
  const prefs = readPrefsFile();
  const last = String(prefs.lastRunVersion || '');
  const current = app.getVersion();

  versionChange = updater.decideVersionChange({
    current,
    last,
    autoInstalled: autoInstalledThisBoot,
  });

  // 首次运行也要记下来，否则第二次启动会被当成「从空版本升上来」
  if (last !== current) {
    prefs.lastRunVersion = current;
    prefs.lastRunAt = new Date().toISOString();
    writePrefsFile(prefs);
  }
}

/**
 * 渲染层来问「要不要继承旧数据」。
 * 只有 manual-update 才返回询问；其余一律 ask=false。
 */
ipcMain.handle('version:change', () => ({
  ...versionChange,
  ask: versionChange.kind === 'manual-update',
}));

/**
 * 用户选择「不继承，从空白开始」。
 * 先备份（datamanager 内部保证），再清空，由渲染层调 app:relaunch 重启。
 * 和「清除所有数据」走同一条路径：会话存储必须用 session API 清，
 * 直接删 Local Storage 目录会 EPERM。
 */
ipcMain.handle('version:reset-data', async () => {
  const result = await resetAllData({});
  return { ok: true, problem: resetProblemText(result), ...result };
});

// ---------------------------------------------------------------- 备份 / 清除 / 恢复
//
// 目的是让「完整跑一遍新用户流程」可逆：清干净 → 当新用户测 → 测完把真实数据放回来。
// 备份落在 %APPDATA%\刺猬猫作家助手-数据备份\（userData 的兄弟目录），清 userData 时不会被连带删。

function backupRoot() {
  return datamanager.backupRoot(app.getPath('appData'));
}

function currentTargets() {
  return datamanager.resetTargets({
    dataDir: dataDir(),
    userData: app.getPath('userData'),
  });
}

/**
 * 备份时只保留「用户真正在乎的东西」：数据目录、密码本、保存位置偏好。
 *
 * 登录态分区（Partitions）有几十上百 MB 的 Chromium 缓存，备份它既慢又没意义——
 * 恢复之后照样要重新登录，cookie 也未必还有效。
 */
function backupTargets() {
  return currentTargets().filter((t) => t.scope !== 'session');
}

/**
 * 清掉 Chromium 自己的存储（cookie / localStorage / IndexedDB / 缓存 …）。
 *
 * **必须走 session API，不能删目录。**
 * Local Storage / Network / Partitions 这些目录在运行期被 Chromium 用 LevelDB 打开着，
 * `fs.rmSync` 一定报 `EPERM: Permission denied`——旧版本就是这么让
 * 「清除所有数据」彻底不可用的（弹窗原文：无法删除 …\Local Storage: EPERM）。
 *
 * 覆盖三个会话：
 *   defaultSession   —— 主界面与插件沙箱（界面偏好等）
 *   persist:ciweimao —— 作者后台 WebContentsView，登录态在这里
 *   persist:miaoyu   —— 喵语数据 WebContentsView
 *
 * 全程不往外抛：某一个会话清不掉也不该拦住整轮清除和随后的重启。
 */
async function clearSessionData() {
  const names = [null, PARTITION, miaoyu.PARTITION];
  const failed = [];
  let cleared = 0;

  for (const name of names) {
    const label = name || 'default';
    let ses;
    try {
      ses = name ? session.fromPartition(name) : session.defaultSession;
    } catch (err) {
      failed.push({ name: label, message: err.message });
      continue;
    }
    try {
      // 不传 storages 表示清全部：cookies / localstorage / indexeddb /
      // cachestorage / serviceworkers / shadercache / websql
      await ses.clearStorageData();
      await ses.clearCache();
      // HTTP 认证缓存里的旧凭据也一并清掉
      if (typeof ses.clearAuthCache === 'function') await ses.clearAuthCache();
      // 紧接着就要 relaunch，必须先把清空结果刷到磁盘，不能停在内存里
      if (typeof ses.flushStorageData === 'function') ses.flushStorageData();
      cleared += 1;
    } catch (err) {
      failed.push({ name: label, message: err.message });
    }
  }
  return { cleared, failed };
}

/**
 * 执行一次「清除所有数据」：备份 → 删我们的文件 → 清 Chromium 存储。
 *
 * 三件事的顺序有意义：
 * 1. 先备份，失败就整体中止（宁可不清）
 * 2. 再删数据目录 / 密码本 / 保存位置偏好（这些是我们自己的文件，fs 删得掉）
 * 3. 最后清会话存储（走 session API）。放最后是因为它最不容易失败，
 *    而且清完 cookies 就再也读不到东西了，没必要放在数据之前
 */
async function resetAllData(opts) {
  const options = opts || {};
  const targets = currentTargets();
  const manifest = datamanager.createBackup(backupRoot(), backupTargets(), { reason: 'before-reset' });

  const fsResult = datamanager.reset(targets, {
    skip: options.keepSession ? ['session'] : [],
  });

  let sessionInfo = { cleared: 0, failed: [] };
  if (!options.keepSession) {
    sessionInfo = await clearSessionData();
  }

  return {
    backupName: manifest.name,
    backupSize: datamanager.humanSize(manifest.bytes),
    removedCount: fsResult.removed.length,
    failed: fsResult.failed,
    session: sessionInfo,
  };
}

/** 把 resetAllData 的结果翻译成给人看的结论；没有失败就返回空串 */
function resetProblemText(result) {
  const parts = [];
  if (result.failed.length) {
    const sample = result.failed.slice(0, 3).map((f) => f.path).join('、');
    parts.push(`有 ${result.failed.length} 个文件被占用没能删掉（${sample}），`
      + '通常是另一个窗口正在运行，关掉后重试即可');
  }
  if (result.session.failed.length) {
    parts.push('登录态清理未完全成功（'
      + result.session.failed.map((f) => f.name).join('、') + '）');
  }
  return parts.join('；');
}

ipcMain.handle('data:backups', () => ({
  root: backupRoot(),
  backups: datamanager.listBackups(backupRoot()).map((b) => ({
    name: b.name,
    createdAt: b.createdAt,
    files: b.files,
    bytes: b.bytes,
    sizeText: datamanager.humanSize(b.bytes),
    reason: b.reason || '',
  })),
}));

/** 只备份不清除：用户在「恢复数据」之前先手动留一份 */
ipcMain.handle('data:backup-now', () => {
  const manifest = datamanager.createBackup(backupRoot(), backupTargets(), { reason: 'manual' });
  return {
    ok: true,
    name: manifest.name,
    files: manifest.files,
    sizeText: datamanager.humanSize(manifest.bytes),
  };
});

/**
 * 清除所有数据。
 *
 * 顺序固定：先备份 → 备份成功才删。备份失败时抛错，前端会显示原因，
 * 绝不出现「清掉了但没备份」这种不可逆结果。
 */
ipcMain.handle('data:reset', async (_e, opts) => {
  const result = await resetAllData(opts || {});
  // 已经清掉的部分不会回来，所以「部分失败」不当成整体失败：
  // 把能清的清掉、把清不掉的如实说出来，然后照常重启。
  // 备份一定成功过（resetAllData 里先备份，失败会直接抛），所以随时能退回。
  const problem = resetProblemText(result);
  return {
    ok: !problem,
    problem,
    ...result,
  };
});

/**
 * 从备份恢复。
 * 恢复前会自动把当前状态再备份一次（reason=restore-pre），恢复错了也能退回。
 */
ipcMain.handle('data:restore', (_e, name) => {
  const target = String(name || '').trim();
  if (!target) throw new Error('没有指定要恢复的备份');
  if (target !== path.basename(target) || target === '.' || target === '..') {
    throw new Error('备份名称不合法');
  }
  // 传完整清单：restoreBackup 需要知道哪些目录是 Chromium 正在占用的会话目录，
  // 清空数据目录时要跳过它们。备份本身仍然只包含用户数据。
  const res = datamanager.restoreBackup(backupRoot(), target, currentTargets());
  return { ok: true, ...res };
});

/** 重启：数据被清空或恢复后必须重启，窗口里残留的内存状态才算真的回到初始 */
ipcMain.handle('app:relaunch', () => {
  // 先保证不会把退出拦成「最小化到托盘」
  quitting = true;
  app.relaunch();
  setTimeout(() => app.exit(0), 200);
  return { ok: true };
});

/**
 * 数据目录内的文件名。
 *
 * 只替换非法字符不够：`..` 不含非法字符，path.join 之后会跳出数据目录。
 * 这里先取 basename 再清洗，并显式拒绝 . / ..，与其它入口的校验标准保持一致。
 */
function safeDataName(name) {
  const raw = String(name == null ? '' : name).trim();
  const base = path.basename(raw).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!base || base === '.' || base === '..') throw new Error('文件名不合法');
  return base;
}

ipcMain.handle('data:read', async (_e, name) => {
  const f = path.join(dataDir(), safeDataName(name));
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return null;
  }
});

ipcMain.handle('data:write', async (_e, name, content) => {
  const f = path.join(dataDir(), safeDataName(name));
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
  try {
    const entries = readActionsLog();
    entries.push(entry);
    // 只留最近 500 条，避免文件无限膨胀
    const trimmed = entries.slice(-500);
    fs.writeFileSync(actionsLogPath(), JSON.stringify({ entries: trimmed }, null, 2), 'utf8');
    return trimmed.length;
  } catch (err) {
    // 动作已经在平台上执行成功了，日志写不进去不能把回执变成失败：
    // 渲染层会以为操作失败而重试，导致重复删除/禁言。
    console.error('动作日志写入失败：', err && err.message);
    return 0;
  }
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
  // 与 browser:eval 同一套超时保护：页面跳转期间 executeJavaScript 可能永不返回
  const res = await runPageScript(wc, adapter.pageSource(fnName, target), 20000);

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
  // 与 browser:eval 同一套超时保护：页面跳转期间 executeJavaScript 可能永不返回
  const res = await runPageScript(wc, adapter.pageSource(fnName, target), 20000);
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
  const got = await runPageScript(wc, adapter.pageSource('readLoginForm'), 15000);
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

  const res = await runPageScript(wc, adapter.pageSource('fillLoginForm', {
    mode: cred.mode,
    username: cred.username,
    password: cred.password,
  }), 15000);
  if (res && res.ok) vault.markUsed(id);
  return res || { ok: false };
});

ipcMain.handle('vault:remove', (_e, id) => ({ ok: vault.remove(String(id)), items: vault.list() }));

/** 打开登录页之前先看看「这个作者名有没有存过账号」，有就提示可一键填入 */
ipcMain.handle('vault:by-author', (_e, authorName) => ({ item: vault.findByAuthor(authorName) }));

/**
 * 从当前作者后台页面读作者名，并绑定到指定记录（不传则绑定最近用过的那条）。
 *
 * 为什么要主进程做：作者名只存在于平台页面里，渲染进程拿不到页面上下文；
 * 而且「最近用过哪条记录」也只有主进程知道。
 */
ipcMain.handle('vault:bind-author', async (_e, id) => {
  const wc = vaultPage();
  const authorName = await runPageScript(
    wc, adapter.pageSource('readAuthorName'), 10000,
  ).catch(() => '');
  const target = String(id || '') || vault.lastFilledId();
  if (!authorName) return { ok: false, reason: 'no-author-name', items: vault.list() };
  if (!target) return { ok: false, reason: 'no-record', authorName, items: vault.list() };
  const item = vault.bindAuthor(target, authorName);
  return { ok: !!item, authorName, item, items: vault.list() };
});

/** 手动标作者名：自动读取失败时的兜底，不依赖平台页面 */
ipcMain.handle('vault:set-author', (_e, id, authorName) => {
  const item = vault.bindAuthor(String(id), authorName);
  if (!item) throw new Error('记录不存在，或作者名为空');
  return { ok: true, item, items: vault.list() };
});

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
/**
 * 带超时的 fetch。
 *
 * `net.fetch` 本身**没有超时**：连接被中间设备吞掉、DNS 挂起、对方只握手不回包时，
 * Promise 会一直挂着。IPC 调用跟着永不返回，渲染层的 `finally` 也就永远不执行，
 * 按钮就卡死在「抓取中…」——用户只能重启软件。这是「点了刷新没反应」的直接原因。
 *
 * @param {number} timeoutMs 单次尝试的超时
 * @param {number} retries   失败/超时后再试几次（网络抖动很常见，一次就放弃太脆）
 */
async function fetchWithTimeout(url, options, timeoutMs, retries) {
  const limit = timeoutMs || 20000;
  const tries = Math.max(1, (retries || 0) + 1);
  let lastErr = null;

  for (let i = 0; i < tries; i += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), limit);
    try {
      return await net.fetch(url, { ...options, signal: ctrl.signal });
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /aborted|abort/i.test(String(err.message)));
      // AbortError 的原话是 "The operation was aborted"，对用户没有意义
      lastErr = aborted
        ? new Error(`请求超时（${Math.round(limit / 1000)} 秒无响应）`)
        : new Error(`网络请求失败：${(err && err.message) || err}`);
      // 还有下次就稍等再试，避免连续打同一个不通的地址
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 600));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('网络请求失败');
}

ipcMain.handle('rank:fetch', async () => {
  const url = 'https://www.ciweimao.com/rank-index';
  // 单次 12 秒、最多试 2 次：最坏 25 秒左右给出明确结论，
  // 比原来"永远等下去、界面卡死"好得多；正常 2 秒就回来，用户感知不到。
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  }, 12000, 1);
  if (!res.ok) throw new Error(`榜单页返回 HTTP ${res.status}，稍后再试`);
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
let versionChange = { kind: 'same-version', direction: 'same', from: '', to: '' };
/** 这次启动是否由更新器自己装上的（决定要不要问「是否继承旧数据」） */
let autoInstalledThisBoot = false;

function recoverUpdateState() {
  const dir = dataDir();
  const version = app.getVersion();
  const st = updater.readState(dir);

  if (st && st.stage === 'installing' && st.to === version) {
    // 更新助手仍在执行：先确认启动，不清理它正在读取的脚本、锁和备份。
    // 收尾由助手收到确认后统一完成，避免新进程删掉正在执行的 cmd。
    autoInstalledThisBoot = true;
    fs.writeFileSync(updater.okFlagPath(dir), version, 'utf8');
    updateNotice = {
      kind: 'updated', from: String(st.from || ''), to: String(version), at: String(st.at || ''),
    };
    return;
  }

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
      type: manifest.type,
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
      type: manifest.type,
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
    // 失败后把缓存的清单扔掉：清单里的下载地址是会变的（换镜像、换资产名）。
    // 不清的话用户点「重试」还是拿同一份旧清单跑同一个地址，
    // 除非手动重启软件，否则永远修不好 —— 这次用户装不上就是这么被卡住的。
    cachedManifest = null;

    const detail = String(e.message || e);
    const kind = /校验不通过/.test(detail) ? 'verify' : (/HTTP|超时|ENOTFOUND|ECONN|fetch/i.test(detail) ? 'network' : 'unknown');
    return {
      ok: false,
      kind,
      detail,
      current: app.getVersion(),
      // 把 detail 带进去：原来网络类失败只说「没能下到更新包」，
      // 用户既不知道是超时还是 404，也没法告诉我们，只能猜。
      message: kind === 'verify'
        ? `下载不完整（校验不通过），当前版本 v${app.getVersion()} 可继续使用`
        : `没能下到更新包（${shorten(detail)}），当前版本 v${app.getVersion()} 可继续使用`,
      hint: kind === 'network'
        ? '网络到 GitHub 的连接不通，可以点「重试」再试一次，或到设置里打开发布页手动下载。'
        : '',
    };
  } finally {
    downloading = false;
  }
}

/** 失败详情太长会撑破弹窗，截一下并去掉重复的地址前缀 */
function shorten(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

/**
 * 解压出来的目录是不是「完整包」（含运行程序）。
 *
 * app 包只包含 resources/app 里的代码；完整包里会有 exe 和运行时 DLL。
 * 旧版本的状态文件没有 type 字段，光靠 state 区分不出来，这里按内容再兜一层。
 */
function looksLikeFullPackage(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/\.exe$/i.test(name)) return true;
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isDirectory()
            && fs.readdirSync(p).some((n) => /\.exe$/i.test(n))) return true;
      } catch (_) { /* 读不到的目录跳过 */ }
    }
  } catch (_) { /* 目录不存在就按 app 包处理 */ }
  return false;
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

  // 包类型必须从 state 读：cachedManifest 是模块级变量，应用重启后就没了，
  // 而 stage=ready 的下载包会被 recoverUpdateState 特意保留。
  // 只认 cachedManifest 的话，「下载完整包 → 重启 → 点安装」会把完整包
  // 当成 app 包替换进 resources\app，安装目录直接被搅乱。
  const updateType = String(st.type || (cachedManifest && cachedManifest.type) || 'app');
  const pkgFile = path.join(updater.tempRoot(), st.to, 'package.zip');
  if (!fs.existsSync(pkgFile)) {
    updater.clearState(dir);
    return { ok: false, message: `更新包已不在临时目录，当前版本 v${current} 可继续使用` };
  }

  // 完整包（含运行时）不自动替换：里面的目录结构和安装目录不同，
  // 硬套替换规则只会把程序目录搅乱，交给用户解压反而安全。
  if (updateType === 'full') {
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

  // 旧状态没有 type 字段时的内容兜底：带 exe 的一定是完整包，绝不能
  // robocopy 进 resources\app（那会把安装目录搅乱）。
  if (updateType !== 'full' && looksLikeFullPackage(newDir)) {
    return {
      ok: true,
      manual: true,
      version: st.to,
      packagePath: pkgFile,
      sizeText: updater.humanSize(fs.statSync(pkgFile).size),
      message: `更新包里带着运行程序，判断为完整包，已改为手动安装：`
        + `解压后覆盖安装目录即可；当前版本 v${current} 可继续使用`,
    };
  }

  // 防重复：连点「立即重启」或上一次脚本没跑完时，不再堆出第二个窗口。
  // 必须放在 writeState 之前 —— 先写成 installing 再发现锁被占，
  // 函数返回失败但状态已经落盘，下次启动会误报「更新失败，已回滚」。
  const lockPath = path.join(updater.tempRoot(), 'run-update.lock');
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age < 60000) {
      return { ok: false, message: '更新脚本已在运行，稍等一下；当前版本可以继续使用' };
    }
  } catch (_) { /* 没有锁文件是正常情况 */ }
  try { fs.writeFileSync(lockPath, String(process.pid), 'utf8'); } catch (_) { /* ignore */ }

  updater.writeState(dir, {
    to: st.to,
    from: current,
    at: new Date().toISOString(),
    stage: 'installing',
    type: updateType,
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
    waitSeconds: 60,
  });

  const cmdPath = path.join(updater.tempRoot(), 'run-update.cmd');
  fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
  fs.writeFileSync(cmdPath, cmdText, 'utf8');

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

  return { ok: true, restarting: true, version: st.to, type: updateType };
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
    // 升级自检要尽早做：run-update.cmd 正在等待新版本确认启动。
    try { recoverUpdateState(); } catch (_) { /* 自检失败不阻断启动 */ }
    // 版本变化判定要排在 recoverUpdateState 之后：它依赖「是否自动安装」这个结论
    try { evaluateVersionChange(); } catch (_) { /* 判定失败就当作没换版本 */ }
    // 这一步会弹对话框、写配置文件，任何异常都不能阻断后面建窗口：
    // 之前没有兜住，配置路径一旦损坏（比如被旧版恢复成同名目录），
    // 进程会活着但永远没有界面，用户只能去任务管理器结束它。
    try {
      await ensureInitialStorageChoice();
    } catch (err) {
      console.error('选择数据保存位置失败，按默认位置继续：', err && err.message);
    }
    plugins.installBundled(dataDir(), path.join(app.getAppPath(), 'bundled-plugins'));
    createWindow();
    // 摸鱼码字：窗口句柄、偏好读写、「回到软件」的回调都从主进程注入。
    // 放在 createWindow 之后：getWindow 虽然是惰性的，但第一次 open 一定晚于这里。
    moyuWriter.updateDeps({
      getWindow: () => win,
      readPrefs: readPrefsFile,
      writePrefs: writePrefsFile,
      onRestore: () => showMainWindow(),
    });
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
    // 主窗口用 close() 而不是 destroy()：close 会触发渲染层的 beforeunload，
    // 码字台在那里用 sendSync 把最后不到 900ms 的输入同步写盘；destroy 会跳过。
    // 上面有 2 秒兜底，渲染层卡死也不会让进程退不掉。
    BrowserWindow.getAllWindows().forEach((w) => {
      try {
        if (w.isDestroyed()) return;
        if (w === win) w.close();
        else w.destroy();
      } catch (_) { /* ignore */ }
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
    // 全局快捷键必须还回去，否则进程退了系统里还占着那个组合键
    try { moyuWriter.dispose(); } catch (_) { /* 退出路径不抛错 */ }
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
