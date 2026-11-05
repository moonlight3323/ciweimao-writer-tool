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
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, net, dialog, nativeTheme } = require('electron');
const vault = require('./vault');
const miaoyu = require('./miaoyu');
const pubside = require('./pubside');
const aiApiModule = require('./api');
const library = require('./library');
const plugins = require('./plugins');
const aiexportModule = require('./aiexport');
const adapter = require('../adapters/ciweimao');

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

  win.on('closed', () => {
    if (browserView) {
      try { browserView.webContents.close(); } catch (_) { /* ignore */ }
      browserView = null;
    }
    pubSideApi.destroy();
    miaoyuApi.destroy();
    win = null;
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
ipcMain.handle('writer:save', (_e, book) => library.saveBook(dataDir(), book));
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

// ---------------------------------------------------------------- lifecycle

// 单实例锁：多开会争抢同一份 userData 缓存与登录态分区，导致缓存损坏
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
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
    await ensureInitialStorageChoice();
    plugins.installBundled(dataDir(), path.join(app.getAppPath(), 'bundled-plugins'));
    createWindow();

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
    // 端口不留在后台：进程要退了就把监听销毁
    try { aiApi.stop(); } catch (_) { /* ignore */ }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
