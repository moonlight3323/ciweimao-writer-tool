'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const HOST = $('#content');
const VIEW_TITLES = {
  overview: '概览',
  writer: '创作中心',
  'writing-stats': '码字统计',
  reviews: '评论审查',
  books: '数据看板',
  export: '章节导出',
  rank: '平台榜单',
  miaoyu: '喵语数据',
  sync: '抓取与同步',
  plugins: '插件中心',
  settings: '设置',
};

let browserOpen = false;
/** 进入平台页面之前停留的本地视图，退出后台时回到这里 */
let lastView = 'overview';
let lastState = { isLoginPage: true, url: '' };
let rafPending = false;

// ------------------------------------------------------------ 尺寸同步

function currentRect() {
  const r = HOST.getBoundingClientRect();
  // 登录页上方会显示密码本工具条，平台视图要让出这段高度，否则会盖住它
  const bar = document.getElementById('vaultBar');
  const off = (browserOpen && bar && !bar.hidden) ? bar.offsetHeight : 0;
  return { x: r.x, y: r.y + off, width: r.width, height: Math.max(1, r.height - off) };
}

/** 把平台视图的矩形与 #content 对齐（窗口变化、侧栏切换都会触发） */
function syncBounds() {
  if (!browserOpen) return;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!browserOpen) return;
    window.api.browser.setBounds(currentRect());
  });
}

new ResizeObserver(syncBounds).observe(HOST);
new ResizeObserver(syncMiaoyuBounds).observe(HOST);
window.addEventListener('resize', syncBounds);
window.addEventListener('resize', syncMiaoyuBounds);

// ------------------------------------------------------------ 视图切换

function setActiveNav(name, pluginId) {
  $$('.nav-item').forEach((button) => {
    const active = pluginId
      ? button.dataset.pluginNav === pluginId
      : button.dataset.view === name && !button.dataset.pluginNav;
    button.classList.toggle('is-active', active);
  });
}

function setActiveView(name) {
  lastView = name;
  setActiveNav(name, '');
  $$('.view').forEach((s) => s.classList.toggle('is-active', s.dataset.view === name));
  $('#pageTitle').textContent = VIEW_TITLES[name] || name;
  if (!browserOpen) $('#pageCrumb').textContent = '';
  // 上一页可能滚到了底部，切页面若不归零，新页面会从半截开始显示
  $('#content').scrollTop = 0;

  // 已登录时顺手把作品列表读出来，省掉一次手动点击
  if (name === 'export' && !exportBooks.length && !exportBusy
      && lastState.url && !lastState.isLoginPage) {
    loadExportBooks(true);
  }

  if (name === 'execute') {
    renderExecPool();
    refreshExecLog();
  }

  if (name === 'writer' && !writerEditorBook) loadWriterBooks();
  if (name === 'writing-stats') loadWritingStats().then(renderWritingStats);
  // “插件中心”和插件贡献的导航项共用同一个 view。切回插件中心时也必须
  // 先退出当前插件页面，否则 pluginHost 仍会盖在插件列表上。
  if (activePlugin) closePlugin();
  if (name === 'plugins') loadPlugins();

  // 喵语数据是内嵌站点，只有停在这一页时才把视图挂上去
  if (name === 'miaoyu') openMiaoyu();
  else if (miaoyuOpen) closeMiaoyu();

  document.dispatchEvent(new CustomEvent('view-changed', { detail: { name } }));
}

$('#nav').addEventListener('click', async (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  if (browserOpen) await closeBrowser();
  setActiveView(btn.dataset.view);
  if (btn.dataset.pluginNav) {
    await loadPlugins();
    await openPlugin(btn.dataset.pluginNav);
  }
});

document.addEventListener('click', async (e) => {
  const jump = e.target.closest('[data-jump]');
  if (!jump) return;
  setActiveView(jump.dataset.jump);
});

// ------------------------------------------------------------ 平台视图

function setBrowserChrome(open) {
  browserOpen = open;
  HOST.classList.toggle('is-browser', open);
  $('#btnOpenBrowser').hidden = open;
  ['#btnCloseBrowser', '#btnReload', '#btnBack', '#btnForward', '#btnHome', '#btnClearInboxTop'].forEach((sel) => {
    $(sel).hidden = !open;
  });
  if (!open) $('#vaultBar').hidden = true;

  // 浏览后台时标题跟着变成「作者后台」，退出后回到原来的页面，
  // 否则会出现「标题写着章节导出、实际在看后台」的错位感
  if (open) {
    $('#pageTitle').textContent = '作者后台';
    $$('.nav-item').forEach((b) => b.classList.remove('is-active'));
  } else {
    $('#pageTitle').textContent = VIEW_TITLES[lastView] || lastView;
    setActiveNav(lastView, activePlugin ? activePlugin.id : '');
  }
  syncBounds();
}

async function openBrowser(url) {
  if (miaoyuOpen) await closeMiaoyu();
  HOST.classList.add('is-browser');
  // 等一次布局，确保 padding:0 已生效再取矩形
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  setBrowserChrome(true);
  try {
    await window.api.browser.open(currentRect(), url);
  } catch (err) {
    console.error('打开平台页面失败', err);
    HOST.classList.remove('is-browser');
    setBrowserChrome(false);
  }
}

async function closeBrowser() {
  try { await window.api.browser.close(); } catch (_) { /* ignore */ }
  setBrowserChrome(false);
}

/** 重新挂载后台当前页面但不导航，避免冲掉已经填好的章节表单。 */
async function showBrowserKeepPage() {
  if (miaoyuOpen) await closeMiaoyu();
  HOST.classList.add('is-browser');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  setBrowserChrome(true);
  await window.api.browser.show(currentRect());
}

window.showBrowserKeepPage = showBrowserKeepPage;

$('#btnOpenBrowser').addEventListener('click', () => openBrowser());
$('#btnGoAuthor').addEventListener('click', () => openBrowser());
$('#btnCloseBrowser').addEventListener('click', () => closeBrowser());
$('#btnReload').addEventListener('click', () => window.api.browser.reload());
$('#btnBack').addEventListener('click', () => window.api.browser.back());
$('#btnForward').addEventListener('click', () => window.api.browser.forward());
$('#btnHome').addEventListener('click', () => window.api.browser.home());

// ------------------------------------------------------------ AI 接入
//
// 底座是「AI 素材包」（谁都能用），加速器是本机只读接口 + MCP 桥。
// 界面这边只做三件事：开关、把 token/配置给你、生成素材包。

let aiStatus = null;
let aiTokenShown = false;

function aiMsg(text, isErr) {
  const box = $('#aiMsg');
  if (!box) return;
  if (!text) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = text;
  box.classList.toggle('is-warn', !!isErr);
}

/** 复制文本：优先标准剪贴板，失败退回 execCommand */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

function aiConfigText(st) {
  if (!st || !st.config || !st.config.mcpServers) return '';
  return JSON.stringify({ mcpServers: st.config.mcpServers }, null, 2);
}

async function refreshAiPanel() {
  let st = null;
  try { st = await window.api.ai.status(); } catch (_) { st = null; }
  aiStatus = st;
  if (!st) return;

  const on = !!st.running;
  $('#aiToggle').checked = on;
  $('#aiStateTag').textContent = on ? '运行中 · 只读' : '已关闭';
  $('#aiStateTag').classList.toggle('is-live', on);
  $('#aiDetails').hidden = !on;

  if (on) {
    $('#aiUrl').textContent = st.url || '—';
    const t = st.token || '';
    $('#aiToken').textContent = aiTokenShown ? t : '•'.repeat(Math.min(28, t.length || 28));
    $('#aiConfigBox').textContent = aiConfigText(st);
  } else {
    $('#aiToken').textContent = '••••••••••••';
    $('#aiConfigBox').textContent = '打开上面的开关后，这里会显示可直接粘贴的配置。';
    aiTokenShown = false;
    $('#btnAiShowToken').textContent = '显示';
  }
}

$('#aiToggle').addEventListener('change', async (e) => {
  const want = e.target.checked;
  const box = $('#aiToggle');
  box.disabled = true;
  try {
    if (want) {
      const r = await window.api.ai.start();
      if (!r || r.ok === false) {
        aiMsg('启动失败：' + ((r && r.error) || '未知原因'), true);
        e.target.checked = false;
      } else {
        if (window.Prefs) window.Prefs.set('aiEnabled', true);
        aiMsg('已开启。AI 现在可以读取数据了；关掉开关端口立刻回收。');
      }
    } else {
      await window.api.ai.stop();
      if (window.Prefs) window.Prefs.set('aiEnabled', false);
      aiMsg('已关闭。端口已回收，令牌作废。');
    }
  } catch (err) {
    aiMsg('操作失败：' + ((err && err.message) || err), true);
  }
  box.disabled = false;
  await refreshAiPanel();
});

$('#btnAiShowToken').addEventListener('click', (e) => {
  if (!aiStatus || !aiStatus.running) return;
  aiTokenShown = !aiTokenShown;
  e.currentTarget.textContent = aiTokenShown ? '隐藏' : '显示';
  $('#aiToken').textContent = aiTokenShown
    ? (aiStatus.token || '')
    : '•'.repeat(Math.min(28, (aiStatus.token || '').length || 28));
});

$('#btnAiCopyToken').addEventListener('click', async (e) => {
  if (!aiStatus || !aiStatus.running) { aiMsg('先把开关打开。', true); return; }
  const ok = await copyText(aiStatus.token || '');
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => { btn.textContent = old; }, 1400);
});

$('#btnAiCopyConfig').addEventListener('click', async (e) => {
  const text = aiConfigText(aiStatus);
  if (!text) { aiMsg('先把开关打开，配置里需要用到令牌。', true); return; }
  const ok = await copyText(text);
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => { btn.textContent = old; }, 1400);
});

$('#btnAiExportPack').addEventListener('click', async () => {
  const btn = $('#btnAiExportPack');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const r = await window.api.ai.exportPack();
    if (!r || !r.ok) {
      aiMsg('生成失败：' + ((r && r.error) || '未知原因'), true);
    } else {
      const names = (r.files || []).map((f) => f.name).join('、');
      aiMsg(`已生成 ${(r.files || []).length} 个文件：${names}`);
      $('#aiExportHint').textContent = `已生成到 ${r.dir}（点「打开素材文件夹」直达）`;
    }
  } catch (err) {
    aiMsg('生成失败：' + ((err && err.message) || err), true);
  }
  btn.disabled = false;
  btn.textContent = '生成 AI 素材包';
});

$('#btnAiOpenFolder').addEventListener('click', () => window.api.ai.openFolder());
$('#btnAiEndpoint').addEventListener('click', () => window.api.ai.openEndpoint());

// ------------------------------------------------------------ 喵语数据站
//
// 第三方数据站（http://cwmsj.yukirus.com），只接刺猬猫栏目：试水推榜与万收首订。
// 站点是 hash 路由的纯前端应用，主进程做了路由白名单，这里只负责挂载、切换与状态显示。

/** 用户当前是否停在这一页 */
let miaoyuOpen = false;
/** 站点视图是否真的挂在窗口上（加载失败时会摘掉，露出兜底面板） */
let miaoyuMounted = false;
let miaoyuRoute = 'firstRecommend';

function miaoyuRect() {
  const r = $('#miaoyuHost').getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function syncMiaoyuBounds() {
  if (!miaoyuOpen || !miaoyuMounted) return;
  window.api.miaoyu.setBounds(miaoyuRect());
}

/** 从路由地址反推当前页签 */
function miaoyuRouteKey(route) {
  return /\/ciweimao\/sd$/i.test(String(route || '')) ? 'sd' : 'firstRecommend';
}

function renderMiaoyuTabs() {
  $$('#miaoyuTabs button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.route === miaoyuRoute);
  });
}

/** 「数据加载于 13:52 · 不会自动刷新」 */
function miaoyuLoadedText(ts) {
  if (!ts) return '数据来自喵语 · 第三方维护';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `数据加载于 ${p(d.getHours())}:${p(d.getMinutes())} · 不会自动刷新`;
}

function miaoyuStatus(text) {
  $('#miaoyuStatus').textContent = text;
}

function showMiaoyuFallback(msg) {
  $('#miaoyuFallbackMsg').textContent = msg;
  $('#miaoyuFallback').hidden = false;
}

async function openMiaoyu() {
  HOST.classList.add('is-ext');
  // 加完 class 布局才会铺满，等两帧再取矩形，否则拿到的还是带边距的旧尺寸
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  miaoyuOpen = true;
  miaoyuStatus('正在连接…');
  try {
    await window.api.miaoyu.open(miaoyuRect());
    miaoyuMounted = true;
    $('#miaoyuFallback').hidden = true;
  } catch (err) {
    miaoyuMounted = false;
    miaoyuStatus('打开失败');
    showMiaoyuFallback('没能打开数据站：' + ((err && err.message) || err));
  }
  renderMiaoyuTabs();
}

async function closeMiaoyu() {
  miaoyuOpen = false;
  miaoyuMounted = false;
  HOST.classList.remove('is-ext');
  try { await window.api.miaoyu.close(); } catch (_) { /* ignore */ }
}

$('#miaoyuTabs').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-route]');
  if (!btn) return;
  miaoyuRoute = btn.dataset.route;
  renderMiaoyuTabs();
  miaoyuStatus('正在加载…');
  try {
    const r = await window.api.miaoyu.goto(miaoyuRoute);
    miaoyuMounted = true;
    $('#miaoyuFallback').hidden = true;
    // 同一页签短时间内再点：不发请求，直接告诉用户数据是什么时候的
    if (r && r.skipped) miaoyuStatus(miaoyuLoadedText(r.loadedAt));
  } catch (err) {
    miaoyuStatus('加载失败');
    showMiaoyuFallback('加载失败：' + ((err && err.message) || err));
  }
});

$('#btnMiaoyuBack').addEventListener('click', () => window.api.miaoyu.back());
$('#btnMiaoyuForward').addEventListener('click', () => window.api.miaoyu.forward());
$('#btnMiaoyuReload').addEventListener('click', async () => {
  const r = await window.api.miaoyu.reload();
  // 刚加载过就别再拉一遍整页——这小站经不起连点
  if (r && r.skipped) miaoyuStatus(`刚刚刷新过 · ${miaoyuLoadedText(r.loadedAt)}`);
  else miaoyuStatus('正在加载…');
});
$('#btnMiaoyuExternal').addEventListener('click', () => window.api.miaoyu.external());
$('#btnMiaoyuRetry').addEventListener('click', () => openMiaoyu());

// ------------------------------------------------------------ 状态渲染

function renderConn(state) {
  const badge = $('#connBadge');
  const cardConn = $('#statConn');
  const cardConnHint = $('#statConnHint');
  const cardLogin = $('#statLogin');
  const cardLoginHint = $('#statLoginHint');

  if (!state || !state.url) {
    badge.dataset.state = 'idle';
    badge.querySelector('.conn-text').textContent = '后台未打开';
    cardConn.textContent = '待连接';
    cardConnHint.textContent = '点击右上角「打开作者后台」';
    cardLogin.textContent = '未知';
    cardLoginHint.textContent = '尚未访问作者后台';
    return;
  }

  if (state.isLoginPage) {
    badge.dataset.state = 'login';
    badge.querySelector('.conn-text').textContent = '待登录';
    cardConn.textContent = '已连接';
    cardConnHint.textContent = '页面已加载';
    cardLogin.textContent = '未登录';
    cardLoginHint.textContent = '请在页面内完成登录';
  } else {
    badge.dataset.state = 'live';
    badge.querySelector('.conn-text').textContent = '已登录';
    cardConn.textContent = '已连接';
    cardConnHint.textContent = '作者后台可读取';
    cardLogin.textContent = '已登录';
    cardLoginHint.textContent = state.title || '会话有效';
  }

  if (browserOpen) {
    $('#pageCrumb').textContent = state.isLoading ? '加载中…' : (state.url || '');
  }
}

window.api.browser.onEvent((data) => {
  if (data.type === 'browser-state') {
    lastState = data;
    renderConn(data);
    updateNavButtons(data);
    updateVaultBar(data);
  } else if (data.type === 'browser-error') {
    $('#pageCrumb').textContent = `加载失败 ${data.code} ${data.desc || ''}`;
  } else if (data.type === 'miaoyu-state') {
    miaoyuRoute = miaoyuRouteKey(data.route);
    renderMiaoyuTabs();
    $('#btnMiaoyuBack').disabled = !data.canGoBack;
    $('#btnMiaoyuForward').disabled = !data.canGoForward;
    // 如实告知：数据是加载时那一刻的，不会自己刷新（小站经不起轮询）
    miaoyuStatus(data.loading ? '正在加载…' : miaoyuLoadedText(data.loadedAt));
    if (!data.loading && miaoyuMounted) $('#miaoyuFallback').hidden = true;
  } else if (data.type === 'miaoyu-error') {
    // 第三方站点偶尔 502：把视图摘掉，否则它会盖住这块兜底面板
    miaoyuMounted = false;
    miaoyuStatus('加载失败');
    try { window.api.miaoyu.close(); } catch (_) { /* ignore */ }
    showMiaoyuFallback(
      `数据站没有响应（${data.code || '未知错误'}）。它由第三方维护，偶尔会短暂不可用；`
      + '可以点「重试」，或点右上「在浏览器打开」直接在浏览器里看。'
    );
  } else if (data.type === 'window-resized') {
    syncBounds();
    syncMiaoyuBounds();
  }
});

function updateNavButtons(state) {
  $('#btnBack').disabled = !(state && state.canGoBack);
  $('#btnForward').disabled = !(state && state.canGoForward);
}

// ------------------------------------------------------------ 密码本
//
// 界面这一侧只负责「显示账号列表 + 发指令」。
// 密码的解密与填入都在主进程里完成，这里拿不到、也不需要明文。

let vaultItems = [];

function ipcError(err) {
  return String((err && err.message) || err)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '');
}

function setVaultHint(text, kind) {
  const el = $('#vaultHint');
  el.textContent = text || '';
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-ok', kind === 'ok');
}

function renderVaultPick() {
  const sel = $('#vaultPick');
  if (!vaultItems.length) {
    sel.innerHTML = '<option value="">还没有保存的账号</option>';
    sel.disabled = true;
    $('#btnVaultFill').disabled = true;
    $('#btnVaultDelete').disabled = true;
    return;
  }
  sel.innerHTML = vaultItems.map((it) => (
    `<option value="${escapeHtml(it.id)}">${escapeHtml(it.username)}${it.mode === 'email' ? '（邮箱登录）' : ''}</option>`
  )).join('');
  sel.disabled = false;
  $('#btnVaultFill').disabled = false;
  $('#btnVaultDelete').disabled = false;
}

async function refreshVault(keepHint) {
  try {
    const st = await window.api.vault.status();
    vaultItems = st.items || [];
    const pathEl = $('#kvVault');
    if (pathEl) pathEl.textContent = st.file || '—';

    if (!st.available) {
      $('#vaultPick').innerHTML = '<option value="">系统加密不可用</option>';
      $('#vaultPick').disabled = true;
      $('#btnVaultFill').disabled = true;
      $('#btnVaultCapture').disabled = true;
      $('#btnVaultDelete').disabled = true;
      if (!keepHint) setVaultHint('系统加密不可用，出于安全考虑不保存密码', 'error');
      return;
    }

    $('#btnVaultCapture').disabled = false;
    renderVaultPick();
    if (!keepHint) {
      setVaultHint(
        vaultItems.length
          ? `已保存 ${vaultItems.length} 个账号 · 密码加密后仅存本机`
          : '先在页面里手动登录一次，再点「记住这次输入」',
        ''
      );
    }
  } catch (err) {
    if (!keepHint) setVaultHint(ipcError(err), 'error');
  }
}

/** 登录页出现时把工具条露出来，视图跟着让位 */
function updateVaultBar(state) {
  const show = browserOpen && !!(state && state.isLoginPage);
  const bar = $('#vaultBar');
  if (bar.hidden === !show) return;
  bar.hidden = !show;
  if (show) refreshVault(false);
  syncBounds();
}

$('#btnVaultFill').addEventListener('click', async () => {
  const id = $('#vaultPick').value;
  if (!id) return;
  const btn = $('#btnVaultFill');
  btn.disabled = true;
  btn.textContent = '填入中…';
  setVaultHint('正在填入…');
  try {
    const res = await window.api.vault.fill(id);
    if (res && res.ok) {
      setVaultHint('已填入账号和密码，完成验证码后点登录', 'ok');
    } else if (res && (!res.filledUser || !res.filledPass)) {
      setVaultHint('没找到输入框，登录页可能改版了', 'error');
    } else {
      setVaultHint('填入未完成', 'error');
    }
  } catch (err) {
    setVaultHint(ipcError(err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '填入';
  }
});

$('#btnVaultCapture').addEventListener('click', async () => {
  const btn = $('#btnVaultCapture');
  btn.disabled = true;
  setVaultHint('正在保存…');
  try {
    const res = await window.api.vault.capture();
    vaultItems = res.items || [];
    renderVaultPick();
    if (res.item) $('#vaultPick').value = res.item.id;
    setVaultHint(`已保存：${res.item ? res.item.username : ''} · 下次点「填入」即可`, 'ok');
  } catch (err) {
    setVaultHint(ipcError(err), 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#btnVaultDelete').addEventListener('click', async () => {
  const id = $('#vaultPick').value;
  if (!id) return;
  const item = vaultItems.find((x) => x.id === id);
  if (!window.confirm(`确定从本机删除「${item ? item.username : '这条记录'}」？此操作不可恢复。`)) return;
  try {
    const res = await window.api.vault.remove(id);
    vaultItems = res.items || [];
    renderVaultPick();
    setVaultHint(`已删除 · 还剩 ${vaultItems.length} 个账号`, 'ok');
  } catch (err) {
    setVaultHint(ipcError(err), 'error');
  }
});

// ------------------------------------------------------------ 页面测绘

const btnProbe = $('#btnProbe');
const progress = $('#probeProgress');
const bar = $('#probeBar');
const ptext = $('#probeText');
const notice = $('#probeNotice');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function showNotice(text, isError) {
  notice.hidden = false;
  notice.classList.toggle('is-error', !!isError);
  notice.innerHTML = text;
}

btnProbe.addEventListener('click', async () => {
  if (!lastState.url || lastState.isLoginPage) {
    progress.hidden = true;
    showNotice('请先登录作者后台，再回来执行测绘。', true);
    return;
  }

  btnProbe.disabled = true;
  progress.hidden = false;
  notice.hidden = true;
  bar.style.width = '0%';
  ptext.textContent = '准备中…';

  try {
    const manifest = await window.probeApi.collectDiagnostics((p) => {
      if (p.phase === 'navigate') {
        bar.style.width = Math.round(((p.index - 1) / p.total) * 100) + '%';
        ptext.textContent = `正在测绘 ${p.index}/${p.total} · ${p.label}`;
      } else if (p.phase === 'done-page') {
        bar.style.width = Math.round((p.index / p.total) * 100) + '%';
        ptext.textContent = `已完成 ${p.index}/${p.total}`;
      }
    });

    const ok = manifest.pages.filter((x) => !x.error).length;
    const dir = await window.api.diag.dir();
    bar.style.width = '100%';
    ptext.textContent = `测绘结束 · 成功 ${ok} / 共 ${manifest.pages.length}`;
    $('#btnOpenDiagDir').hidden = false;

    if (manifest.aborted) {
      showNotice(
        `<strong>测绘中止</strong>：${escapeHtml(manifest.aborted)}<br>` +
        `已完成 ${ok} 个页面。请重新登录作者后台，再次执行测绘。`,
        true
      );
    } else {
      showNotice(
        `测绘完成：${ok}/${manifest.pages.length} 个页面成功。<br>` +
        `诊断包：<span class="mono">${escapeHtml(dir)}</span>`
      );
    }
  } catch (err) {
    showNotice('测绘失败：' + escapeHtml(err && err.message ? err.message : err), true);
    ptext.textContent = '';
  } finally {
    btnProbe.disabled = false;
  }
});

$('#btnOpenDiagDir').addEventListener('click', async () => {
  try {
    const dir = await window.api.diag.dir();
    await window.api.app.openPath(dir);
  } catch (_) { /* ignore */ }
});

// ------------------------------------------------------------ 抓取与审查

let crawlData = null;
let reviewResult = null;
let reviewFilter = 'all';
let reviewQuery = '';
let reviewLimit = 60;
let readerView = false;
let crawlStop = false;

// 审查页的筛选与批量状态
let reviewBook = 'all';          // 'all' 或某本书的 bookId
let dismissed = new Set();       // 被手动剔除的「误判」条目 id
let picked = new Set();          // 批量勾选的条目 id
let batchAct = 'delete';         // 批量动作
let batchBusy = false;
let batchStop = false;
let bookList = [];
let pickedBooks = new Set();
const reviewParagraphCache = new Map();

const PAGE_SIZE = 60;

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (_) { return iso; }
}

function renderBookPicker() {
  const box = $('#bookPicker');
  if (!bookList.length) {
    box.innerHTML = '<div class="hint-line">登录后点击「读取作品列表」</div>';
    $('#btnCrawl').disabled = true;
    return;
  }
  box.innerHTML = bookList.map((b) => `
    <label class="book-row">
      <input type="checkbox" value="${escapeHtml(b.bookId)}" ${pickedBooks.has(b.bookId) ? 'checked' : ''} />
      <span>${escapeHtml(b.name)}</span>
      <span class="hint-line">${escapeHtml(b.bookId)}</span>
    </label>
  `).join('');
  box.querySelectorAll('input').forEach((el) => {
    el.addEventListener('change', () => {
      if (el.checked) pickedBooks.add(el.value); else pickedBooks.delete(el.value);
      $('#btnCrawl').disabled = pickedBooks.size === 0;
    });
  });
  $('#btnCrawl').disabled = pickedBooks.size === 0;
}

$('#btnListBooks').addEventListener('click', async () => {
  const btn = $('#btnListBooks');
  btn.disabled = true;
  btn.textContent = '读取中…';
  try {
    const books = await window.Crawler.listBooks();
    bookList = books;
    if (!pickedBooks.size) books.forEach((b) => pickedBooks.add(b.bookId));
    renderBookPicker();
  } catch (err) {
    $('#crawlProgress').hidden = true;
    showCrawlNotice('读取作品列表失败：' + escapeHtml(err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = '读取作品列表';
  }
});

function showCrawlNotice(html, isError) {
  const n = $('#crawlNotice');
  n.hidden = false;
  n.classList.toggle('is-error', !!isError);
  n.innerHTML = html;
}

$('#btnCrawl').addEventListener('click', async () => {
  if (!pickedBooks.size) return;
  crawlStop = false;
  $('#btnCrawl').disabled = true;
  $('#btnStopCrawl').hidden = false;
  $('#btnListBooks').disabled = true;
  $('#crawlProgress').hidden = false;
  $('#crawlNotice').hidden = true;
  $('#crawlBar').style.width = '0%';
  $('#crawlText').textContent = '准备中…';

  const maxRaw = $('#maxPages').value.trim();
  const maxPages = maxRaw ? Math.max(1, parseInt(maxRaw, 10)) : 999;

  try {
    const result = await window.Crawler.crawlTsukkomi({
      bookIds: [...pickedBooks],
      maxPages,
      shouldStop: () => crawlStop,
      onProgress: (p) => {
        if (p.phase === 'book-start') {
          $('#crawlText').textContent = `开始读取第 ${p.bookIndex}/${p.bookTotal} 本…`;
        } else if (p.phase === 'book-info') {
          $('#crawlText').textContent = `《${p.bookName}》共 ${p.pages} 页`;
        } else if (p.phase === 'page') {
          const overall = (p.bookIndex - 1) / p.bookTotal + (p.page / p.pages) / p.bookTotal;
          $('#crawlBar').style.width = Math.round(overall * 100) + '%';
          $('#crawlText').textContent =
            `《${p.bookName}》 ${p.page}/${p.pages} 页 · 本书 ${p.bookCount} 条 · 累计 ${p.total} 条`;
        }
      },
    });

    await window.api.data.write('tsukkomi.json', result);
    crawlData = result;
    runReview();
    renderAll();

    $('#crawlBar').style.width = '100%';
    const truncated = result.books.some((b) => b.pages >= maxPages && maxPages < 999);
    showCrawlNotice(
      `抓取完成：${result.items.length} 条间贴，来自 ${result.books.length} 部作品。` +
      (truncated ? '<br>注意：已按「每本最多抓」限制截断，如需全量请调大页数。' : '')
    );
  } catch (err) {
    showCrawlNotice('抓取失败：' + escapeHtml(err.message || err), true);
    $('#crawlText').textContent = '';
  } finally {
    $('#btnCrawl').disabled = pickedBooks.size === 0;
    $('#btnStopCrawl').hidden = true;
    $('#btnListBooks').disabled = false;
  }
});

$('#btnStopCrawl').addEventListener('click', () => {
  crawlStop = true;
  $('#crawlText').textContent = '正在停止…';
});

/** 审查强度：false = 标准（不把负面评价算恶意），true = 严格（负面评价也计入） */
let reviewStrict = false;

/** 当前作品范围内的原始条目 */
function scopedItems() {
  const all = (crawlData && crawlData.items) || [];
  if (reviewBook === 'all') return all;
  return all.filter((x) => String(x.bookId || '') === String(reviewBook));
}

function runReview() {
  if (!crawlData || !crawlData.items) { reviewResult = null; signalResult = null; return; }
  // 统计、列表、读者视图都基于「当前选中的作品」，否则单本筛选后数字会对不上
  reviewResult = window.Reviewer.review(scopedItems(), { strictNegative: reviewStrict });
  picked.clear();
  runSignals();
}

function renderReviewStrict() {
  $$('#reviewStrictSeg button').forEach((b) => {
    b.classList.toggle('is-active', (b.dataset.strict === '1') === reviewStrict);
  });
}

$('#reviewStrictSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-strict]');
  if (!btn) return;
  const next = btn.dataset.strict === '1';
  if (next === reviewStrict) return;
  reviewStrict = next;
  if (window.Prefs) window.Prefs.set('reviewStrict', reviewStrict);
  renderReviewStrict();
  // 已有数据就立刻重算，不必重新抓取
  if (crawlData && crawlData.items && crawlData.items.length) {
    runReview();
    renderAll();
  }
});

function renderStats() {
  const box = $('#reviewStats');
  if (!reviewResult) { box.innerHTML = ''; return; }
  const s = reviewResult.stats;
  const left = execPool().filter((x) => x.level !== 'none').length;
  box.innerHTML = `
    <div class="stat"><div class="stat-label">评论总数</div><div class="stat-num">${s.total}</div></div>
    <div class="stat"><div class="stat-label">高风险</div><div class="stat-num is-high">${s.high}</div></div>
    <div class="stat"><div class="stat-label">中风险</div><div class="stat-num is-mid">${s.mid}</div></div>
    <div class="stat"><div class="stat-label">待处理</div><div class="stat-num">${left}</div></div>
    <div class="stat"><div class="stat-label">已剔除</div><div class="stat-num">${dismissed.size}${
      dismissed.size ? ' <button class="link-btn" id="btnRestoreDismissed" type="button">恢复</button>' : ''
    }</div></div>
  `;
}

function filteredItems() {
  if (!reviewResult) return [];
  const q = reviewQuery.trim().toLowerCase();
  const rank = { high: 0, mid: 1, none: 2 };
  return reviewResult.items
    .filter((x) => {
      if (dismissed.has(String(x.id))) return false;
      if (reviewBook !== 'all' && String(x.bookId || '') !== String(reviewBook)) return false;
      if (reviewFilter === 'high' && x.level !== 'high') return false;
      if (reviewFilter === 'mid' && x.level !== 'mid') return false;
      if (reviewFilter === 'clean' && x.level !== 'none') return false;
      if (q) {
        const hay = (x.content + ' ' + x.nickname).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    // 有风险的排前面，同级别里新的在前——「直接审查有问题的」就该这样排
    .sort((a, b) => (rank[a.level] - rank[b.level]) || String(b.time || '').localeCompare(String(a.time || '')));
}

function renderList() {
  const list = $('#reviewList');
  const empty = $('#reviewEmpty');
  const more = $('#reviewMore');

  if (!reviewResult || !reviewResult.items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    more.hidden = true;
    return;
  }
  empty.hidden = true;

  if (readerView) {
    const readers = reviewResult.stats.likelyBadReaders;
    list.innerHTML = readers.length
      ? readers.map((r) => `
        <div class="review-item ${r.flagged >= 2 ? 'lv-high' : 'lv-mid'}">
          <div class="review-head">
            <span class="review-nick">${escapeHtml(r.nickname || '未知读者')}</span>
            <span class="badge">ID ${escapeHtml(r.readerId)}</span>
            <span class="badge ${r.flagged >= 2 ? 'high' : 'mid'}">违规 ${r.flagged} 条</span>
            <span>共发言 ${r.total} 条</span>
            <span>最高 ${r.score} 分</span>
            ${typeof r.ratio === 'number' ? `<span>负面 ${Math.round(r.ratio * 100)}%</span>` : ''}
            ${r.verdict === 'rhythm-troll' ? '<span class="badge high">疑似带节奏</span>' : ''}
            ${r.verdict === 'suspect' ? '<span class="badge mid">有嫌疑</span>' : ''}
          </div>
        </div>
      `).join('')
      : '<div class="empty"><div class="empty-title">没有发现可疑读者</div><p>当前规则下未识别出集中的违规行为。</p></div>';
    more.hidden = true;
    return;
  }

  const rows = filteredItems();
  const slice = rows.slice(0, reviewLimit);

  list.innerHTML = slice.map((x) => {
    const lvClass = x.level === 'high' ? 'lv-high' : x.level === 'mid' ? 'lv-mid' : '';
    const short = (x.content || '').length <= 2;
    const hits = x.hits.length
      ? `<div class="review-hits">${x.hits.map((h) => `<span class="hit">${escapeHtml(h.name)} · ${escapeHtml(h.matched)}</span>`).join('')}</div>`
      : '';
    const id = escapeHtml(String(x.id));
    const checkable = x.level !== 'none';
    return `
      <div class="review-item ${lvClass}${x.handled ? ' is-done' : ''}">
        <div class="review-head">
          ${checkable
            ? `<input type="checkbox" class="review-check" data-check-id="${id}" ${picked.has(String(x.id)) ? 'checked' : ''} />`
            : '<span class="review-check-space"></span>'}
          <span class="review-nick">${escapeHtml(x.nickname || '未知')}</span>
          <span>${escapeHtml(x.time || '')}</span>
          ${x.level === 'high' ? '<span class="badge high">高风险 ' + x.score + '</span>' : ''}
          ${x.level === 'mid' ? '<span class="badge mid">中风险 ' + x.score + '</span>' : ''}
          ${x.handled ? '<span class="badge">已处理</span>' : ''}
          <button class="link-btn review-paragraph-btn" type="button" data-paragraph-id="${id}">查看原段</button>
          <button class="link-btn review-act" type="button" data-act-id="${id}">${x.handled ? '再看一眼' : '处理'}</button>
          <button class="link-btn review-dismiss" type="button" data-dismiss-id="${id}">剔除</button>
        </div>
        <div class="review-body ${short ? 'is-short' : ''}">${escapeHtml(x.content || '（空）')}</div>
        ${hits}
        <div class="review-meta-line">${escapeHtml(x.bookName || '')} · ${escapeHtml(x.chapterName || '')} · ${escapeHtml(x.paraPos || '')}</div>
        <div class="review-paragraph" data-paragraph-box="${id}" hidden></div>
      </div>
    `;
  }).join('');

  more.hidden = rows.length <= reviewLimit;
  if (!more.hidden) {
    $('#btnLoadMore').textContent = `加载更多（已显示 ${slice.length} / ${rows.length}）`;
  }
}

/** 作品下拉：从已抓数据里汇总，用于「全部作品 / 单本」筛选 */
function renderBookOptions() {
  const sel = $('#reviewBook');
  if (!sel) return;
  const books = new Map();
  ((crawlData && crawlData.items) || []).forEach((x) => {
    if (!x.bookId) return;
    books.set(String(x.bookId), x.bookName || ('作品 ' + x.bookId));
  });
  if (reviewBook !== 'all' && !books.has(String(reviewBook))) reviewBook = 'all';
  sel.innerHTML = ['<option value="all">全部作品</option>']
    .concat([...books.entries()].map(([id, name]) =>
      `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`))
    .join('');
  sel.value = reviewBook;
}

// ---------------------------------------------------------- 剔除（误判）

async function saveDismissed() {
  try { await window.api.data.write('review-dismissed.json', { ids: [...dismissed] }); } catch (_) { /* ignore */ }
}

async function loadDismissed() {
  try {
    const d = await window.api.data.read('review-dismissed.json');
    if (d && Array.isArray(d.ids)) dismissed = new Set(d.ids.map(String));
  } catch (_) { /* 读不到就当没有 */ }
}

function renderDismissAll() {
  // 剔除/恢复后统一收尾：重算统计与列表
  if (execSample && dismissed.has(String(execSample.id))) {
    execSample = null; execSlip = null;
    execSetPanels(false);
  }
  renderAll();
}

function dismissItem(id) {
  const key = String(id);
  dismissed.add(key);
  picked.delete(key);
  saveDismissed();
  renderDismissAll();
}

function restoreDismissed() {
  dismissed.clear();
  picked.clear();
  saveDismissed();
  renderDismissAll();
}

// ---------------------------------------------------------- 批量处理

function selectedItems() {
  if (!reviewResult) return [];
  return reviewResult.items.filter((x) => picked.has(String(x.id)));
}

function renderBatchBar() {
  const bar = $('#batchBar');
  if (!bar) return;

  // 清掉已经不可选的选择（被剔除、被处理、评分变了）
  if (reviewResult) {
    const valid = new Set(
      reviewResult.items
        .filter((x) => x.level !== 'none' && !dismissed.has(String(x.id)))
        .map((x) => String(x.id))
    );
    [...picked].forEach((id) => { if (!valid.has(id)) picked.delete(id); });
  }

  const n = picked.size;
  // 常驻显示，不清空也不隐藏——勾没勾选，位置都不动，避免按钮跑掉
  bar.hidden = false;
  bar.classList.toggle('is-empty', n === 0 && !batchBusy);
  const count = $('#batchCount');
  if (count) count.textContent = n ? `已选 ${n} 条` : '未选条目';

  const run = $('#btnBatchRun');
  if (run) run.disabled = n === 0 || batchBusy;
  ['#btnBatchSelectHigh', '#btnBatchSelectMid', '#btnBatchClear'].forEach((sel) => {
    const b = $(sel);
    if (b) b.disabled = batchBusy || (sel === '#btnBatchClear' && n === 0);
  });
}

function batchFailText(step) {
  if (!step || !step.res) return '没有返回结果';
  return window.Executor.resultText(step.action, step.res, step.verify);
}

async function runBatch() {
  if (batchBusy) return;
  const items = selectedItems();
  if (!items.length) { execNotice('还没有勾选任何条目。', true); return; }

  const dryRun = $('#batchDryRun').checked;
  const action = batchAct;
  const label = window.Executor.ACTION_LABEL[action] || action;

  if (!dryRun) {
    const ok = window.confirm(
      `即将对 ${items.length} 条执行「${label}」。

删除不可撤销；禁言跨作品生效。确定继续？`
    );
    if (!ok) return;
  }

  batchBusy = true;
  batchStop = false;
  const runBtn = $('#btnBatchRun');
  const clearBtn = $('#btnBatchClear');
  runBtn.disabled = true;
  clearBtn.disabled = false;
  clearBtn.textContent = '停止';

  const okIds = [];
  const failed = [];

  for (let i = 0; i < items.length; i += 1) {
    if (batchStop) break;
    const it = items[i];
    $('#batchProgress').textContent = `${i + 1}/${items.length} · ${action === 'delete' ? '删除' : action === 'mute' ? '禁言' : '拉黑'}中…`;

    const slip = window.Executor.buildSlip(it);
    slip.pageUrl = window.Executor.pageUrl(slip);
    try {
      const res = await window.Executor.run(slip, action, { dryRun });
      if (res.ok) {
        okIds.push(String(it.id));
        if (!dryRun) markHandled(slip, action);
        picked.delete(String(it.id));
      } else {
        const bad = (res.steps || []).find((x) => !(x.res && (x.res.ok || x.res.dryRun)));
        failed.push({ item: it, why: batchFailText(bad) });
        // 登录态失效就没必要继续往下打了
        if (bad && bad.res && bad.res.needLogin) { batchStop = true; }
      }
    } catch (err) {
      const msg = String((err && err.message) || err);
      failed.push({ item: it, why: msg.slice(0, 90) });
      if (/登录态/.test(msg)) batchStop = true;
    }
    // 串行节奏：宁慢一点，别把平台打急了
    await new Promise((r) => setTimeout(r, dryRun ? 80 : 500));
  }

  batchBusy = false;
  clearBtn.textContent = '取消选择';
  clearBtn.disabled = false;
  runBtn.disabled = picked.size === 0;

  const doneN = okIds.length;
  const failN = failed.length;
  const extra = failed.length
    ? '<br>失败 ' + failN + ' 条：' + failed.slice(0, 3)
      .map((f) => escapeHtml(String(f.item.nickname || '') + '：' + f.why)).join('；')
      + (failN > 3 ? ' …' : '')
    : '';
  execNotice(
    (dryRun ? '演练完成（请求未发出）' : '批量执行完成') +
    '：成功 ' + doneN + ' 条，失败 ' + failN + ' 条' +
    (batchStop ? '，已提前停止' : '') + '。' + extra,
    failN > 0
  );
  $('#batchProgress').textContent = dryRun ? '演练完成' : '完成';
  if (!dryRun) refreshExecLog();
  renderAll();
}

function renderSyncInfo() {
  if (crawlData) {
    $('#kvLastSync').textContent = fmtTime(crawlData.syncedAt);
    $('#kvTotal').textContent = (crawlData.items || []).length + ' 条';
    $('#statData').textContent = (crawlData.items || []).length + ' 条';
    $('#statDataHint').textContent = '上次同步 ' + fmtTime(crawlData.syncedAt);
  } else {
    $('#kvLastSync').textContent = '尚未抓取';
    $('#kvTotal').textContent = '0';
    $('#statData').textContent = '0 条';
    $('#statDataHint').textContent = '尚未抓取';
  }
}

function renderAll() {
  renderBookOptions();
  renderStats();
  renderList();
  renderSyncInfo();
  renderExecPool();
}

$('#reviewFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  reviewFilter = b.dataset.filter;
  reviewLimit = PAGE_SIZE;
  $('#reviewFilter').querySelectorAll('button').forEach((x) => {
    x.classList.toggle('is-active', x === b);
  });
  renderList();
});

$('#reviewSearch').addEventListener('input', (e) => {
  reviewQuery = e.target.value;
  reviewLimit = PAGE_SIZE;
  renderList();
});

$('#btnLoadMore').addEventListener('click', () => {
  reviewLimit += PAGE_SIZE;
  renderList();
});

async function toggleReviewParagraph(button) {
  const id = String(button.dataset.paragraphId || '');
  const box = $('#reviewList').querySelector(`[data-paragraph-box="${id}"]`);
  if (!box) return;

  if (!box.hidden) {
    box.hidden = true;
    button.textContent = '查看原段';
    return;
  }

  const hit = (reviewResult && reviewResult.items || []).find((x) => String(x.id) === id);
  if (!hit) return;
  const key = [hit.bookId, hit.chapterId, hit.paraPos].map((x) => String(x || '')).join(':');
  box.hidden = false;
  button.textContent = '收起原段';

  const cached = reviewParagraphCache.get(key);
  if (cached) {
    box.classList.remove('is-error', 'is-loading');
    box.innerHTML = `<div class="review-paragraph-label">${escapeHtml(cached.title || hit.chapterName || '对应原文')} · 第 ${cached.index} 段</div>`
      + `<div class="review-paragraph-text">${escapeHtml(cached.text)}</div>`;
    return;
  }

  box.classList.remove('is-error');
  box.classList.add('is-loading');
  box.textContent = '正在只读获取对应段落…';
  button.disabled = true;
  try {
    const paragraph = await window.Exporter.readParagraph(
      hit.bookId,
      hit.chapterId,
      hit.paraPos,
      hit.chapterName
    );
    reviewParagraphCache.set(key, paragraph);
    box.classList.remove('is-loading');
    box.innerHTML = `<div class="review-paragraph-label">${escapeHtml(paragraph.title || hit.chapterName || '对应原文')} · 第 ${paragraph.index} 段</div>`
      + `<div class="review-paragraph-text">${escapeHtml(paragraph.text)}</div>`;
  } catch (err) {
    box.classList.remove('is-loading');
    box.classList.add('is-error');
    box.textContent = '读取原段失败：' + String((err && err.message) || err);
  } finally {
    button.disabled = false;
  }
}

// 列表内的四个动作：勾选 / 查看原段 / 处理 / 剔除
$('#reviewList').addEventListener('click', (e) => {
  const chk = e.target.closest('[data-check-id]');
  if (chk) {
    const id = String(chk.dataset.checkId);
    if (chk.checked) picked.add(id); else picked.delete(id);
    renderBatchBar();
    return;
  }

  const paragraph = e.target.closest('[data-paragraph-id]');
  if (paragraph) {
    toggleReviewParagraph(paragraph);
    return;
  }

  const dis = e.target.closest('[data-dismiss-id]');
  if (dis) {
    dismissItem(dis.dataset.dismissId);
    return;
  }

  const act = e.target.closest('[data-act-id]');
  if (!act) return;
  const id = String(act.dataset.actId);
  const hit = (reviewResult && reviewResult.items || []).find((x) => String(x.id) === id);
  if (!hit) return;
  showExecSample(hit);
});

// 作品筛选
$('#reviewBook').addEventListener('change', (e) => {
  reviewBook = e.target.value || 'all';
  reviewLimit = PAGE_SIZE;
  picked.clear();
  runReview();     // 重新按这本书的条目打分
  renderAll();
});

// 恢复已剔除
$('#reviewStats').addEventListener('click', (e) => {
  if (e.target.closest('#btnRestoreDismissed')) restoreDismissed();
});

// 批量条
$('#batchAction').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  batchAct = b.dataset.act;
  $$('#batchAction button').forEach((x) => x.classList.toggle('is-active', x === b));
});

$('#btnBatchRun').addEventListener('click', runBatch);

function selectByLevel(level) {
  picked.clear();
  filteredItems().filter((x) => x.level === level && !x.handled)
    .forEach((x) => picked.add(String(x.id)));
  renderList();
  renderBatchBar();
}

$('#btnBatchSelectHigh').addEventListener('click', () => selectByLevel('high'));
$('#btnBatchSelectMid').addEventListener('click', () => selectByLevel('mid'));

$('#btnBatchClear').addEventListener('click', () => {
  if (batchBusy) { batchStop = true; $('#batchProgress').textContent = '正在停止…'; return; }
  picked.clear();
  renderList();
  renderBatchBar();
});

// 设置页：一键复制作者 QQ，方便别人反馈
$('#btnCopyQQ').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const qq = $('#kvAuthorQQ').textContent.trim();
  let ok = false;
  try {
    await navigator.clipboard.writeText(qq);
    ok = true;
  } catch (_) {
    // clipboard 被拒时的兜底：临时 textarea + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = qq;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e2) { ok = false; }
  }
  const old = btn.textContent;
  btn.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => { btn.textContent = old; }, 1400);
});

$('#btnExecClose').addEventListener('click', () => {
  execSetPanels(false);
  execSample = null;
  execSlip = null;
});

$('#btnToggleReaderView').addEventListener('click', (e) => {
  readerView = !readerView;
  e.target.textContent = readerView ? '按评论看' : '按读者看';
  renderList();
});

// ------------------------------------------------------------ 数据看板

let snapshots = [];
let viewDay = null;
let statsBusy = false;
/** 看板查看范围：'' = 全部作品合计，否则为某本书的 bookId */
let boardBookId = '';
let bookOptionsKey = '';

function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-CN');
}

function diffBit(diff) {
  if (diff == null) return '<div class="metric-diff">待积累</div>';
  if (diff === 0) return '<div class="metric-diff flat">持平</div>';
  const up = diff > 0;
  return `<div class="metric-diff ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${up ? '+' : ''}${fmtNum(diff)}</div>`;
}

function pctBit(pct) {
  if (pct == null) return '<div class="metric-diff">—</div>';
  if (pct === 0) return '<div class="metric-diff flat">比前日 0%</div>';
  const up = pct > 0;
  return `<div class="metric-diff ${up ? 'up' : 'down'}">比前日 ${up ? '+' : ''}${pct}%</div>`;
}

function currentSnapshot() {
  if (!snapshots.length) return null;
  if (viewDay) {
    const found = snapshots.find((s) => s.day === viewDay);
    if (found) return found;
  }
  return snapshots[snapshots.length - 1];
}

/**
 * 同步「查看范围」下拉的选项。
 * 返回 fellBack=true 表示原先选中的书在这一天的快照里不存在（例如更早的日期还没有这本书），
 * 已自动退回全部作品，调用方需要把这个变化告知用户。
 */
function syncBookOptions(books) {
  const sel = $('#boardBook');
  const list = books || [];

  const sig = list.map((b) => `${b.bookId}:${b.name}`).join('|');
  if (sig !== bookOptionsKey) {
    bookOptionsKey = sig;
    sel.innerHTML =
      '<option value="">全部作品（合计）</option>' +
      list.map((b) => `<option value="${escapeHtml(String(b.bookId))}">《${escapeHtml(b.name)}》</option>`).join('');
  }

  let fellBack = false;
  if (boardBookId && !list.some((b) => String(b.bookId) === boardBookId)) {
    boardBookId = '';
    fellBack = true;
  }

  sel.value = boardBookId;
  sel.disabled = list.length === 0;
  // 单本视图下副标题已写明书名，这里不再重复「共 N 部作品」
  $('#boardScopeHint').textContent = fellBack
    ? '这本书在这一天还没有记录，已切回全部作品'
    : (!boardBookId && list.length ? `共 ${list.length} 部作品` : '');

  return { fellBack };
}

function renderBoard() {
  const snap = currentSnapshot();
  const booksBox = $('#boardBooks');
  const totalsBox = $('#boardTotals');
  const extraBox = $('#boardExtra');

  if (!snap) {
    $('#boardEmpty').hidden = false;
    booksBox.innerHTML = '';
    totalsBox.innerHTML = '';
    extraBox.hidden = true;
    extraBox.innerHTML = '';
    $('#boardChart').hidden = true;
    $('#boardDay').textContent = '尚无数据';
    $('#boardSub').textContent = '以每日 06:00 为结算分界';
    $('#btnPrevDay').hidden = true;
    bookOptionsKey = '';
    $('#boardBook').innerHTML = '<option value="">全部作品（合计）</option>';
    $('#boardBook').disabled = true;
    $('#boardScopeHint').textContent = '';
    return;
  }

  $('#boardEmpty').hidden = true;

  const prev = window.Stats.previousSnapshot(snapshots, snap.day);
  const cur = window.Stats.annotateDiff(snap, prev);

  syncBookOptions(cur.books);

  // 按查看范围裁剪：全部时原样返回，单本时只留该书并按书重算合计
  const scoped = window.Stats.scopeSnapshot(cur, boardBookId) || cur;
  const single = scoped.books.length === 1 && !!scoped.scopedBookId ? scoped.books[0] : null;

  $('#boardDay').textContent = `统计日 ${cur.day} · ${single ? '单看一本' : '全部作品'}`;
  $('#boardSub').textContent = prev
    ? `对比基准 ${prev.day} · 采集于 ${fmtTime(cur.capturedAt)}`
    : `首次采集 · 采集于 ${fmtTime(cur.capturedAt)} · 明日 06:00 后即可对比`;

  const older = snapshots.filter((s) => s.day < snap.day);
  $('#btnPrevDay').hidden = older.length === 0;

  renderTotals(totalsBox, scoped.totals, single, cur.totals);
  renderBookCards(booksBox, scoped.books, !!single);
  renderSingleExtra(extraBox, single);
  renderBookChart(single);
}

// ------------------------------------------------------------ 每日趋势折线图
// 只在单本视图使用：不同作品的量级差太远（百万字 vs 百级订阅），同图会互相压平

const CHART_METRICS = [
  { key: 'words', label: '总字数', unit: ' 字' },
  { key: 'collects', label: '收藏', unit: '' },
  { key: 'totalSubs', label: '总订阅', unit: '' },
  { key: 'newSubs', label: '新增订阅', unit: '' },
  { key: 'avgSubs', label: '章节均订', unit: '' },
  { key: 'dailyChase', label: '日均追订', unit: '' },
];

let chartMetric = 'words';
let lastChartWidth = 0;

/** 从历史快照里抽出某本书某个指标的序列，按日期升序，截止到 upToDay */
function chartPoints(bookId, upToDay, metric) {
  return snapshots
    .filter((s) => !upToDay || s.day <= upToDay)
    .slice()
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map((s) => {
      const b = (s.books || []).find((x) => String(x.bookId) === String(bookId));
      if (!b) return null;
      const v = b[metric];
      if (v == null || Number.isNaN(Number(v))) return null;
      return { day: s.day, value: Number(v) };
    })
    .filter(Boolean);
}

function buildChartMetrics() {
  const box = $('#chartMetrics');
  if (box.dataset.ready === '1') return;
  box.innerHTML = CHART_METRICS.map(
    (m) => `<button type="button" data-metric="${m.key}">${m.label}</button>`
  ).join('');
  box.dataset.ready = '1';
}

function renderBookChart(single) {
  const panel = $('#boardChart');
  if (!single) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  buildChartMetrics();

  const meta = CHART_METRICS.find((m) => m.key === chartMetric) || CHART_METRICS[0];
  Array.prototype.forEach.call($('#chartMetrics').children, (btn) => {
    btn.classList.toggle('is-active', btn.dataset.metric === meta.key);
  });

  const snap = currentSnapshot();
  const points = chartPoints(single.bookId, snap ? snap.day : null, meta.key);

  $('#chartSub').textContent = `《${single.name}》· ${meta.label}`;

  const canvas = $('#chartCanvas');
  lastChartWidth = canvas.clientWidth;
  window.Chart.lineChart(canvas, { points, unit: meta.unit });

  const foot = $('#chartFoot');
  if (!points.length) {
    foot.textContent = '还没有可用于绘制的数据';
    return;
  }
  if (points.length === 1) {
    foot.textContent = `目前只有 ${points[0].day} 一天的数据 · 明天 06:00 后自动采集一次，即可连成趋势线`;
    return;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const diff = last.value - first.value;
  const pct = first.value ? (diff / first.value) * 100 : null;
  const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  const arrow = diff > 0 ? '▲ +' : (diff < 0 ? '▼ ' : '持平 ');
  const pctText = pct == null ? '' : `（${pct > 0 ? '+' : ''}${pct.toFixed(1)}%）`;

  foot.innerHTML =
    `共 ${points.length} 天 · ${first.day} → ${last.day} · 区间 <span class="${cls}">${arrow}${fmtNum(diff)}${pctText}</span>`;
}

$('#chartMetrics').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-metric]');
  if (!btn || btn.dataset.metric === chartMetric) return;
  chartMetric = btn.dataset.metric;
  renderBoard();
});

// SVG 坐标是按容器宽度算的，窗口缩放后必须重算。
// 只在宽度真正变化时重绘，避免内容变化引发的尺寸抖动造成循环。
if (typeof ResizeObserver !== 'undefined') {
  let resizeTimer = null;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (!w || w === lastChartWidth) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if ($('#boardChart').hidden || !boardBookId) return;
      const snap = currentSnapshot();
      const b = snap && (snap.books || []).find((x) => String(x.bookId) === boardBookId);
      if (b) renderBookChart(b);
    }, 120);
  }).observe($('#chartCanvas'));
}

/** 占全部的百分比，用于单本视图下让汇总卡有独立信息量 */
function pctOf(part, total) {
  if (part == null || !total) return null;
  const p = (part / total) * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(1)}%`;
}

/**
 * 四张汇总卡。
 * 单本视图下：数值取该书的，副标题显示「占全部 X%」——
 * 差值在下方书籍卡里已逐项列出，这里换成占比，两块区域信息互补而不是重复。
 */
function renderTotals(box, t, single, allTotals) {
  if (t && t.scopedMissing) {
    box.innerHTML = '';
    return;
  }

  const sub = (field, diff) => {
    if (!single) return sumDiff(diff);
    const p = pctOf(t[field], allTotals ? allTotals[field] : null);
    return `<div class="stat-sub">${p ? `占全部 ${p}` : '该书独立口径'}</div>`;
  };

  box.innerHTML = `
    <div class="stat">
      <div class="stat-label">总字数</div>
      <div class="stat-num">${fmtNum(t.words)}</div>
      ${sub('words', t.diffWords)}
    </div>
    <div class="stat">
      <div class="stat-label">总收藏</div>
      <div class="stat-num">${fmtNum(t.collects)}</div>
      ${sub('collects', t.diffCollects)}
    </div>
    <div class="stat">
      <div class="stat-label">总订阅</div>
      <div class="stat-num">${fmtNum(t.totalSubs)}</div>
      ${sub('totalSubs', t.diffTotalSubs)}
    </div>
    <div class="stat">
      <div class="stat-label">当日新增订阅</div>
      <div class="stat-num">${fmtNum(t.newSubs)}</div>
      ${single ? sub('newSubs') : '<div class="stat-sub">全部作品合计</div>'}
    </div>
  `;
}

function sumDiff(diff) {
  if (diff == null) return '<div class="stat-sub">首次采集，明日可对比</div>';
  if (diff === 0) return '<div class="stat-sub">较上次持平</div>';
  const up = diff > 0;
  return `<div class="stat-sub ${up ? 'up' : 'down'}">${up ? '▲ +' : '▼ '}${fmtNum(diff)}</div>`;
}

/** 书籍卡。每个卡片可一键切到只看这本 */
function renderBookCards(box, books, isSingle) {
  box.innerHTML = books.map((b) => `
    <div class="book-card">
      <div class="book-card-head">
        <span class="book-card-name">《${escapeHtml(b.name)}》</span>
        <span class="badge">${escapeHtml(b.status || '')}</span>
        <span class="book-card-chapter">${escapeHtml(b.maxSubChapter || '')}</span>
        ${isSingle ? '' : `<button class="link-btn" data-book="${escapeHtml(String(b.bookId))}">只看这本</button>`}
      </div>
      <div class="metrics">
        <div class="metric">
          <div class="metric-label">总字数</div>
          <div class="metric-value">${fmtNum(b.words)}</div>
          ${diffBit(b.diff ? b.diff.words : null)}
        </div>
        <div class="metric">
          <div class="metric-label">收藏</div>
          <div class="metric-value">${fmtNum(b.collects)}</div>
          ${diffBit(b.diff ? b.diff.collects : null)}
        </div>
        <div class="metric">
          <div class="metric-label">新增订阅</div>
          <div class="metric-value">${fmtNum(b.newSubs)}</div>
          ${pctBit(b.newSubsPct)}
        </div>
        <div class="metric">
          <div class="metric-label">章节均订</div>
          <div class="metric-value">${fmtNum(b.avgSubs)}</div>
          ${pctBit(b.avgSubsPct)}
        </div>
        <div class="metric">
          <div class="metric-label">总订阅</div>
          <div class="metric-value">${fmtNum(b.totalSubs)}</div>
          ${diffBit(b.diff ? b.diff.totalSubs : null)}
        </div>
        <div class="metric">
          <div class="metric-label">日均追订</div>
          <div class="metric-value">${fmtNum(b.dailyChase)}</div>
          ${pctBit(b.dailyChasePct)}
        </div>
      </div>
    </div>
  `).join('');
}

/** 单本视图下的补充信息：月更新、更新天数、满勤、断更、订阅最高的一章 */
function renderSingleExtra(box, b) {
  if (!b) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="extra-title">《${escapeHtml(b.name)}》的其他指标</div>
    <div class="extra-grid">
      <div class="extra-item">
        <div class="extra-label">本月更新</div>
        <div class="extra-value">${escapeHtml(b.monthWords || '—')}</div>
      </div>
      <div class="extra-item">
        <div class="extra-label">更新天数</div>
        <div class="extra-value">${b.updateDays == null ? '—' : escapeHtml(String(b.updateDays)) + ' 天'}</div>
      </div>
      <div class="extra-item">
        <div class="extra-label">满勤</div>
        <div class="extra-value">${escapeHtml(b.fullDays || '—')}</div>
      </div>
      <div class="extra-item">
        <div class="extra-label">断更</div>
        <div class="extra-value">${b.missDays == null ? '—' : escapeHtml(String(b.missDays)) + ' 天'}</div>
      </div>
      <div class="extra-item">
        <div class="extra-label">订阅最高单章</div>
        <div class="extra-value is-text" title="${escapeHtml(b.maxSubChapter || '')}">${
          b.maxSub == null ? '—' : fmtNum(b.maxSub) + ' 订阅'
        }</div>
      </div>
    </div>
  `;
}

$('#boardBook').addEventListener('change', (e) => {
  boardBookId = e.target.value || '';
  renderBoard();
});

// 书籍卡上的「只看这本」：事件委托，避免每次重渲染都要重新绑定
$('#boardBooks').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-book]');
  if (!btn) return;
  boardBookId = btn.dataset.book;
  renderBoard();
});

$('#btnPrevDay').addEventListener('click', () => {
  const snap = currentSnapshot();
  if (!snap) return;
  const older = snapshots.filter((s) => s.day < snap.day);
  if (!older.length) return;
  viewDay = older[older.length - 1].day;
  renderBoard();
  // 已在最早一天则按钮自动隐藏
  const nowSnap = currentSnapshot();
  const stillOlder = snapshots.filter((s) => s.day < nowSnap.day);
  $('#btnPrevDay').textContent = stillOlder.length ? '再往前一天' : '已是最早';
});

$('#btnRefreshStats').addEventListener('click', () => captureAndSave(false));

/** 采集并入库。silent=true 时不打断界面（用于每日 6 点自动更新） */
async function captureAndSave(silent) {
  if (statsBusy) return;
  statsBusy = true;
  const btn = $('#btnRefreshStats');
  const notice = $('#boardNotice');

  if (!silent) {
    btn.disabled = true;
    btn.textContent = '采集中…';
    notice.hidden = false;
    notice.classList.remove('is-error');
    notice.textContent = '准备中…';
  }

  try {
    const snap = await window.Stats.captureSnapshot({
      onProgress: (p) => { if (!silent) notice.textContent = p.text || '采集中…'; },
    });
    snapshots = window.Stats.mergeSnapshot(snapshots, snap);
    viewDay = snap.day;
    await window.api.data.write('stats-snapshots.json', { snapshots });
    renderBoard();

    const prev = window.Stats.previousSnapshot(snapshots, snap.day);
    const msg = prev
      ? `采集完成：${snap.day}，已与 ${prev.day} 对比。`
      : `采集完成：${snap.day}。这是第一份基准，明天 06:00 后再采集即可看到日间变化。`;

    if (!silent) {
      notice.hidden = false;
      notice.textContent = msg;
    } else {
      notice.hidden = false;
      notice.classList.remove('is-error');
      notice.textContent = '已按每日 06:00 结算自动更新 · ' + msg;
    }
  } catch (err) {
    if (!silent) {
      notice.hidden = false;
      notice.classList.add('is-error');
      notice.textContent = '采集失败：' + (err.message || err);
    } else {
      console.warn('[auto-capture] 跳过：', err.message || err);
    }
  } finally {
    statsBusy = false;
    if (!silent) {
      btn.disabled = false;
      btn.textContent = '刷新数据';
    }
  }
}

// 每日 06:00 自动更新：已过边界且当天还没快照时补采一次。
// 前提是用户已建立过基准（至少一份快照），避免首次启动就被自动流程惊到。
let lastAutoDay = null;

async function tickAutoCapture() {
  if (!snapshots.length) return;
  if (statsBusy) return;
  // 正在导出章节时不要抢平台视图，否则两边会互相打断
  if (exportBusy) return;
  if (!window.Stats.isAfterBoundary()) return;
  const day = window.Stats.statDay();
  if (snapshots.some((s) => s.day === day)) return;
  if (lastAutoDay === day) return;
  lastAutoDay = day;
  await captureAndSave(true);
}

setInterval(() => { tickAutoCapture().catch(() => {}); }, 60 * 1000);
setTimeout(() => { tickAutoCapture().catch(() => {}); }, 6000);

// ------------------------------------------------------------ 反馈信号

let signalResult = null;
let reviewMode = 'review';

function runSignals() {
  if (!crawlData || !crawlData.items) { signalResult = null; return; }
  signalResult = window.Signals.extract(scopedItems());
}

function highlight(text, word) {
  const safe = escapeHtml(text);
  if (!word) return safe;
  const w = escapeHtml(word);
  return safe.split(w).join(`<span class="signal-hl">${w}</span>`);
}

function renderSignals() {
  const box = $('#signalList');
  if (!signalResult || !signalResult.byType.length) {
    box.innerHTML = `<div class="empty">
      <div class="empty-title">未发现明显反馈信号</div>
      <p>当前评论里没有检测到章节屏蔽、错字指正、断更质疑等关键词。</p>
    </div>`;
    return;
  }

  box.innerHTML = signalResult.byType.map((t) => `
    <div class="signal-group">
      <div class="signal-head">
        <span class="signal-name">${escapeHtml(t.name)}</span>
        <span class="signal-count">${t.count}</span>
        <span class="hint-line">${escapeHtml(t.hint)}</span>
      </div>
      <div class="signal-items">
        ${t.items.slice(0, 40).map((s) => `
          <div class="signal-row">
            <div class="signal-row-nick">${escapeHtml(s.nickname || '匿名')}</div>
            <div class="signal-row-body">
              <div class="signal-row-text">${highlight(s.content, s.hitWord)}</div>
              <div class="signal-row-meta">${escapeHtml(s.bookName)} · ${escapeHtml(s.chapterName)} · ${escapeHtml(s.time)}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

$('#reviewMode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  reviewMode = b.dataset.mode;
  $('#reviewMode').querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x === b));

  const isReview = reviewMode === 'review';
  $('#reviewTools').hidden = !isReview;
  $('#reviewList').hidden = !isReview;
  $('#signalList').hidden = isReview;
  $('#reviewMore').hidden = true;

  if (isReview) renderList();
  else renderSignals();
});

// ------------------------------------------------------------ 平台榜单

let rankRecords = [];
let rankViewDay = null;

const RANK_LABELS = {
  click: { week: '点击榜 · 周榜', month: '点击榜 · 月榜' },
  collect: { week: '收藏榜 · 周榜', month: '收藏榜 · 月榜' },
};

function currentRankRecord() {
  if (!rankRecords.length) return null;
  if (rankViewDay) {
    const found = rankRecords.find((r) => r.date === rankViewDay);
    if (found) return found;
  }
  return rankRecords[rankRecords.length - 1];
}

function rankCardHtml(key, period, list) {
  const rows = list.map((x) => {
    let diff = '<span class="rank-diff flat">—</span>';
    if (x.isNew) {
      diff = '<span class="rank-diff new">NEW</span>';
    } else if (x.rankDiff != null && x.rankDiff !== 0) {
      const up = x.rankDiff > 0;
      diff = `<span class="rank-diff ${up ? 'up' : 'down'}">${up ? '▲' : '▼'}${Math.abs(x.rankDiff)}</span>`;
    }
    const numTxt = x.num != null
      ? (x.num >= 10000 ? (x.num / 10000).toFixed(1) + '万' : String(x.num))
      : (x.raw || '');
    const tip = x.numDiff != null && x.numDiff !== 0
      ? `数值 ${x.numDiff > 0 ? '+' : ''}${x.numDiff}`
      : '';
    // 书名直接链到刺猬猫的书页。有地址才做成按钮，老数据缺 url 时退回纯文本，
    // 免得点上去没反应还以为是坏的。
    const hasUrl = /^https?:\/\//i.test(String(x.url || ''));
    const titleHtml = hasUrl
      ? `<button class="rank-title rank-link" type="button" title="${escapeHtml(x.title)}${tip ? ' · ' + escapeHtml(tip) : ''} · 点击在浏览器打开"`
        + ` data-url="${escapeHtml(x.url)}">${escapeHtml(x.title)}</button>`
      : `<span class="rank-title" title="${escapeHtml(tip)}">${escapeHtml(x.title)}</span>`;
    return `<div class="rank-row ${x.rank === 1 ? 'is-top1' : ''}" title="${escapeHtml(tip)}">
      <span class="rank-no">${x.rank != null ? x.rank : ''}</span>
      ${titleHtml}
      <span class="rank-num">${escapeHtml(numTxt)}</span>
      ${diff}
    </div>`;
  }).join('');

  return `<div class="rank-card">
    <div class="rank-card-head">
      <span class="rank-card-name">${RANK_LABELS[key][period]}</span>
      <span class="rank-card-meta">前 ${list.length} 名</span>
    </div>
    <div class="rank-list">${rows || '<div class="rank-row"><span class="rank-title">暂无数据</span></div>'}</div>
  </div>`;
}

function renderRank() {
  const rec = currentRankRecord();
  const grid = $('#rankGrid');
  const empty = $('#rankEmpty');

  if (!rec) {
    empty.hidden = false;
    grid.innerHTML = '';
    $('#rankDay').textContent = '尚无榜单数据';
    $('#rankSub').textContent = '抓取一次即可看到点击榜与收藏榜，排名变化需连续两天';
    $('#btnPrevRank').hidden = true;
    return;
  }

  empty.hidden = true;
  const prev = window.Rank.previousRecord(rankRecords, rec.date);
  const data = window.Rank.annotate(rec, prev);

  $('#rankDay').textContent = `榜单 ${rec.date}`;

  if (prev) {
    const gap = Math.round((new Date(rec.date) - new Date(prev.date)) / 86400000);
    // 间隔过久时榜单几乎全换血，全是 NEW 反而没有信息量，需把间隔标出来
    $('#rankSub').textContent = gap > 14
      ? `对比基准 ${prev.date}（间隔 ${gap} 天，榜单已大幅更替）`
      : `排名对比基准 ${prev.date}`;
  } else {
    $('#rankSub').textContent = '首次抓取 · 明天再抓即可看到排名升降';
  }

  const older = rankRecords.filter((r) => r.date < rec.date);
  $('#btnPrevRank').hidden = older.length === 0;
  $('#btnPrevRank').textContent = '看前一天';

  grid.innerHTML = ['click', 'collect']
    .map((key) => ['week', 'month'].map((p) => rankCardHtml(key, p, data[key][p] || [])).join(''))
    .join('');
}

// 书名点击：交给系统浏览器打开刺猬猫书页。
// 用 button + data-url 而不是 <a href>——后者会让渲染进程整个导航走，界面就没了。
$('#rankGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-url]');
  if (!btn) return;
  const url = btn.dataset.url;
  if (!/^https?:\/\//i.test(url)) return;
  window.api.app.openExternal(url);
});

$('#btnPrevRank').addEventListener('click', () => {
  const rec = currentRankRecord();
  if (!rec) return;
  const older = rankRecords.filter((r) => r.date < rec.date);
  if (!older.length) return;
  rankViewDay = older[older.length - 1].date;
  renderRank();
});

$('#btnRefreshRank').addEventListener('click', async () => {
  const btn = $('#btnRefreshRank');
  const notice = $('#rankNotice');
  if (btn.disabled) return;

  btn.disabled = true;
  btn.textContent = '抓取中…';
  notice.hidden = false;
  notice.classList.remove('is-error');
  notice.textContent = '正在抓取榜单页…';

  try {
    const html = await window.api.rank.fetch();
    const parsed = window.Rank.parseRankHtml(html);
    const total = ['click', 'collect'].reduce(
      (s, k) => s + parsed[k].week.length + parsed[k].month.length, 0
    );
    if (!total) throw new Error('未解析到榜单条目，页面结构可能已变更');

    const date = window.Rank.today();
    const rec = Object.assign({ date, fetchedAt: new Date().toISOString() }, parsed);
    rankRecords = window.Rank.mergeRecord(rankRecords, rec);
    rankViewDay = date;
    await window.api.data.write('rank-history.json', { records: rankRecords });
    renderRank();

    const prev = window.Rank.previousRecord(rankRecords, date);
    notice.textContent = prev
      ? `已更新 ${date}，共 ${total} 条，已与 ${prev.date} 对比。`
      : `已更新 ${date}，共 ${total} 条。这是第一份基准，明天再抓即可看到排名升降。`;
  } catch (err) {
    notice.hidden = false;
    notice.classList.add('is-error');
    notice.textContent = '抓取失败：' + (err.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新榜单';
  }
});

// ------------------------------------------------------------ 章节导出

let exportBooks = [];
let exportChapters = [];
let exportSelected = new Set();
let exportBusy = false;
/** 当前选中的作品 { bookId, name } */
let exportBookMeta = null;
/** 上一次已生成但未落盘的正文，取消保存后可直接重存，不必重读一遍 */
let lastExport = null;
/** 最近一次正文归档的结果，用于界面提示 */
let archiveState = null;

function showExportNotice(html, isError) {
  const n = $('#exportNotice');
  n.hidden = false;
  n.classList.toggle('is-error', !!isError);
  n.innerHTML = html;
}

function hideExportNotice() {
  $('#exportNotice').hidden = true;
}

function setExportProgress(pct, text) {
  $('#exportProgress').hidden = false;
  if (pct != null) $('#exportBar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('#exportText').textContent = text || '';
}

function renderExportBooks() {
  const sel = $('#exportBook');
  if (!exportBooks.length) {
    sel.innerHTML = '<option value="">尚未读取作品</option>';
    sel.disabled = true;
    $('#btnExportChapters').disabled = true;
    return;
  }
  sel.innerHTML = exportBooks
    .map((b) => `<option value="${escapeHtml(b.bookId)}">《${escapeHtml(b.name)}》</option>`)
    .join('');
  sel.disabled = false;
  $('#btnExportChapters').disabled = false;
}

/** 读取作品清单。silent=true 时失败不打扰用户（进页面自动预读用） */
async function loadExportBooks(silent) {
  const btn = $('#btnExportBooks');
  if (exportBusy) return;
  btn.disabled = true;
  btn.textContent = '读取中…';
  if (!silent) hideExportNotice();

  try {
    const books = await window.Exporter.listBooks();
    exportBooks = books;
    renderExportBooks();
    if (!silent) {
      showExportNotice(`已读取 ${books.length} 部作品，选择一本后点「读取章节」。`);
    }
  } catch (err) {
    const msg = String(err.message || err);
    if (silent) return;
    showExportNotice(
      `读取作品失败：${escapeHtml(msg)}<br>请先点右上角「打开作者后台」完成登录。`,
      true
    );
  } finally {
    btn.disabled = false;
    btn.textContent = '读取作品列表';
  }
}

function updateExportBar() {
  const n = exportSelected.size;
  const total = exportChapters.length;
  $('#exportHint').innerHTML = n
    ? `已选 <strong>${n}</strong> / ${total} 章`
    : `已选 <strong>0</strong> 章 · 未勾选时用「一键全部导出」`;
  $('#btnExportSelected').disabled = exportBusy || n === 0;
  $('#btnExportAll').disabled = exportBusy || total === 0;
  $('#btnExportChapters').disabled = exportBusy || !exportBooks.length;
  $('#btnExportBooks').disabled = exportBusy;

  const all = $('#chapterAll');
  all.checked = total > 0 && n === total;
  all.indeterminate = n > 0 && n < total;
}

function renderChapterList() {
  const box = $('#chapterList');
  $('#chapterCount').textContent = `共 ${exportChapters.length} 章`;

  if (!exportChapters.length) {
    box.innerHTML = '<div class="empty is-tight"><p>还没有章节</p></div>';
    updateExportBar();
    return;
  }

  box.innerHTML = exportChapters.map((c) => {
    const cid = String(c.chapterId);
    const on = exportSelected.has(cid);
    const draft = /草稿|未发布|审核|下架/.test(c.status || '');
    return `
      <label class="chapter-row${on ? ' is-checked' : ''}">
        <input type="checkbox" data-cid="${escapeHtml(cid)}"${on ? ' checked' : ''} />
        <span class="chapter-no">${c.index}</span>
        <span class="chapter-title" title="${escapeHtml(c.title || '')}">${escapeHtml(c.title || '')}</span>
        <span class="chapter-words">${c.words == null ? '' : `${fmtNum(c.words)} 字`}</span>
        <span class="chapter-status${draft ? ' is-draft' : ''}">${escapeHtml(c.status || '')}</span>
      </label>
    `;
  }).join('');

  updateExportBar();
}

async function loadExportChapters() {
  const bookId = $('#exportBook').value;
  if (!bookId || exportBusy) return;

  const meta = exportBooks.find((b) => String(b.bookId) === String(bookId));
  exportBookMeta = { bookId, name: meta ? meta.name : bookId };
  exportChapters = [];
  exportSelected = new Set();
  exportBusy = true;

  $('#chapterPanel').hidden = false;
  $('#exportResult').hidden = true;
  lastExport = null;
  hideExportNotice();
  setExportProgress(0, '读取章节列表…');
  updateExportBar();

  try {
    const res = await window.Exporter.listChapters(bookId, {
      onProgress: (p) => {
        setExportProgress(null, `读取章节列表 · 第 ${p.page} 页 · 已读到 ${p.count} 章`);
      },
    });

    if (!res.chapters.length) {
      // 结构对不上时把整页 HTML 存下来，便于按真实结构补解析规则
      if (res.html) {
        try {
          const p = await window.api.diag.save('export-chapter-list.html', res.html);
          showExportNotice(
            `没有读到任何章节，页面结构可能已变更。<br>已保存页面快照：<span class="mono">${escapeHtml(p)}</span>`,
            true
          );
        } catch (_) {
          showExportNotice('没有读到任何章节，页面结构可能已变更。', true);
        }
      } else {
        showExportNotice('没有读到任何章节，页面结构可能已变更。', true);
      }
      $('#exportProgress').hidden = true;
      return;
    }

    exportChapters = res.chapters;
    renderChapterList();

    const words = exportChapters.reduce((s, c) => s + (c.words || 0), 0);
    setExportProgress(100, `共 ${exportChapters.length} 章${words ? ` · 约 ${fmtNum(words)} 字` : ''}`);

    // 后台没按 URL 上的 book_id 切书时，页面上的选择器会停在别的作品——
    // 这种「看起来成功、其实抓错书」的情况必须显式提示
    if (res.pageBookId && String(res.pageBookId) !== String(bookId)) {
      showExportNotice(
        `注意：后台页面当前显示的作品编号是 ${escapeHtml(res.pageBookId)}，`
        + `与你选择的 ${escapeHtml(String(bookId))} 不一致。`
        + `请核对下面这些章节是否属于《${escapeHtml(exportBookMeta.name)}》再导出。`,
        true
      );
    } else {
      showExportNotice(
        `已读取《${escapeHtml(exportBookMeta.name)}》 ${exportChapters.length} 章`
        + `${words ? `，合计约 ${fmtNum(words)} 字` : ''}。勾选需要的章节，或直接点「一键全部导出」。`
      );
    }
    setTimeout(() => { if (!exportBusy) $('#exportProgress').hidden = true; }, 1600);
  } catch (err) {
    showExportNotice('读取章节失败：' + escapeHtml(String(err.message || err)), true);
    $('#exportProgress').hidden = true;
  } finally {
    exportBusy = false;
    updateExportBar();
  }
}

/** 把已组装好的正文交给保存对话框 */
/**
 * 把刚读到的正文归档一份，供 AI 使用。
 * 章号取列表里的 index，字数取列表里的 words（正文里没有这两项）。
 */
async function archiveChapterText(chapters, list) {
  if (!exportBookMeta || !chapters.length) return;
  try {
    const byId = new Map((list || []).map((c) => [String(c.chapterId), c]));
    const payload = chapters.map((c, i) => {
      const meta = byId.get(String(c.chapterId));
      return {
        index: (meta && meta.index) || i + 1,
        title: c.title,
        words: (meta && meta.words) || (c.content || '').length,
        content: c.content,
      };
    });
    const r = await window.api.library.archive({
      bookId: exportBookMeta.bookId,
      name: exportBookMeta.name,
      chapters: payload,
    });
    archiveState = r && r.ok
      ? { ok: true, chapters: r.chapters, words: r.words }
      : { ok: false, error: (r && r.error) || '归档失败' };
  } catch (err) {
    archiveState = { ok: false, error: String((err && err.message) || err) };
  }
  renderArchiveHint();
}

/** 导出页底部那行小字：告诉用户正文已经留档、AI 能读 */
function renderArchiveHint() {
  const box = $('#archiveHint');
  if (!box) return;
  if (!archiveState) { box.hidden = true; return; }
  box.hidden = false;
  box.className = archiveState.ok ? 'hint-line' : 'hint-line is-error';
  box.textContent = archiveState.ok
    ? `正文已归档 ${archiveState.chapters} 章（约 ${archiveState.words} 字），可在「设置 → AI 接入」让 AI 读取`
    : `归档失败：${archiveState.error}（不影响 TXT 导出）`;
}

async function saveExport(content, defaultName) {
  const saved = await window.api.file.saveText({
    defaultName,
    defaultDir: window.Prefs ? window.Prefs.get('exportDir', '') : '',
    content,
  });
  if (!saved.canceled && saved.dir && window.Prefs) window.Prefs.set('exportDir', saved.dir);
  return saved;
}

function renderExportResult(saved, result, cancelled) {
  const box = $('#exportResult');
  const warn = result.failed.length > 0;
  box.hidden = false;
  box.classList.toggle('is-warn', warn);

  if (cancelled) {
    box.innerHTML = `
      <div class="row"><strong>已生成，但还没有保存</strong>
        <span>${result.chapters.length} 章正文已在内存里，可以换个位置再存一次。</span></div>
      <button class="btn ghost" id="btnExportResave" type="button">重新选择保存位置</button>
    `;
    return;
  }

  const kb = (saved.bytes / 1024).toFixed(1);
  const failHtml = warn
    ? `<div style="margin-top:6px">有 ${result.failed.length} 章没读到正文（其余章节已正常导出）：</div>
       <ul class="fail-list">${result.failed.slice(0, 12).map((f) => (
         `<li>${escapeHtml(f.title || '')} · ${escapeHtml(f.error || '')}</li>`
       )).join('')}${result.failed.length > 12 ? `<li>…另有 ${result.failed.length - 12} 章</li>` : ''}</ul>`
    : '';

  box.innerHTML = `
    <div class="row"><strong>导出完成</strong>
      <span>${result.chapters.length} 章 · ${kb} KB${result.mode === 'nav' ? ' · 逐页读取' : ''}</span></div>
    <div class="path">${escapeHtml(saved.filePath)}</div>
    ${failHtml}
    <button class="btn ghost" id="btnExportReveal" type="button">打开所在文件夹</button>
    <button class="btn ghost" id="btnExportOpen" type="button">用默认程序打开</button>
  `;
  box.dataset.path = saved.filePath;
}

async function runExport(list) {
  if (exportBusy || !list.length || !exportBookMeta) return;

  exportBusy = true;
  updateExportBar();
  $('#exportResult').hidden = true;
  lastExport = null;
  hideExportNotice();
  setExportProgress(0, '准备读取正文…');

  try {
    const result = await window.Exporter.readContents(exportBookMeta, list, {
      onProgress: (p) => {
        if (p.phase === 'probe') {
          setExportProgress(0, '正在检测读取方式…');
        } else if (p.phase === 'chapter') {
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          setExportProgress(pct, `读取正文 ${p.done}/${p.total} · ${p.title || ''}`);
        }
      },
    });

    if (!result.chapters.length) {
      const first = result.failed.length ? (result.failed[0].error || '没有读到正文') : '没有读到正文';
      throw new Error(`${first}。已把这一章的原始页面存进诊断目录，可据此修正解析规则`);
    }

    // 归档一份正文到 data/library：AI 读剧情、接口按章取都靠它。
    // 不阻塞导出：失败只提示，不影响 TXT 保存。
    archiveChapterText(result.chapters, list);

    const content = window.Exporter.buildTxt(exportBookMeta, result.chapters);
    const suffix = list.length === exportChapters.length ? '全本' : `节选${result.chapters.length}章`;
    const defaultName = `《${window.Exporter.safeName(exportBookMeta.name)}》${suffix}.txt`;
    lastExport = { content, defaultName, result };

    setExportProgress(100, '正在写入文件…');
    const saved = await saveExport(content, defaultName);
    renderExportResult(saved, result, saved.canceled);
    $('#exportProgress').hidden = true;
  } catch (err) {
    showExportNotice('导出失败：' + escapeHtml(String(err.message || err)), true);
    setExportProgress(0, '');
    $('#exportProgress').hidden = true;
  } finally {
    exportBusy = false;
    updateExportBar();
  }
}

$('#btnExportBooks').addEventListener('click', () => loadExportBooks(false));
$('#btnExportChapters').addEventListener('click', loadExportChapters);

$('#exportBook').addEventListener('change', () => {
  exportChapters = [];
  exportSelected = new Set();
  $('#chapterPanel').hidden = true;
  $('#exportResult').hidden = true;
  hideExportNotice();
});

$('#chapterList').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-cid]');
  if (!cb) return;
  const cid = cb.dataset.cid;
  if (cb.checked) exportSelected.add(cid);
  else exportSelected.delete(cid);
  cb.closest('.chapter-row').classList.toggle('is-checked', cb.checked);
  updateExportBar();
});

$('#chapterAll').addEventListener('change', (e) => {
  if (e.target.checked) exportChapters.forEach((c) => exportSelected.add(String(c.chapterId)));
  else exportSelected.clear();
  renderChapterList();
});

$('#btnChapterInvert').addEventListener('click', () => {
  const next = new Set();
  exportChapters.forEach((c) => {
    const cid = String(c.chapterId);
    if (!exportSelected.has(cid)) next.add(cid);
  });
  exportSelected = next;
  renderChapterList();
});

$('#btnChapterNone').addEventListener('click', () => {
  exportSelected.clear();
  renderChapterList();
});

$('#btnExportAll').addEventListener('click', () => {
  if (!exportChapters.length) return;
  runExport(exportChapters.slice());
});

$('#btnExportSelected').addEventListener('click', () => {
  const list = exportChapters.filter((c) => exportSelected.has(String(c.chapterId)));
  if (!list.length) return;
  runExport(list);
});

// 结果区里的按钮：事件委托，避免每次重渲染都重新绑定
$('#exportResult').addEventListener('click', async (e) => {
  const resave = e.target.closest('#btnExportResave');
  if (resave && lastExport) {
    resave.disabled = true;
    try {
      const saved = await saveExport(lastExport.content, lastExport.defaultName);
      if (!saved.canceled) {
        renderExportResult(saved, lastExport.result, false);
      }
    } catch (_) { /* 用户取消就保持原样 */ }
    resave.disabled = false;
    return;
  }

  if (e.target.closest('#btnExportReveal')) {
    const p = $('#exportResult').dataset.path;
    if (p) window.api.app.reveal(p);
  } else if (e.target.closest('#btnExportOpen')) {
    const p = $('#exportResult').dataset.path;
    if (p) window.api.app.openPath(p);
  }
});

// ------------------------------------------------------------ 处置（原执行台，已并入评论审查）

let execSample = null;
let execSlip = null;
let execMode = 'manual';
let execBusy = false;
let execPending = null;

function execNotice(text, isError) {
  const n = $('#execPoolNotice');
  n.hidden = false;
  n.classList.toggle('is-error', !!isError);
  n.innerHTML = text;
}

function execPool() {
  if (!reviewResult) return [];
  // 已处理、已剔除的都不再出现在待处理池里
  return reviewResult.items.filter((x) => !x.handled && !dismissed.has(String(x.id)));
}

function renderExecPool() {
  // 计数已经并入统计卡（待处理），这里只负责刷新批量条
  renderBatchBar();
}

function suggestAction(x) {
  // 命中项理论上都带 ruleId，但历史数据 / 手写样例可能缺，这里不能想当然
  const ids = (x.hits || []).map((h) => String((h && h.ruleId) || ''));
  const has = (id) => ids.indexOf(id) >= 0;

  if (ids.some((id) => id.indexOf('ad-') === 0)) return '建议删除：引流或外链，留着会把读者带走';
  if (has('attack') || has('attack-target')) return '建议删除，必要时禁言：属于人身攻击';
  if (has('accuse')) return '建议先核实：抄袭 / 洗稿类指控牵扯名誉，确认后再说';
  if (has('spam-phrase') || has('spam-char') || has('behavior-flood') || has('behavior-dup')) {
    return '建议禁言：刷屏 / 复读，单独删一条还会继续发';
  }
  if (has('spoiler')) return '建议删除：剧透会破坏其他读者的阅读体验';
  if (has('attack-soft')) return '建议先看原文：属于攻击性表达，看语气再决定';
  if (has('negative-strict') || has('negative')) return '多半是正常吐槽：负面评价本身不构成违规';
  if (x.level === 'none') return '无标记：多数是正常吐槽，可以不处理';
  return '建议先看原文再决定';
}

function renderExecSample() {
  const x = execSample;
  if (!x) return;
  const cls = x.level === 'high' ? 'is-high' : x.level === 'mid' ? 'is-mid' : '';
  const badge = x.level === 'high'
    ? `<span class="badge high">高风险 ${x.score}</span>`
    : x.level === 'mid'
      ? `<span class="badge mid">中风险 ${x.score}</span>`
      : '<span class="badge">无标记</span>';
  const hits = (x.hits || []).length
    ? `<div class="exec-hits">${x.hits.map((h) => `<span class="exec-hit">${escapeHtml(h.name)} · ${escapeHtml(h.matched)}</span>`).join('')}</div>`
    : '';

  $('#execSampleTag').textContent = x.level === 'none' ? '无标记' : '有标记';
  $('#execSampleTag').className = 'tag' + (x.level === 'high' ? ' warn' : '');
  $('#execSample').innerHTML = `
    <div class="exec-sample ${cls}">
      <div class="exec-sample-head">
        <span class="exec-sample-nick">${escapeHtml(x.nickname || '未知读者')}</span>
        <span class="badge">ID ${escapeHtml(String(x.readerId || '—'))}</span>
        ${badge}
        <span>${escapeHtml(x.time || '')}</span>
      </div>
      <div class="exec-sample-body">${escapeHtml(x.content || '（空）')}</div>
      ${hits}
      <div class="exec-sample-foot">
        <span>${escapeHtml(x.bookName || '')}</span>
        <span>${escapeHtml(x.chapterName || '')}</span>
        <span>${escapeHtml(x.paraPos || '')}</span>
      </div>
    </div>
    <p class="muted" style="margin-top:12px">${escapeHtml(suggestAction(x))}</p>
  `;
}

function renderExecSlip() {
  const s = execSlip;
  if (!s) return;
  const rows = [
    ['间贴编号', `<span class="mono">${escapeHtml(s.commentId)}</span>`],
    ['读者', `${escapeHtml(s.nickname)} <span class="mono">${escapeHtml(s.readerId || '—')}</span>`],
    ['作品', `${escapeHtml(s.bookName || '—')} <span class="mono">${escapeHtml(s.bookId)}</span>`],
    ['章节', `${escapeHtml(s.chapterName || '—')} <span class="mono">${escapeHtml(s.chapterId)}</span>`],
    ['段落', escapeHtml(s.paraPos || '—')],
    ['时间', escapeHtml(s.time || '—')],
    ['审查', `${s.score} 分 · ${s.hits.length ? escapeHtml(s.hits.join('；')) : '无命中'}`],
  ];
  $('#execSlip').innerHTML = `<div class="slip-grid">${rows
    .map(([k, v]) => `<div class="slip-key">${k}</div><div class="slip-val">${v}</div>`)
    .join('')}</div>`;
}

function renderExecPreview() {
  const pre = $('#execPreview');
  if (!execSlip) {
    pre.textContent = '选一条评论后，这里会显示将要发出的确切请求。';
    $('#execPreviewTag').textContent = '尚未生成';
    return;
  }
  const lines = [
    `# ${execSlip.nickname} · ${execSlip.content.slice(0, 40)}`,
    '',
    '## 删除（POST）',
    window.Executor.requestPreview(execSlip, 'delete'),
    '',
    '## 禁言（GET，跨作品生效）',
    window.Executor.requestPreview(execSlip, 'mute'),
  ];
  pre.textContent = lines.join('\n');
  $('#execPreviewTag').textContent = '已生成';
}

function setExecResult(html, isError, isBusyText) {
  const box = $('#execResult');
  box.hidden = false;
  box.classList.toggle('is-error', !!isError);
  box.innerHTML = isBusyText ? `<span class="hint-line">${html}</span>` : html;
}

function execSetPanels(show) {
  const box = $('#execPanel');
  if (box) box.hidden = !show;
}

function execSetMode(mode) {
  execMode = mode;
  $$('#execMode button').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
  $('#execManual').hidden = mode !== 'manual';
  $('#execAuto').hidden = mode !== 'auto';
  $('#execConfirm').hidden = true;
  execPending = null;
}

function showExecSample(x) {
  execSample = x;
  execSlip = window.Executor.buildSlip(x);
  execSlip.pageUrl = window.Executor.pageUrl(execSlip);

  $('#execPoolNotice').hidden = true;
  $('#execResult').hidden = true;
  $('#execConfirm').hidden = true;
  execSetPanels(true);
  // 默认就是「交给工具」，可选「我自己来」
  execSetMode('auto');
  renderExecSample();
  renderExecSlip();
  renderExecPreview();

  const panel = $('#execPanel');
  if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


/** 处理完就地标记，避免下一条又抽到它 */
function markHandled(slip, action) {
  const hit = (reviewResult && reviewResult.items || []).find(
    (x) => String(x.id) === String(slip.commentId)
  );
  if (!hit) return;
  hit.handled = true;
  hit.handledAt = new Date().toISOString();
  hit.handledBy = action;
  renderExecPool();

  // 落盘的是「已处理」标记，评论原文与审查结果都保留，方便日后回查
  if (crawlData && Array.isArray(crawlData.items)) {
    const raw = crawlData.items.find((x) => String(x.id) === String(slip.commentId));
    if (raw) {
      raw.handled = true;
      raw.handledAt = hit.handledAt;
      raw.handledBy = action;
    }
  }
  try { window.api.data.write('tsukkomi.json', crawlData); } catch (_) { /* ignore */ }
}

async function refreshExecLog() {
  const box = $('#execLog');
  if (!box) return;
  let entries = [];
  try { entries = await window.api.exec.log(); } catch (_) { entries = []; }
  if (!entries.length) {
    box.innerHTML = '<div class="hint-line">还没有执行过任何动作</div>';
    return;
  }
  const label = window.Executor.ACTION_LABEL;
  box.innerHTML = entries.slice(-20).reverse().map((e) => {
    const t = new Date(e.at);
    const p = (n) => String(n).padStart(2, '0');
    const when = `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
    return `<div class="exec-log-row ${e.ok ? 'is-ok' : 'is-bad'}">
      <span class="exec-log-time">${when}</span>
      <span class="exec-log-act">${escapeHtml(label[e.action] || e.action)}</span>
      <span>#${escapeHtml(String((e.target || {}).tsukkomiId || ''))}</span>
      <span class="exec-log-note">${e.ok ? '成功' : '失败'}${e.note ? ' · ' + escapeHtml(e.note) : ''}</span>
    </div>`;
  }).join('');
}

function execConfirmBar(action) {
  const s = execSlip;
  const label = window.Executor.ACTION_LABEL[action] || action;
  const bar = $('#execConfirm');
  bar.hidden = false;
  bar.innerHTML = `
    <div>将执行：<strong>${escapeHtml(label)}</strong> · 间贴 ${escapeHtml(s.commentId)} · 读者 ${escapeHtml(s.nickname)}
      ${action === 'delete' || action === 'block' ? '<br>删除后不可恢复。' : ''}
    </div>
    <div class="actions">
      <button class="btn ghost btn-sm" data-confirm="no" type="button">取消</button>
      <button class="btn danger btn-sm" data-confirm="yes" type="button">确认执行</button>
    </div>
  `;
  execPending = action;
}

async function doExec(action, dryRun) {
  if (!execSlip || execBusy) return;
  execBusy = true;
  $('#execConfirm').hidden = true;
  $$('#execAuto [data-exec]').forEach((b) => { b.disabled = true; });

  try {
    const out = await window.Executor.run(execSlip, action, {
      dryRun: dryRun,
      onStep: (t) => setExecResult(`正在${escapeHtml(t)}…`, false, true),
    });
    const lines = out.steps.map((s) => escapeHtml(
      window.Executor.resultText(s.action, s.res, s.verify)
    ));
    if (out.stopped) lines.push('已在删除失败后停止，没有再对读者执行禁言。');
    setExecResult(lines.join('<br>'), !out.ok && !dryRun);

    if (!dryRun && out.ok) markHandled(execSlip, action);
    if (!dryRun) refreshExecLog();
  } catch (err) {
    setExecResult('执行失败：' + escapeHtml(String(err.message || err)), true);
  } finally {
    execBusy = false;
    $$('#execAuto [data-exec]').forEach((b) => { b.disabled = false; });
    execPending = null;
  }
}

function copyText(text) {
  return new Promise((resolve) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      resolve(ok);
    } catch (_) { resolve(false); }
  });
}


$('#execMode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  execSetMode(b.dataset.mode);
});

$('#btnExecOpenPage').addEventListener('click', () => {
  if (!execSlip) return;
  openBrowser(execSlip.pageUrl);
});

$('#btnExecCopy').addEventListener('click', async () => {
  if (!execSlip) return;
  const ok = await copyText(window.Executor.slipText(execSlip));
  execNotice(ok ? '执行单已复制到剪贴板。' : '复制失败，可以手动选中执行单里的文字。', !ok);
});

$('#execAuto').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-exec]');
  if (!btn || execBusy || !execSlip) return;
  const action = btn.dataset.exec;
  if ($('#execDryRun').checked) {
    doExec(action, true);
  } else {
    execConfirmBar(action);
  }
});

$('#execConfirm').addEventListener('click', (e) => {
  const b = e.target.closest('[data-confirm]');
  if (!b) return;
  if (b.dataset.confirm === 'yes' && execPending) {
    doExec(execPending, false);
  } else {
    $('#execConfirm').hidden = true;
    execPending = null;
  }
});

$('#btnExecLogRefresh').addEventListener('click', refreshExecLog);

// ------------------------------------------------------------ 作者信箱小红点

let inboxBusy = false;

function inboxNotice(html, isError) {
  const n = $('#inboxNotice');
  n.hidden = false;
  n.classList.toggle('is-error', !!isError);
  n.innerHTML = html;
}

async function clearInbox() {
  if (inboxBusy) return;
  inboxBusy = true;
  ['#btnClearInbox', '#btnClearInboxTop'].forEach((sel) => { $(sel).disabled = true; });
  $('#inboxProgress').hidden = false;
  $('#inboxNotice').hidden = true;
  $('#inboxBar').style.width = '8%';
  $('#inboxText').textContent = '正在打开作者信箱…';
  $('#inboxStatus').textContent = '';

  try {
    const res = await window.Inbox.clearAll({
      allPages: $('#inboxAllPages').checked,
      onProgress: (p) => {
        $('#inboxText').textContent = p.text || '';
        $('#inboxBar').style.width = p.phase === 'done' ? '100%' : '60%';
      },
    });

    const cleared = res.pages.reduce((s, p) => s + Math.max(0, (p.before || 0) - (p.after || 0)), 0);
    const guessed = res.pages.some((p) => p.mode === 'all');
    const summary = `共处理 ${res.pages.length} 页，点开 ${res.clicked} 条消息，`
      + (cleared ? `消掉 ${cleared} 个红点。` : '红点数量没有变化。');
    const extra = (guessed
      ? '<br>未能逐行定位未读消息，已改为「逐行展开」——点开即视为已读，效果一样。'
      : '')
      + (!cleared
        ? '<br>若红点仍在，把诊断目录里的 inbox-before.html 发来，可按真实结构补判据。'
        : '');
    inboxNotice(summary + extra, !cleared && res.clicked === 0);
    $('#inboxStatus').textContent = cleared ? `已清除 ${cleared} 个` : '';
    $('#inboxBar').style.width = '100%';
    $('#inboxText').textContent = '完成';
  } catch (err) {
    $('#inboxProgress').hidden = true;
    inboxNotice('清除失败：' + escapeHtml(String(err.message || err))
      + '<br>已把这一页的原始 HTML 存进诊断目录，若结构有变可按它修正。', true);
  } finally {
    inboxBusy = false;
    ['#btnClearInbox', '#btnClearInboxTop'].forEach((sel) => { $(sel).disabled = false; });
  }
}

$('#btnClearInbox').addEventListener('click', clearInbox);
$('#btnClearInboxTop').addEventListener('click', clearInbox);

// ------------------------------------------------------------ 创作中心

let writerBooks = [];
let writerRemoteBooks = [];
let writerEditorBook = null;
let writerChapterId = '';
let writerSaveTimer = null;
let writerDirty = false;
let writerComposing = false;
let writerCompositionStart = '';
let writerCompositionStartMask = [];
let writerBeforeText = '';
let writerBeforeMask = [];
let writerInputType = '';
let writerExcludeInput = false;
let writerSuppressInput = false;
let writerSession = null;
let writerCollapsedVolumes = new Set();
let writerTypedMask = [];
let writerNextTypedToken = 1;
let writerSavingTokens = new Set();
let writerEditVersion = 0;
let writerSavedWordBaseline = 0;
let writerSavedBaselineChapterId = '';
let writerLastSavedChapterWords = 0;
let writerSaveQueue = Promise.resolve();

function writerWordCount(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function writerFormatNumber(n) {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString('zh-CN');
}

function writerTime(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function writerResetSession() {
  const now = Date.now();
  writerSession = { typed: 0, activeMs: 0, idleMs: 0, lastTick: now, lastInput: now, started: false };
  renderWriterStats();
}

function writerTickSession() {
  if (!writerSession || !writerSession.started || !writerEditorBook || $('#writerEditor').hidden) return;
  const now = Date.now();
  const delta = Math.min(2000, Math.max(0, now - writerSession.lastTick));
  writerSession.lastTick = now;
  if (now - writerSession.lastInput <= 30000) writerSession.activeMs += delta;
  else writerSession.idleMs += delta;
  renderWriterStats();
}

function renderWriterStats() {
  if (!writerSession) return;
  const speed = writerSession.activeMs > 0
    ? writerSession.typed * 3600000 / writerSession.activeMs : 0;
  $('#writerTyped').textContent = writerFormatNumber(writerSession.typed);
  $('#writerSpeed').textContent = writerFormatNumber(speed);
  $('#writerActiveTime').textContent = writerTime(writerSession.activeMs);
  $('#writerIdleTime').textContent = writerTime(writerSession.idleMs);
}

setInterval(writerTickSession, 1000);

function writerInsertedCount(before, after) {
  let left = 0;
  const max = Math.min(before.length, after.length);
  while (left < max && before[left] === after[left]) left += 1;
  let right = 0;
  while (right < before.length - left && right < after.length - left
      && before[before.length - 1 - right] === after[after.length - 1 - right]) right += 1;
  return writerWordCount(after.slice(left, after.length - right));
}

function writerApplyInputMask(before, after, mask, typed) {
  let left = 0;
  const max = Math.min(before.length, after.length);
  while (left < max && before[left] === after[left]) left += 1;
  let right = 0;
  while (right < before.length - left && right < after.length - left
      && before[before.length - 1 - right] === after[after.length - 1 - right]) right += 1;
  const inserted = after.slice(left, after.length - right);
  const insertedMask = inserted.split('').map((char) => (
    typed && !/\s/.test(char) ? writerNextTypedToken++ : 0
  ));
  return mask.slice(0, left).concat(insertedMask, mask.slice(before.length - right));
}

function writerCurrentChapter() {
  if (!writerEditorBook) return null;
  return writerEditorBook.chapters.find((c) => String(c.id) === String(writerChapterId)) || null;
}

function updateWriterWordCount() {
  const count = writerWordCount($('#writerContent').value);
  $('#writerBottomWords').textContent = writerFormatNumber(count);
}

function writerNotice(text, error) {
  const el = $('#writerNotice');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('is-error', !!error);
}

async function loadWriterBooks() {
  try {
    const res = await window.api.writer.list();
    const local = (res && res.books) || [];
    await reconcileSavedOutputBooks(local);
    const ids = new Set(local.map((b) => String(b.bookId)));
    writerRemoteBooks = writerRemoteBooks.filter((b) => !ids.has(String(b.bookId)));
    writerBooks = local.concat(writerRemoteBooks);
    renderWriterBooks();
  } catch (err) {
    writerNotice(`读取作品库失败：${err.message || err}`, true);
  }
}

function writerSourceLabel(source) {
  if (source === 'remote') return '待同步';
  if (source === 'import') return '导入';
  if (source === 'local') return '原创';
  return '作者库';
}

function renderWriterBooks() {
  const grid = $('#writerBookGrid');
  $('#writerEmpty').hidden = !!writerBooks.length;
  grid.innerHTML = writerBooks.map((book, i) => `
    <article class="writer-book-card" data-writer-book="${escapeHtml(String(book.bookId))}">
      <div class="writer-book-cover tone-${i % 5}">
        <span class="writer-book-source">${writerSourceLabel(book.source)}</span>
        <span class="writer-book-feather">✎</span>
      </div>
      <div class="writer-book-info">
        <h3>${escapeHtml(book.name || '未命名作品')}</h3>
        <p>${writerFormatNumber(book.words)} 字 · ${Number(book.chapters) || 0} 章</p>
      </div>
      <button class="writer-book-delete" data-writer-delete="${escapeHtml(String(book.bookId))}" type="button" title="从本地作品库删除">•••</button>
    </article>
  `).join('');
}

function normaliseWriterBook(book) {
  const b = book || {};
  b.chapters = (Array.isArray(b.chapters) ? b.chapters : []).map((c, i) => ({
    ...c,
    id: String(c.id || `chapter_${i + 1}`),
    title: String(c.title || `第${i + 1}章`),
    volume: String(c.volume || '正文'),
    content: String(c.content || ''),
  }));
  if (!b.chapters.length) b.chapters.push({ id: 'chapter_1', title: '第一章', volume: '正文', content: '' });
  return b;
}

async function openWriterBook(bookId) {
  try {
    const res = await window.api.writer.open(bookId);
    if (!res || !res.book) throw new Error('没有找到这本书');
    writerEditorBook = normaliseWriterBook(res.book);
    writerChapterId = writerEditorBook.chapters[0].id;
    writerCollapsedVolumes = new Set();
    $('#writerLibrary').hidden = true;
    $('#writerEditor').hidden = false;
    setWriterChaptersHidden(!!(window.Prefs && window.Prefs.get('writerChaptersHidden', false)), false);
    $('#writerBookName').textContent = writerEditorBook.name || '未命名作品';
    $('#pageCrumb').textContent = ` / ${writerEditorBook.name || '未命名作品'}`;
    writerResetSession();
    renderWriterChapterList();
    loadWriterChapter();
    $('#writerContent').focus();
  } catch (err) {
    writerNotice(`打开作品失败：${err.message || err}`, true);
  }
}

async function syncWriterRemoteBook(remote) {
  const btn = $('#btnWriterSync');
  btn.disabled = true;
  try {
    writerNotice(`正在读取《${remote.name}》的章节目录…`);
    const listed = await window.Exporter.listChapters(remote.bookId, {
      onProgress: (p) => writerNotice(`正在读取《${remote.name}》目录：已找到 ${p.count || 0} 章`),
    });
    if (!listed.chapters.length) throw new Error('没有读取到章节，请确认作品中已有章节');
    const result = await window.Exporter.readContents(remote, listed.chapters, {
      onProgress: (p) => {
        if (p.phase === 'chapter') writerNotice(`正在同步《${remote.name}》：${p.done}/${p.total} · ${p.title || ''}`);
      },
    });
    if (!result.chapters.length) throw new Error((result.failed[0] && result.failed[0].error) || '没有读取到正文');
    const meta = new Map(listed.chapters.map((c) => [String(c.chapterId), c]));
    const chapters = result.chapters.map((c, i) => {
      const m = meta.get(String(c.chapterId)) || {};
      return {
        id: `chapter_${c.chapterId || i + 1}`,
        title: c.title || m.title || `第${i + 1}章`,
        volume: m.volume || '正文',
        content: c.content || '',
      };
    });
    await window.api.writer.save({ bookId: remote.bookId, name: remote.name, source: 'author', chapters });
    writerRemoteBooks = writerRemoteBooks.filter((b) => String(b.bookId) !== String(remote.bookId));
    await loadWriterBooks();
    writerNotice(`《${remote.name}》已同步 ${chapters.length} 章${result.failed.length ? `，${result.failed.length} 章读取失败` : ''}`,
      result.failed.length > 0);
    await openWriterBook(remote.bookId);
  } catch (err) {
    writerNotice(`同步失败：${err.message || err}。请先点右上角“打开作者后台”完成登录。`, true);
  } finally {
    btn.disabled = false;
  }
}

function renderWriterChapterList() {
  if (!writerEditorBook) return;
  const query = $('#writerChapterSearch').value.trim().toLowerCase();
  const groups = new Map();
  writerEditorBook.chapters.forEach((chapter) => {
    if (query && !chapter.title.toLowerCase().includes(query)) return;
    if (!groups.has(chapter.volume)) groups.set(chapter.volume, []);
    groups.get(chapter.volume).push(chapter);
  });
  $('#writerChapterList').innerHTML = [...groups.entries()].map(([volume, chapters]) => `
    <div class="writer-volume ${writerCollapsedVolumes.has(volume) && !query ? 'is-collapsed' : ''}">
      <button class="writer-volume-name" data-writer-volume-toggle="${escapeHtml(volume)}" type="button"
              title="${writerCollapsedVolumes.has(volume) && !query ? '展开分卷' : '收起分卷'}">
        <b>${writerCollapsedVolumes.has(volume) && !query ? '▸' : '▾'}</b>
        <span class="writer-volume-title">${escapeHtml(volume)}</span><small>${chapters.length}章</small>
      </button>
      <div class="writer-volume-chapters">
      ${chapters.map((chapter) => `
        <div class="writer-chapter-row">
          <button class="writer-chapter-item ${String(chapter.id) === String(writerChapterId) ? 'is-active' : ''}"
                  data-writer-chapter="${escapeHtml(String(chapter.id))}" type="button">
            <span>${escapeHtml(chapter.title)}</span><small>${writerFormatNumber(writerWordCount(chapter.content))}</small>
          </button>
          <button class="writer-chapter-remove" data-writer-chapter-delete="${escapeHtml(String(chapter.id))}"
                  type="button" title="删除章节" aria-label="删除 ${escapeHtml(chapter.title)}">×</button>
        </div>`).join('')}
      </div>
    </div>
  `).join('');
}

function syncWriterChapterFromForm() {
  const chapter = writerCurrentChapter();
  if (!chapter) return;
  chapter.title = $('#writerChapterTitle').value.trim() || '未命名章节';
  chapter.content = $('#writerContent').value;
  chapter.updatedAt = Date.now();
}

function loadWriterChapter() {
  const chapter = writerCurrentChapter();
  if (!chapter) return;
  $('#writerChapterTitle').value = chapter.title;
  $('#writerContent').value = chapter.content;
  writerBeforeText = chapter.content;
  writerSavedWordBaseline = writerWordCount(chapter.content);
  writerSavedBaselineChapterId = String(chapter.id);
  writerLastSavedChapterWords = writerSavedWordBaseline;
  writerTypedMask = chapter.content.split('').map(() => 0);
  writerBeforeMask = writerTypedMask.slice();
  updateWriterWordCount();
  renderWriterChapterList();
  refreshBuiltInIncomeEditorStat().catch((err) => console.error('刷新本章稿费失败', err));
}

function markWriterDirty() {
  writerDirty = true;
  writerEditVersion += 1;
  $('#writerSaveState').textContent = '未保存';
  $('#writerBottomState').textContent = '正在自动保存…';
  clearTimeout(writerSaveTimer);
  writerSaveTimer = setTimeout(() => writerSaveNow(true), 900);
}

function writerSaveNow(auto) {
  clearTimeout(writerSaveTimer);
  const run = writerSaveQueue.then(() => writerPerformSave(auto));
  writerSaveQueue = run.catch(() => {});
  return run;
}

async function writerPerformSave(auto) {
  if (!writerEditorBook) return;
  syncWriterChapterFromForm();
  const chapterAtSave = writerCurrentChapter();
  if (!chapterAtSave) return;
  const saveVersion = writerEditVersion;
  const savedChapterId = String(chapterAtSave.id);
  const outputWordsAtSave = writerWordCount($('#writerContent').value);
  const baseline = writerSavedBaselineChapterId === savedChapterId
    ? writerSavedWordBaseline : writerWordCount(chapterAtSave.content);
  const pendingTokens = writerTypedMask.filter((token) => token && !writerSavingTokens.has(token));
  pendingTokens.forEach((token) => writerSavingTokens.add(token));
  const bookSnapshot = JSON.parse(JSON.stringify(writerEditorBook));
  $('#writerSaveState').textContent = '保存中…';
  try {
    const res = await window.api.writer.save(bookSnapshot);
    // 保存过程中若又发生了输入或新建章节，不能用旧响应覆盖内存里的新内容。
    if (res && res.book && writerEditVersion === saveVersion) {
      writerEditorBook = normaliseWriterBook(res.book);
    }
    let statsRecorded = true;
    const outputRecorded = await recordSavedOutput({
      bookId: bookSnapshot.bookId,
      bookName: bookSnapshot.name,
      chapterId: savedChapterId,
      baseline,
      words: outputWordsAtSave,
    });
    if (outputRecorded && String(writerChapterId) === savedChapterId) {
      writerSavedWordBaseline = outputWordsAtSave;
      writerSavedBaselineChapterId = savedChapterId;
      writerLastSavedChapterWords = outputWordsAtSave;
    }
    if (pendingTokens.length) {
      statsRecorded = await recordSavedWriting(pendingTokens.length);
      if (statsRecorded) {
        const committed = new Set(pendingTokens);
        writerTypedMask = writerTypedMask.map((token) => committed.has(token) ? 0 : token);
      }
    }
    if (writerEditVersion === saveVersion) {
      writerDirty = false;
      $('#writerSaveState').textContent = '已保存';
      $('#writerBottomState').textContent = statsRecorded && outputRecorded
        ? (auto ? '已自动保存到本地' : '已保存到本地')
        : '正文已保存，统计数据将在下次保存时重试';
    } else {
      $('#writerSaveState').textContent = '未保存';
      $('#writerBottomState').textContent = '有新的修改等待保存…';
    }
    renderWriterChapterList();
    refreshBuiltInIncomeEditorStat().catch((err) => console.error('刷新本章稿费失败', err));
    // 保存后主动唤醒插件指标；后台异常时会自动重建一次。
    syncPluginBackgrounds(true).catch((err) => console.error('刷新插件指标失败', err));
  } catch (err) {
    $('#writerSaveState').textContent = '保存失败';
    $('#writerBottomState').textContent = `保存失败：${err.message || err}`;
  } finally {
    pendingTokens.forEach((token) => writerSavingTokens.delete(token));
  }
}

$('#writerBookGrid').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-writer-delete]');
  if (del) {
    e.stopPropagation();
    const book = writerBooks.find((b) => String(b.bookId) === del.dataset.writerDelete);
    if (!book || !confirm(`确定从本地作品库删除《${book.name}》吗？此操作不可撤销。`)) return;
    const result = await window.api.writer.remove(book.bookId);
    if (result && result.deleted) await purgeSavedOutputForBook(book.bookId);
    await loadWriterBooks();
    return;
  }
  const card = e.target.closest('[data-writer-book]');
  if (card) {
    const remote = writerBooks.find((b) => String(b.bookId) === card.dataset.writerBook && b.source === 'remote');
    if (remote) syncWriterRemoteBook(remote);
    else openWriterBook(card.dataset.writerBook);
  }
});

$('#btnWriterRefresh').addEventListener('click', loadWriterBooks);
$('#btnWriterSync').addEventListener('click', async () => {
  const btn = $('#btnWriterSync');
  btn.disabled = true;
  writerNotice('正在读取作者后台作品列表…');
  try {
    const remote = await window.Exporter.listBooks();
    const localIds = new Set(writerBooks.filter((b) => b.source !== 'remote').map((b) => String(b.bookId)));
    writerRemoteBooks = remote
      .filter((b) => !localIds.has(String(b.bookId)))
      .map((b) => ({ ...b, source: 'remote', chapters: b.chapters || 0, words: b.words || 0 }));
    const local = writerBooks.filter((b) => b.source !== 'remote');
    writerBooks = local.concat(writerRemoteBooks);
    renderWriterBooks();
    writerNotice(writerRemoteBooks.length
      ? `作者库中还有 ${writerRemoteBooks.length} 本作品未同步，点击作品即可读取正文并开始创作。`
      : `作者库中的 ${remote.length} 本作品均已在本地。`);
  } catch (err) {
    writerNotice(`读取作者库失败：${err.message || err}。请先点右上角“打开作者后台”完成登录。`, true);
  } finally {
    btn.disabled = false;
  }
});
$('#btnWriterCreate').addEventListener('click', async () => {
  const name = prompt('请输入书名', '我的新书');
  if (name == null || !name.trim()) return;
  const res = await window.api.writer.create(name.trim());
  await loadWriterBooks();
  if (res && res.book) openWriterBook(res.book.bookId);
});
$('#btnWriterImport').addEventListener('click', async () => {
  writerNotice('正在导入…');
  const res = await window.api.writer.importBook();
  if (res && res.canceled) { writerNotice(''); return; }
  if (!res || !res.ok) { writerNotice(`导入失败：${(res && res.error) || '未知错误'}`, true); return; }
  writerNotice(`《${res.book.name}》导入成功`);
  await loadWriterBooks();
  openWriterBook(res.book.bookId);
});

$('#btnWriterBack').addEventListener('click', async () => {
  if (writerDirty) await writerSaveNow(true);
  writerEditorBook = null;
  writerChapterId = '';
  $('#writerEditor').hidden = true;
  $('#writerLibrary').hidden = false;
  $('#pageCrumb').textContent = '';
  await loadWriterBooks();
});
$('#btnWriterSave').addEventListener('click', () => writerSaveNow(false));

$('#writerChapterList').addEventListener('click', async (e) => {
  const volumeToggle = e.target.closest('[data-writer-volume-toggle]');
  if (volumeToggle) {
    const volume = volumeToggle.dataset.writerVolumeToggle;
    if (writerCollapsedVolumes.has(volume)) writerCollapsedVolumes.delete(volume);
    else writerCollapsedVolumes.add(volume);
    renderWriterChapterList();
    return;
  }
  const remove = e.target.closest('[data-writer-chapter-delete]');
  if (remove) {
    if (!writerEditorBook || writerEditorBook.chapters.length <= 1) {
      alert('一本书至少需要保留一个章节。');
      return;
    }
    const id = remove.dataset.writerChapterDelete;
    const index = writerEditorBook.chapters.findIndex((c) => String(c.id) === String(id));
    if (index < 0) return;
    const chapter = writerEditorBook.chapters[index];
    if (!confirm(`确定删除“${chapter.title}”吗？\n\n只会删除本地创作中心里的章节，不会删除作者后台数据。`)) return;
    syncWriterChapterFromForm();
    const deletingCurrent = String(writerChapterId) === String(id);
    writerEditorBook.chapters.splice(index, 1);
    if (deletingCurrent) {
      const nearby = writerEditorBook.chapters[Math.min(index, writerEditorBook.chapters.length - 1)];
      writerChapterId = nearby.id;
    }
    markWriterDirty();
    if (deletingCurrent) loadWriterChapter();
    else renderWriterChapterList();
    return;
  }
  const btn = e.target.closest('[data-writer-chapter]');
  if (!btn || btn.dataset.writerChapter === writerChapterId) return;
  syncWriterChapterFromForm();
  if (writerDirty) await writerSaveNow(true);
  writerChapterId = btn.dataset.writerChapter;
  loadWriterChapter();
  $('#writerContent').focus();
});

$('#writerChapterSearch').addEventListener('input', renderWriterChapterList);

function writerChineseNumber(text) {
  const normalized = String(text || '').replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 65296));
  if (/^\d+$/.test(normalized)) return Number(normalized);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of normalized) {
    if (Object.prototype.hasOwnProperty.call(digits, char)) {
      number = digits[char];
    } else if (char === '万') {
      total += (section + number) * 10000;
      section = 0;
      number = 0;
    } else if (units[char]) {
      section += (number || 1) * units[char];
      number = 0;
    } else {
      return NaN;
    }
  }
  return total + section + number;
}

function writerChineseSection(value) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const units = ['', '十', '百', '千'];
  let result = '';
  let pendingZero = false;
  for (let i = 3; i >= 0; i -= 1) {
    const divisor = 10 ** i;
    const digit = Math.floor(value / divisor) % 10;
    if (!digit) {
      if (result && value % divisor) pendingZero = true;
      continue;
    }
    if (pendingZero) result += '零';
    pendingZero = false;
    result += digits[digit] + units[i];
  }
  return result.replace(/^一十/, '十') || '零';
}

function writerNumberToChinese(value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  if (n < 10000) return writerChineseSection(n);
  const high = Math.floor(n / 10000);
  const low = n % 10000;
  return writerChineseSection(high) + '万' + (low ? (low < 1000 ? '零' : '') + writerChineseSection(low) : '');
}

function nextWriterChapterTitle(chapters, volume) {
  const inVolume = chapters.filter((chapter) => chapter.volume === volume);
  for (let i = inVolume.length - 1; i >= 0; i -= 1) {
    const match = String(inVolume[i].title || '').match(/第\s*([0-9０-９零〇一二三四五六七八九十百千万两]+)\s*([章节回篇])/);
    if (!match) continue;
    const number = writerChineseNumber(match[1]);
    if (!Number.isFinite(number)) continue;
    const arabicStyle = /^[0-9０-９]+$/.test(match[1]);
    return `第${arabicStyle ? number + 1 : writerNumberToChinese(number + 1)}${match[2]}`;
  }
  return '第一章';
}

$('#btnWriterNewChapter').addEventListener('click', async () => {
  if (!writerEditorBook) return;
  syncWriterChapterFromForm();
  const current = writerCurrentChapter();
  const volume = current ? current.volume : (writerEditorBook.chapters.at(-1)?.volume || '正文');
  const title = nextWriterChapterTitle(writerEditorBook.chapters, volume);
  let insertAt = -1;
  writerEditorBook.chapters.forEach((chapter, index) => {
    if (chapter.volume === volume) insertAt = index;
  });
  const chapter = { id: `chapter_${Date.now()}`, title, volume, content: '' };
  writerEditorBook.chapters.splice(insertAt + 1, 0, chapter);
  writerCollapsedVolumes.delete(volume);
  writerChapterId = chapter.id;
  markWriterDirty();
  loadWriterChapter();
  $('#writerChapterTitle').select();
});
$('#btnWriterNewVolume').addEventListener('click', () => {
  if (!writerEditorBook) return;
  const volume = prompt('请输入卷名', `第${new Set(writerEditorBook.chapters.map((c) => c.volume)).size + 1}卷`);
  if (volume == null || !volume.trim()) return;
  syncWriterChapterFromForm();
  const chapter = { id: `chapter_${Date.now()}`, title: '第一章', volume: volume.trim(), content: '' };
  writerEditorBook.chapters.push(chapter);
  writerCollapsedVolumes.delete(volume.trim());
  writerChapterId = chapter.id;
  markWriterDirty();
  loadWriterChapter();
  $('#writerChapterTitle').select();
});

$('#writerChapterTitle').addEventListener('input', () => {
  syncWriterChapterFromForm();
  renderWriterChapterList();
  markWriterDirty();
});

const writerContent = $('#writerContent');
writerContent.addEventListener('beforeinput', (e) => {
  if (!writerComposing && e.inputType !== 'insertCompositionText') writerSuppressInput = false;
  writerBeforeText = writerContent.value;
  writerBeforeMask = writerTypedMask.slice();
  writerInputType = String(e.inputType || '');
  writerExcludeInput = /insertFromPaste|insertFromDrop|insertReplacementText|historyUndo|historyRedo/.test(writerInputType);
  if (writerComposing || writerInputType === 'insertCompositionText') writerExcludeInput = true;
});
writerContent.addEventListener('paste', () => { writerExcludeInput = true; });
writerContent.addEventListener('drop', () => { writerExcludeInput = true; });
writerContent.addEventListener('compositionstart', () => {
  writerComposing = true;
  writerCompositionStart = writerContent.value;
  writerCompositionStartMask = writerTypedMask.slice();
});
writerContent.addEventListener('compositionend', () => {
  writerComposing = false;
  writerTypedMask = writerApplyInputMask(
    writerCompositionStart, writerContent.value, writerCompositionStartMask, true
  );
  const added = writerInsertedCount(writerCompositionStart, writerContent.value);
  if (added && writerSession) {
    writerSession.typed += added;
    writerSession.lastInput = Date.now();
    writerSession.started = true;
  }
  writerBeforeText = writerContent.value;
  writerSuppressInput = true;
  renderWriterStats();
});
writerContent.addEventListener('input', () => {
  const typedInput = !writerComposing && !writerExcludeInput && !writerSuppressInput
    && /^insert(Text|LineBreak|Paragraph)$/.test(writerInputType);
  if (!writerComposing) {
    writerTypedMask = writerApplyInputMask(writerBeforeText, writerContent.value, writerBeforeMask, typedInput);
  }
  if (typedInput) {
    const added = writerInsertedCount(writerBeforeText, writerContent.value);
    if (added && writerSession) {
      writerSession.typed += added;
      writerSession.lastInput = Date.now();
      writerSession.started = true;
    }
  }
  writerSuppressInput = false;
  writerExcludeInput = false;
  syncWriterChapterFromForm();
  updateWriterWordCount();
  markWriterDirty();
  renderWriterStats();
});

$('#btnWriterFormat').addEventListener('click', async () => {
  if (writerDirty) await writerSaveNow(true);
  const old = writerContent.value.replace(/\r\n?/g, '\n');
  const lines = old.split('\n').map((line) => line.replace(/[ \t　]+$/g, ''));
  const out = [];
  let blank = false;
  lines.forEach((line) => {
    const text = line.trim();
    if (!text) {
      if (!blank && out.length) out.push('');
      blank = true;
      return;
    }
    blank = false;
    out.push(`　　${text.replace(/^[　 ]+/, '')}`);
  });
  writerContent.value = out.join('\n').trimEnd();
  writerTypedMask = writerContent.value.split('').map(() => 0);
  syncWriterChapterFromForm();
  updateWriterWordCount();
  markWriterDirty();
  $('#writerBottomState').textContent = '已完成段首缩进与空行整理';
});

function writerFindNext() {
  const find = $('#writerFindText').value;
  if (!find) return;
  const text = writerContent.value;
  let at = text.indexOf(find, writerContent.selectionEnd);
  if (at < 0) at = text.indexOf(find);
  if (at < 0) { $('#writerFindResult').textContent = '未找到'; return; }
  writerContent.focus();
  writerContent.setSelectionRange(at, at + find.length);
  $('#writerFindResult').textContent = `第 ${at + 1} 个字符`;
}

$('#btnWriterFind').addEventListener('click', () => {
  $('#writerFindbar').hidden = false;
  $('#writerFindText').focus();
});
$('#btnWriterFindClose').addEventListener('click', () => { $('#writerFindbar').hidden = true; });
$('#btnWriterFindNext').addEventListener('click', writerFindNext);
$('#writerFindText').addEventListener('keydown', (e) => { if (e.key === 'Enter') writerFindNext(); });
$('#btnWriterReplaceOne').addEventListener('click', async () => {
  const find = $('#writerFindText').value;
  if (!find) return;
  const selected = writerContent.value.slice(writerContent.selectionStart, writerContent.selectionEnd);
  if (selected !== find) { writerFindNext(); return; }
  if (writerDirty) await writerSaveNow(true);
  writerContent.setRangeText($('#writerReplaceText').value, writerContent.selectionStart, writerContent.selectionEnd, 'end');
  writerTypedMask = writerContent.value.split('').map(() => 0);
  syncWriterChapterFromForm();
  updateWriterWordCount();
  markWriterDirty();
  writerFindNext();
});
$('#btnWriterReplaceAll').addEventListener('click', async () => {
  const find = $('#writerFindText').value;
  if (!find) return;
  const count = writerContent.value.split(find).length - 1;
  if (!count) { $('#writerFindResult').textContent = '未找到'; return; }
  if (writerDirty) await writerSaveNow(true);
  writerContent.value = writerContent.value.split(find).join($('#writerReplaceText').value);
  writerTypedMask = writerContent.value.split('').map(() => 0);
  syncWriterChapterFromForm();
  updateWriterWordCount();
  markWriterDirty();
  $('#writerFindResult').textContent = `已替换 ${count} 处`;
});

$('#btnWriterStats').addEventListener('click', () => {
  const panel = $('#writerStatsPanel');
  panel.hidden = !panel.hidden;
  $('#btnWriterStats').classList.toggle('is-active', !panel.hidden);
});
$('#btnWriterResetStats').addEventListener('click', writerResetSession);

function setWriterChaptersHidden(hidden, remember) {
  $('#writerWorkspace').classList.toggle('is-chapters-hidden', !!hidden);
  const btn = $('#btnWriterChapters');
  btn.classList.toggle('is-active', !hidden);
  btn.textContent = hidden ? '显示目录' : '隐藏目录';
  btn.title = hidden ? '显示分卷与章节目录' : '隐藏分卷与章节目录';
  if (remember && window.Prefs) window.Prefs.set('writerChaptersHidden', !!hidden);
}

$('#btnWriterChapters').addEventListener('click', () => {
  setWriterChaptersHidden(!$('#writerWorkspace').classList.contains('is-chapters-hidden'), true);
});

// ------------------------------------------------------------ 创作中心发布兼容层
//
// v0.12.2 的投递/敏感词模块原本依赖另一套 Writer 数据层。这里仅提供它需要的
// 最小接口，正文、书库、自动保存与码字统计仍然全部使用当前创作中心实现。

function writerPublishBook() {
  if (!writerEditorBook) return null;
  const source = String(writerEditorBook.source || 'local');
  const inferred = source === 'author' && /^\d+$/.test(String(writerEditorBook.bookId || ''))
    ? String(writerEditorBook.bookId) : '';
  return {
    id: String(writerEditorBook.bookId || ''),
    bookId: String(writerEditorBook.bookId || ''),
    name: String(writerEditorBook.name || '未命名作品'),
    source,
    platformBookId: String(writerEditorBook.platformBookId || inferred),
  };
}

function writerPublishChapter() {
  const chapter = writerCurrentChapter();
  if (!chapter) return null;
  return { ...chapter, id: String(chapter.id), vol: String(chapter.volume || '正文') };
}

async function bindWriterPlatformBook(localBook) {
  if (!writerEditorBook || !localBook) return { ok: false, error: '没有打开作品' };
  if (localBook.platformBookId) return { ok: true, bookId: localBook.platformBookId };
  try {
    const remote = await window.Exporter.listBooks();
    const exact = remote.filter((book) => String(book.name || '').trim() === String(localBook.name || '').trim());
    let selected = exact.length === 1 ? exact[0] : (remote.length === 1 ? remote[0] : null);
    if (!selected) {
      const choices = remote.map((book) => `${book.bookId}  《${book.name}》`).join('\n');
      const entered = window.prompt(`请选择《${localBook.name}》对应的后台作品号：\n\n${choices}`, '');
      if (entered == null) return { ok: false, canceled: true };
      selected = remote.find((book) => String(book.bookId) === String(entered).trim());
      if (!selected) return { ok: false, error: '没有找到这个后台作品号' };
    }
    const id = String(selected.bookId);
    writerEditorBook.platformBookId = id;
    localBook.platformBookId = id;
    await writerSaveNow(false);
    return { ok: true, bookId: id };
  } catch (err) {
    const message = String((err && err.message) || err || '读取后台作品失败');
    return { ok: false, error: message, needLogin: /登录|login/i.test(message) };
  }
}

window.Writer = {
  currentBook: writerPublishBook,
  currentChapter: writerPublishChapter,
  getText() { return $('#writerContent').value; },
  saveNow() { return writerSaveNow(false); },
  autoBindPlatform: bindWriterPlatformBook,
  async replaceText(nextText) {
    if (!writerEditorBook || !writerCurrentChapter()) throw new Error('请先在创作中心打开一章');
    if (writerDirty) await writerSaveNow(true);
    const text = String(nextText == null ? '' : nextText);
    $('#writerContent').value = text;
    writerTypedMask = text.split('').map(() => 0);
    syncWriterChapterFromForm();
    updateWriterWordCount();
    markWriterDirty();
    await writerSaveNow(false);
  },
  async markPublished(info) {
    const chapter = writerCurrentChapter();
    if (!chapter) return;
    chapter.status = 'published';
    chapter.platformChapterId = String((info && info.chapterId) || '');
    chapter.publishedAt = new Date().toISOString();
    chapter.updatedAt = Date.now();
    writerEditVersion += 1;
    await writerSaveNow(false);
    renderWriterChapterList();
  },
};

function renderWriterPublishSchedule() {
  const button = $('#btnWriterSchedule');
  if (!button || !window.Publish) return;
  const value = window.Publish.getSchedule() || '';
  button.textContent = value ? `定时 ${value.slice(5)}` : '立即发布';
  button.title = value ? `将在 ${value} 定时发布` : '当前为立即发布，点击可以设置定时';
  button.classList.toggle('is-set', !!value);
}

$('#btnWriterSchedule').addEventListener('click', () => {
  if (!window.Publish) return;
  const current = window.Publish.getSchedule() || '';
  const value = window.prompt('留空代表立即发布；定时发布请填写：年-月-日 时:分', current);
  if (value == null) return;
  const next = String(value).trim();
  if (next && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(next)) {
    alert('时间格式不正确，请填写成 2026-11-06 08:00');
    return;
  }
  window.Publish.setSchedule(next);
  if (window.Prefs) window.Prefs.set('writerSchedule', next);
  renderWriterPublishSchedule();
});

if (window.Publish) {
  const savedSchedule = window.Prefs ? window.Prefs.get('writerSchedule', '') : '';
  window.Publish.setSchedule(savedSchedule || '');
  renderWriterPublishSchedule();
}

// ------------------------------------------------------------ 已保存码字统计

let writingStatsData = null;
let savedOutputStatsData = null;
let writingStatsDays = 7;

function writingDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function settlementDayKey(date) {
  // 刺猬猫以每日 06:00 为结算日分界：00:00–05:59 仍归前一日。
  return writingDayKey(new Date(date.getTime() - 6 * 60 * 60 * 1000));
}

function writingShortDate(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
}

async function loadWritingStats(force) {
  if (writingStatsData && !force) return writingStatsData;
  try {
    const saved = await window.api.data.read('writing-stats.json');
    writingStatsData = saved && saved.days ? saved : { days: {}, updatedAt: 0 };
  } catch (_) {
    writingStatsData = { days: {}, updatedAt: 0 };
  }
  return writingStatsData;
}

async function recordSavedWriting(count) {
  const amount = Math.max(0, Math.floor(Number(count) || 0));
  if (!amount) return true;
  await loadWritingStats();
  const key = writingDayKey(new Date());
  writingStatsData.days[key] = (Number(writingStatsData.days[key]) || 0) + amount;
  writingStatsData.updatedAt = Date.now();
  try {
    await window.api.data.write('writing-stats.json', writingStatsData);
    const statsView = document.querySelector('.view[data-view="writing-stats"]');
    if (statsView && statsView.classList.contains('is-active')) renderWritingStats();
    return true;
  } catch (err) {
    writingStatsData.days[key] -= amount;
    console.error('保存码字统计失败', err);
    return false;
  }
}

async function loadSavedOutputStats(force) {
  if (savedOutputStatsData && !force) return savedOutputStatsData;
  try {
    const saved = await window.api.data.read('saved-output-stats.json');
    if (saved && saved.days) {
      savedOutputStatsData = saved;
      if (!savedOutputStatsData.chapterWords) savedOutputStatsData.chapterWords = {};
      if (!savedOutputStatsData.bookDays) savedOutputStatsData.bookDays = {};
      if (!savedOutputStatsData.bookNames) savedOutputStatsData.bookNames = {};
    } else {
      await loadWritingStats();
      savedOutputStatsData = {
        days: JSON.parse(JSON.stringify(writingStatsData.days || {})),
        chapterWords: {},
        bookDays: {},
        bookNames: {},
        updatedAt: writingStatsData.updatedAt || 0,
      };
    }
  } catch (_) {
    await loadWritingStats();
    savedOutputStatsData = {
      days: JSON.parse(JSON.stringify(writingStatsData.days || {})),
      chapterWords: {},
      bookDays: {},
      bookNames: {},
      updatedAt: writingStatsData.updatedAt || 0,
    };
  }
  return savedOutputStatsData;
}

async function writeSavedOutputStats() {
  savedOutputStatsData.updatedAt = Date.now();
  await window.api.data.write('saved-output-stats.json', savedOutputStatsData);
}

async function purgeSavedOutputForBook(bookId) {
  await loadSavedOutputStats();
  const id = String(bookId || '');
  if (!id) return false;
  let changed = false;
  const bookDays = savedOutputStatsData.bookDays || (savedOutputStatsData.bookDays = {});
  const contributed = bookDays[id];
  if (contributed && typeof contributed === 'object') {
    Object.entries(contributed).forEach(([day, value]) => {
      const remaining = Math.max(0, (Number(savedOutputStatsData.days[day]) || 0) - (Number(value) || 0));
      if (remaining) savedOutputStatsData.days[day] = remaining;
      else delete savedOutputStatsData.days[day];
    });
    delete bookDays[id];
    changed = true;
  }
  Object.keys(savedOutputStatsData.chapterWords || {}).forEach((chapterKey) => {
    if (chapterKey.startsWith(`${id}::`)) {
      delete savedOutputStatsData.chapterWords[chapterKey];
      changed = true;
    }
  });
  if (savedOutputStatsData.bookNames && Object.prototype.hasOwnProperty.call(savedOutputStatsData.bookNames, id)) {
    delete savedOutputStatsData.bookNames[id];
    changed = true;
  }
  if (changed) await writeSavedOutputStats();
  return changed;
}

async function reconcileSavedOutputBooks(books) {
  await loadSavedOutputStats();
  const local = Array.isArray(books) ? books : [];
  const valid = new Set(local.map((book) => String(book.bookId)));
  const bookDays = savedOutputStatsData.bookDays || (savedOutputStatsData.bookDays = {});
  const bookNames = savedOutputStatsData.bookNames || (savedOutputStatsData.bookNames = {});
  let changed = false;

  // 旧版本只有总数。仅有一本书时可以无损迁移到该作品；作品库为空时
  // 说明旧统计已失去来源，应清零，避免删除作品后仍显示稿费。
  if (!Object.keys(bookDays).length) {
    if (local.length === 1 && Object.keys(savedOutputStatsData.days || {}).length) {
      const id = String(local[0].bookId);
      bookDays[id] = JSON.parse(JSON.stringify(savedOutputStatsData.days || {}));
      bookNames[id] = String(local[0].name || '未命名作品');
      changed = true;
    } else if (!local.length && (Object.keys(savedOutputStatsData.days || {}).length
      || Object.keys(savedOutputStatsData.chapterWords || {}).length)) {
      savedOutputStatsData.days = {};
      savedOutputStatsData.chapterWords = {};
      changed = true;
    }
  }

  for (const id of Object.keys(bookDays)) {
    if (!valid.has(id)) {
      const contributed = bookDays[id] || {};
      Object.entries(contributed).forEach(([day, value]) => {
        const remaining = Math.max(0, (Number(savedOutputStatsData.days[day]) || 0) - (Number(value) || 0));
        if (remaining) savedOutputStatsData.days[day] = remaining;
        else delete savedOutputStatsData.days[day];
      });
      delete bookDays[id];
      delete bookNames[id];
      changed = true;
    }
  }
  Object.keys(savedOutputStatsData.chapterWords || {}).forEach((chapterKey) => {
    const id = chapterKey.split('::')[0];
    if (!valid.has(id)) {
      delete savedOutputStatsData.chapterWords[chapterKey];
      changed = true;
    }
  });
  local.forEach((book) => {
    const id = String(book.bookId);
    const name = String(book.name || '未命名作品');
    if (bookNames[id] !== name) {
      bookNames[id] = name;
      changed = true;
    }
  });
  if (changed) await writeSavedOutputStats();
  return changed;
}

async function recordSavedOutput(change) {
  await loadSavedOutputStats();
  const current = Math.max(0, Math.floor(Number(change && change.words) || 0));
  const fallback = Math.max(0, Math.floor(Number(change && change.baseline) || 0));
  const chapterKey = `${String((change && change.bookId) || '')}::${String((change && change.chapterId) || '')}`;
  const checkpoints = savedOutputStatsData.chapterWords || (savedOutputStatsData.chapterWords = {});
  const hadCheckpoint = Object.prototype.hasOwnProperty.call(checkpoints, chapterKey);
  const previousCheckpoint = hadCheckpoint ? Math.max(0, Number(checkpoints[chapterKey]) || 0) : fallback;
  const amount = Math.max(0, current - previousCheckpoint);
  const key = settlementDayKey(new Date());
  const previousDay = Number(savedOutputStatsData.days[key]) || 0;
  const bookId = String((change && change.bookId) || '');
  const bookDays = savedOutputStatsData.bookDays || (savedOutputStatsData.bookDays = {});
  const previousBookDay = bookId && bookDays[bookId] ? Number(bookDays[bookId][key]) || 0 : 0;
  savedOutputStatsData.days[key] = (Number(savedOutputStatsData.days[key]) || 0) + amount;
  if (bookId) {
    if (!bookDays[bookId]) bookDays[bookId] = {};
    bookDays[bookId][key] = previousBookDay + amount;
    const names = savedOutputStatsData.bookNames || (savedOutputStatsData.bookNames = {});
    names[bookId] = String((change && change.bookName) || names[bookId] || '未命名作品');
  }
  checkpoints[chapterKey] = current;
  savedOutputStatsData.updatedAt = Date.now();
  try {
    await window.api.data.write('saved-output-stats.json', savedOutputStatsData);
    return true;
  } catch (err) {
    savedOutputStatsData.days[key] = previousDay;
    if (bookId && bookDays[bookId]) {
      if (previousBookDay) bookDays[bookId][key] = previousBookDay;
      else delete bookDays[bookId][key];
    }
    if (hadCheckpoint) checkpoints[chapterKey] = previousCheckpoint;
    else delete checkpoints[chapterKey];
    console.error('保存稿费计费字数失败', err);
    return false;
  }
}

function renderWritingStats() {
  if (!writingStatsData) return;
  const today = new Date();
  const rows = [];
  for (let offset = writingStatsDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = writingDayKey(date);
    rows.push({ date, key, value: Number(writingStatsData.days[key]) || 0 });
  }
  const values = rows.map((row) => row.value);
  const total = values.reduce((sum, value) => sum + value, 0);
  const maximum = Math.max(0, ...values);
  const average = Math.round(total / writingStatsDays);
  const todayCount = Number(writingStatsData.days[writingDayKey(today)]) || 0;

  $('#writingTodayDate').textContent = writingShortDate(today);
  $('#writingTodayCount').textContent = writerFormatNumber(todayCount);
  $('#writingTodayMessage').textContent = todayCount
    ? '今天的故事正在生长，继续保持这份手感'
    : '每一次落笔，都会让故事向前一步';
  $('#writingAverageLabel').textContent = `${writingStatsDays}日平均`;
  $('#writingMaxLabel').textContent = `${writingStatsDays}日最高`;
  $('#writingTotalLabel').textContent = `${writingStatsDays}日累计`;
  $('#writingAverage').textContent = writerFormatNumber(average);
  $('#writingMaximum').textContent = writerFormatNumber(maximum);
  $('#writingTotal').textContent = writerFormatNumber(total);
  $$('#writingRange [data-writing-days]').forEach((button) => {
    button.classList.toggle('is-active', Number(button.dataset.writingDays) === writingStatsDays);
  });

  const scale = Math.max(1, maximum);
  $('#writingChart').innerHTML = `
    <div class="writing-grid-lines"><i></i><i></i><i></i><i></i></div>
    <div class="writing-bars">
      ${rows.map((row) => {
        const height = row.value ? Math.max(3, Math.round(row.value / scale * 100)) : 0;
        return `<div class="writing-bar-cell" title="${row.key}：${writerFormatNumber(row.value)} 字">
          <div class="writing-bar-value">${row.value ? writerFormatNumber(row.value) : ''}</div>
          <div class="writing-bar-track"><i style="height:${height}%"></i></div>
          <span>${writingStatsDays > 15 ? writingShortDate(row.date).replace('/', '.') : writingShortDate(row.date)}</span>
        </div>`;
      }).join('')}
    </div>`;
}

$('#writingRange').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-writing-days]');
  if (!button) return;
  writingStatsDays = Number(button.dataset.writingDays) || 7;
  await loadWritingStats();
  renderWritingStats();
});

// ------------------------------------------------------------ 插件中心

let pluginItems = [];
let activePlugin = null;
let activePluginToken = '';
let activePluginRuntime = null;
const pluginBackgroundRuntimes = new Map();
const pluginEditorStats = new Map();

function pluginNotice(text, error) {
  const box = $('#pluginNotice');
  box.hidden = !text;
  box.textContent = text || '';
  box.classList.toggle('is-error', !!error);
}

function pluginPermissionLabel(permission) {
  return {
    'editor.read': '读取当前章节',
    'editor.write': '修改当前章节',
    'stats.read': '读取码字统计',
    'ui.editorStat': '显示编辑器指标',
  }[permission] || permission;
}

async function loadPlugins() {
  try {
    const result = await window.api.plugins.list();
    pluginItems = (result && result.plugins) || [];
    renderPlugins();
    syncPluginNavigation();
    await syncPluginBackgrounds();
    await refreshBuiltInIncomeEditorStat();
  } catch (err) {
    pluginNotice(`读取插件失败：${err.message || err}`, true);
  }
}

async function refreshBuiltInIncomeEditorStat() {
  const plugin = pluginItems.find((item) => item.id === 'income-calculator');
  if (!plugin || !plugin.enabled || plugin.invalid) {
    pluginEditorStats.delete('income-calculator');
    renderPluginEditorStats();
    return;
  }
  await loadSavedOutputStats();
  const raw = await window.api.plugins.storageGet('income-calculator', 'settings');
  const source = raw && typeof raw === 'object' ? raw : {};
  const currentBookId = writerEditorBook ? String(writerEditorBook.bookId) : '';
  const bookSubscriptions = source.bookSubscriptions && typeof source.bookSubscriptions === 'object'
    ? source.bookSubscriptions : {};
  const subscriptionsValue = Number(Object.prototype.hasOwnProperty.call(bookSubscriptions, currentBookId)
    ? bookSubscriptions[currentBookId] : source.subscriptions);
  const subscriptions = Number.isFinite(subscriptionsValue) && subscriptionsValue >= 0
    ? subscriptionsValue : 10000;
  const todayKey = settlementDayKey(new Date());
  const todayWords = Number(savedOutputStatsData.days[todayKey]) || 0;
  const currentBookTodayWords = Number(savedOutputStatsData.bookDays
    && savedOutputStatsData.bookDays[currentBookId]
    && savedOutputStatsData.bookDays[currentBookId][todayKey]) || 0;
  const currentBookBillable = todayWords > 20000 && todayWords > 0
    ? currentBookTodayWords * (20000 / todayWords) : currentBookTodayWords;
  const chapterWords = Math.max(0, Number(writerLastSavedChapterWords) || 0);
  const chapterBillable = Math.min(chapterWords, 20000);
  const todaySubscription = currentBookBillable / 2000 * (subscriptions / 10000) * 400;
  const chapterSubscription = chapterBillable / 2000 * (subscriptions / 10000) * 400;
  pluginEditorStats.set('income-calculator', {
    label: '本章预计稿费',
    value: `¥${chapterSubscription.toFixed(2)}`,
    detail: `本章 ${writerFormatNumber(chapterWords)} 字 · 本书今日 ¥${todaySubscription.toFixed(2)} · 全部 ${writerFormatNumber(todayWords)} 字`,
  });
  renderPluginEditorStats();
}

function renderPlugins() {
  $('#pluginEmpty').hidden = !!pluginItems.length;
  $('#pluginGrid').innerHTML = pluginItems.map((plugin) => `
    <article class="plugin-card ${plugin.enabled ? '' : 'is-disabled'} ${plugin.invalid ? 'is-invalid' : ''}">
      <div class="plugin-card-top">
        <div class="plugin-icon">${escapeHtml((plugin.name || '?').slice(0, 1))}</div>
        <div class="plugin-title"><h3>${escapeHtml(plugin.name)}</h3><span>v${escapeHtml(plugin.version || '—')}</span></div>
        ${plugin.invalid ? '<span class="tag">无效</span>' : `
          <label class="plugin-switch" title="启用或停用插件">
            <input type="checkbox" data-plugin-enable="${escapeHtml(plugin.id)}" ${plugin.enabled ? 'checked' : ''} />
            <i></i>
          </label>`}
      </div>
      <p>${escapeHtml(plugin.description || '没有填写插件说明')}</p>
      <div class="plugin-permissions">
        ${(plugin.permissions || []).length
          ? plugin.permissions.map((p) => `<span>${escapeHtml(pluginPermissionLabel(p))}</span>`).join('')
          : '<span>无需额外权限</span>'}
      </div>
      <div class="plugin-card-foot">
        <span>${plugin.author ? `作者：${escapeHtml(plugin.author)}` : escapeHtml(plugin.id)}</span>
        <button class="btn primary btn-sm" data-plugin-open="${escapeHtml(plugin.id)}"
                ${!plugin.enabled || plugin.invalid ? 'disabled' : ''} type="button">打开</button>
        <button class="link-btn" data-plugin-remove="${escapeHtml(plugin.id)}" type="button">删除</button>
      </div>
    </article>
  `).join('');
}

function syncPluginNavigation() {
  $$('.plugin-nav-item').forEach((item) => item.remove());
  const settings = $('#nav .nav-item[data-view="settings"]');
  pluginItems
    .filter((plugin) => plugin.enabled && !plugin.invalid && plugin.contributes && plugin.contributes.navigation)
    .forEach((plugin) => {
      const button = document.createElement('button');
      button.className = 'nav-item plugin-nav-item';
      button.dataset.view = 'plugins';
      button.dataset.pluginNav = plugin.id;
      button.textContent = plugin.contributes.navigation.title || plugin.name;
      $('#nav').insertBefore(button, settings);
    });
}

function renderPluginEditorStats() {
  const box = $('#pluginEditorStats');
  const enabled = pluginItems.filter((plugin) => (
    plugin.enabled && !plugin.invalid && plugin.contributes && plugin.contributes.editorStat
  ));
  const items = enabled.map((plugin) => pluginEditorStats.get(plugin.id) || {
    label: plugin.name,
    value: '正在加载…',
    detail: '保存正文后会自动刷新',
  });
  box.hidden = !items.length;
  box.innerHTML = items.map((item) => `
    <div class="plugin-editor-stat">
      <span>${escapeHtml(item.label)}</span><b>${escapeHtml(item.value)}</b>
      ${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}
    </div>
  `).join('');
}

function removePluginBackground(id) {
  const runtime = pluginBackgroundRuntimes.get(id);
  if (runtime && runtime.frame) runtime.frame.remove();
  pluginBackgroundRuntimes.delete(id);
  pluginEditorStats.delete(id);
  renderPluginEditorStats();
}

async function syncPluginBackgrounds(recoverMissing) {
  const desired = new Map(pluginItems
    .filter((plugin) => plugin.enabled && !plugin.invalid && plugin.contributes && plugin.contributes.editorStat)
    .map((plugin) => [plugin.id, plugin]));
  [...pluginBackgroundRuntimes.keys()].forEach((id) => {
    if (!desired.has(id)) removePluginBackground(id);
  });
  for (const plugin of desired.values()) {
    const existing = pluginBackgroundRuntimes.get(plugin.id);
    if (existing) {
      const stalled = recoverMissing && !pluginEditorStats.has(plugin.id)
        && Date.now() - existing.startedAt > 2500;
      if (!stalled) continue;
      removePluginBackground(plugin.id);
    }
    try {
      const bundle = await window.api.plugins.get(plugin.id);
      if (!bundle.background) continue;
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-scripts';
      frame.title = `${plugin.name} 后台`;
      const runtime = {
        plugin: { ...plugin, manifest: bundle.manifest },
        token: pluginToken(),
        frame,
        kind: 'background',
        messageStartedAt: Date.now(),
        messageCount: 0,
        startedAt: Date.now(),
      };
      pluginBackgroundRuntimes.set(plugin.id, runtime);
      $('#pluginBackgrounds').appendChild(frame);
      const documentText = buildPluginDocument({ ...bundle, page: '', style: '', script: bundle.background }, runtime.token);
      frame.src = `data:text/html;base64,${pluginUtf8Base64(documentText)}`;
    } catch (err) {
      console.error(`插件 ${plugin.id} 后台启动失败`, err);
    }
  }
  renderPluginEditorStats();
}

function pluginUtf8Base64(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function pluginToken() {
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((n) => n.toString(16).padStart(8, '0')).join('');
}

function pluginBridgeSource(token) {
  return `(() => {
    'use strict';
    const TOKEN = ${JSON.stringify(token)};
    let sequence = 0;
    const waiting = new Map();
    function request(method, payload) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        waiting.set(id, { resolve, reject });
        parent.postMessage({ type: 'ciweimao-plugin-request', token: TOKEN, id, method, payload }, '*');
        setTimeout(() => {
          const item = waiting.get(id);
          if (!item) return;
          waiting.delete(id);
          item.reject(new Error('插件请求超时'));
        }, 15000);
      });
    }
    addEventListener('message', (event) => {
      const data = event.data || {};
      if (event.source !== parent || data.type !== 'ciweimao-plugin-response' || data.token !== TOKEN) return;
      const item = waiting.get(data.id);
      if (!item) return;
      waiting.delete(data.id);
      if (data.ok) item.resolve(data.result);
      else item.reject(new Error(data.error || '插件请求失败'));
    });
    const api = {
      app: { info: () => request('app.info'), notify: (message) => request('app.notify', { message }) },
      editor: {
        getContext: () => request('editor.getContext'),
        setContent: (content) => request('editor.setContent', { content }),
        insertText: (text, position = 'selection') => request('editor.insertText', { text, position }),
      },
      stats: { get: () => request('stats.get') },
      ui: { setEditorStat: (item) => request('ui.setEditorStat', item) },
      storage: {
        get: (key) => request('storage.get', { key }),
        set: (key, value) => request('storage.set', { key, value }),
      },
    };
    Object.freeze(api.app); Object.freeze(api.editor); Object.freeze(api.stats); Object.freeze(api.ui); Object.freeze(api.storage);
    Object.defineProperty(window, 'PluginAPI', { value: Object.freeze(api), writable: false });
  })();`;
}

function buildPluginDocument(bundle, token) {
  const page = String(bundle.page || '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const style = String(bundle.style || '').replace(/<\/style/gi, '<\\/style');
  const bridge = pluginBridgeSource(token).replace(/<\/script/gi, '<\\/script');
  const script = String(bundle.script || '').replace(/<\/script/gi, '<\\/script');
  const nonce = 'ciweimao-plugin';
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
    <meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head>
    <body>${page}<script nonce="${nonce}">${bridge}</script><script nonce="${nonce}">${script}</script></body></html>`;
}

async function openPlugin(id) {
  try {
    const bundle = await window.api.plugins.get(id);
    const meta = pluginItems.find((item) => item.id === id) || bundle.manifest;
    activePlugin = { ...meta, manifest: bundle.manifest };
    activePluginToken = pluginToken();
    activePluginRuntime = {
      plugin: activePlugin,
      token: activePluginToken,
      frame: $('#pluginFrame'),
      kind: 'page',
      messageStartedAt: Date.now(),
      messageCount: 0,
    };
    $('#pluginManager').hidden = true;
    $('#pluginHost').hidden = false;
    $('#pluginHostTitle').textContent = activePlugin.name;
    $('#pluginHostStatus').textContent = '隔离运行中';
    $('#pageTitle').textContent = (activePlugin.contributes && activePlugin.contributes.navigation
      && activePlugin.contributes.navigation.title) || activePlugin.name;
    setActiveNav('plugins', activePlugin.id);
    const documentText = buildPluginDocument(bundle, activePluginToken);
    $('#pluginFrame').src = `data:text/html;base64,${pluginUtf8Base64(documentText)}`;
  } catch (err) {
    pluginNotice(`打开插件失败：${err.message || err}`, true);
  }
}

function closePlugin() {
  activePlugin = null;
  activePluginToken = '';
  activePluginRuntime = null;
  $('#pluginFrame').removeAttribute('src');
  $('#pluginHost').hidden = true;
  $('#pluginManager').hidden = false;
  $('#pluginHostStatus').textContent = '';
  if (lastView === 'plugins') {
    $('#pageTitle').textContent = VIEW_TITLES.plugins;
    setActiveNav('plugins', '');
  }
}

function requirePluginPermission(plugin, permission) {
  const permissions = (plugin && plugin.manifest && plugin.manifest.permissions) || [];
  if (!permissions.includes(permission)) throw new Error(`插件未声明权限：${permission}`);
}

async function handlePluginRequest(runtime, method, payload) {
  const plugin = runtime && runtime.plugin;
  if (!plugin) throw new Error('插件未打开');
  if (method === 'app.info') {
    return { plugin: plugin.id, version: plugin.version, theme: document.documentElement.dataset.theme || 'light' };
  }
  if (method === 'app.notify') {
    const message = String((payload && payload.message) || '').slice(0, 160);
    if (runtime.kind === 'page') $('#pluginHostStatus').textContent = message;
    return true;
  }
  if (method === 'storage.get') return window.api.plugins.storageGet(plugin.id, payload && payload.key);
  if (method === 'storage.set') {
    const result = await window.api.plugins.storageSet(plugin.id, payload && payload.key, payload && payload.value);
    if (plugin.id === 'income-calculator') await refreshBuiltInIncomeEditorStat();
    return result;
  }
  if (method === 'editor.getContext') {
    requirePluginPermission(plugin, 'editor.read');
    const chapter = writerCurrentChapter();
    if (!writerEditorBook || !chapter) return null;
    return {
      bookId: writerEditorBook.bookId,
      bookName: writerEditorBook.name,
      chapterId: chapter.id,
      title: $('#writerChapterTitle').value,
      content: $('#writerContent').value,
      selectedText: $('#writerContent').value.slice($('#writerContent').selectionStart, $('#writerContent').selectionEnd),
      words: writerWordCount($('#writerContent').value),
    };
  }
  if (method === 'editor.setContent' || method === 'editor.insertText') {
    requirePluginPermission(plugin, 'editor.write');
    if (!writerEditorBook || !writerCurrentChapter()) throw new Error('请先在创作中心打开一本书');
    if (writerDirty) await writerSaveNow(true);
    const editor = $('#writerContent');
    if (method === 'editor.setContent') {
      const content = String((payload && payload.content) || '');
      if (content.length > 2 * 1024 * 1024) throw new Error('正文不能超过 2MB');
      editor.value = content;
    } else {
      const text = String((payload && payload.text) || '');
      if (text.length > 512 * 1024) throw new Error('一次插入不能超过 512KB');
      const position = String((payload && payload.position) || 'selection');
      if (position === 'start') editor.setRangeText(text, 0, 0, 'end');
      else if (position === 'end') editor.setRangeText(text, editor.value.length, editor.value.length, 'end');
      else editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
    }
    writerTypedMask = editor.value.split('').map(() => 0);
    syncWriterChapterFromForm();
    updateWriterWordCount();
    markWriterDirty();
    await writerSaveNow(false);
    return { words: writerWordCount(editor.value) };
  }
  if (method === 'stats.get') {
    requirePluginPermission(plugin, 'stats.read');
    await loadWritingStats();
    await loadSavedOutputStats();
    const library = await window.api.writer.list();
    const books = (library && library.books) || [];
    await reconcileSavedOutputBooks(books);
    return {
      days: JSON.parse(JSON.stringify(writingStatsData.days || {})),
      savedDays: JSON.parse(JSON.stringify(savedOutputStatsData.days || {})),
      savedBookDays: JSON.parse(JSON.stringify(savedOutputStatsData.bookDays || {})),
      books: books.map((book) => ({
        bookId: String(book.bookId),
        name: String(book.name || '未命名作品'),
      })),
      updatedAt: Math.max(writingStatsData.updatedAt || 0, savedOutputStatsData.updatedAt || 0),
      currentBookId: writerEditorBook ? String(writerEditorBook.bookId) : '',
      currentBookName: writerEditorBook ? String(writerEditorBook.name || '未命名作品') : '',
      currentChapterSavedWords: writerEditorBook && writerCurrentChapter()
        ? writerLastSavedChapterWords : 0,
    };
  }
  if (method === 'ui.setEditorStat') {
    requirePluginPermission(plugin, 'ui.editorStat');
    const item = {
      label: String((payload && payload.label) || plugin.name).slice(0, 30),
      value: String((payload && payload.value) || '').slice(0, 50),
      detail: String((payload && payload.detail) || '').slice(0, 90),
    };
    pluginEditorStats.set(plugin.id, item);
    renderPluginEditorStats();
    return true;
  }
  throw new Error(`不支持的插件接口：${method}`);
}

window.addEventListener('message', async (event) => {
  const data = event.data || {};
  let runtime = null;
  if (activePluginRuntime && event.source === activePluginRuntime.frame.contentWindow
      && data.token === activePluginRuntime.token) runtime = activePluginRuntime;
  if (!runtime) {
    for (const candidate of pluginBackgroundRuntimes.values()) {
      if (event.source === candidate.frame.contentWindow && data.token === candidate.token) {
        runtime = candidate;
        break;
      }
    }
  }
  if (!runtime || data.type !== 'ciweimao-plugin-request') return;
  const now = Date.now();
  if (now - runtime.messageStartedAt > 1000) {
    runtime.messageStartedAt = now;
    runtime.messageCount = 0;
  }
  runtime.messageCount += 1;
  if (runtime.messageCount > 100) return;
  try {
    const result = await handlePluginRequest(runtime, String(data.method || ''), data.payload || {});
    event.source.postMessage({ type: 'ciweimao-plugin-response', token: runtime.token, id: data.id, ok: true, result }, '*');
  } catch (err) {
    event.source.postMessage({
      type: 'ciweimao-plugin-response', token: runtime.token, id: data.id,
      ok: false, error: String((err && err.message) || err),
    }, '*');
  }
});

$('#pluginGrid').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-plugin-enable]');
  if (!input) return;
  await window.api.plugins.enable(input.dataset.pluginEnable, input.checked);
  await loadPlugins();
});

$('#pluginGrid').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-plugin-open]');
  if (open) { await openPlugin(open.dataset.pluginOpen); return; }
  const remove = e.target.closest('[data-plugin-remove]');
  if (!remove) return;
  const plugin = pluginItems.find((item) => item.id === remove.dataset.pluginRemove);
  if (!plugin || !confirm(`确定删除插件“${plugin.name}”吗？\n\n插件自己的存储数据会保留。`)) return;
  await window.api.plugins.remove(plugin.id);
  await loadPlugins();
});

$('#btnPluginFolder').addEventListener('click', () => window.api.plugins.openFolder());
$('#btnPluginReload').addEventListener('click', loadPlugins);
$('#btnPluginImport').addEventListener('click', async () => {
  const result = await window.api.plugins.importZip();
  if (!result || result.canceled) return;
  if (!result.ok) { pluginNotice(`导入失败：${result.error}`, true); return; }
  pluginNotice(`插件“${result.plugin.name}”导入成功`);
  await loadPlugins();
});
$('#btnPluginTemplate').addEventListener('click', async () => {
  const result = await window.api.plugins.createTemplate();
  if (!result || !result.ok) { pluginNotice(`创建模板失败：${(result && result.error) || '未知错误'}`, true); return; }
  pluginNotice(`开发模板已创建：${result.id}。修改文件后点击“重新加载”。`);
  await loadPlugins();
  await window.api.plugins.openFolder();
});
$('#btnPluginBack').addEventListener('click', closePlugin);
$('#btnPluginRefresh').addEventListener('click', () => {
  if (activePlugin) openPlugin(activePlugin.id);
});

async function refreshStoragePanel() {
  try {
    const status = await window.api.storage.status();
    $('#storagePath').textContent = status.path;
    $('#storageModeTag').textContent = status.custom ? '自定义位置' : '系统默认';
    $('#btnStorageReset').disabled = !status.custom;
    $('#kvUserData').textContent = status.path;
    $('#kvUserData2').textContent = status.path;
  } catch (_) { /* ignore */ }
}

$('#btnStorageChoose').addEventListener('click', async () => {
  if (writerDirty) await writerSaveNow(true);
  const result = await window.api.storage.choose();
  if (!result || result.canceled) return;
  writingStatsData = null;
  savedOutputStatsData = null;
  await refreshStoragePanel();
  writerEditorBook = null;
  $('#writerEditor').hidden = true;
  $('#writerLibrary').hidden = false;
  await loadWriterBooks();
});
$('#btnStorageReset').addEventListener('click', async () => {
  if (!confirm('恢复系统默认保存位置？旧目录里的文件会保留，不会被删除。')) return;
  if (writerDirty) await writerSaveNow(true);
  await window.api.storage.reset();
  writingStatsData = null;
  savedOutputStatsData = null;
  await refreshStoragePanel();
  writerEditorBook = null;
  $('#writerEditor').hidden = true;
  $('#writerLibrary').hidden = false;
  await loadWriterBooks();
});

// ------------------------------------------------------------ 主题

$('#btnTheme').addEventListener('click', () => window.Theme.toggle());

$('#themeSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme-mode]');
  if (!btn) return;
  window.Theme.set(btn.dataset.themeMode);
});

// 折线图的颜色取自 CSS 变量，换主题后得重画一次
document.addEventListener('theme-changed', () => {
  const snap = currentSnapshot();
  if (!snap || !boardBookId) return;
  const b = (snap.books || []).find((x) => String(x.bookId) === boardBookId);
  if (b) renderBookChart(b);
});

// ------------------------------------------------------------ 首次启动声明

/** 只在这条偏好为真时才不再弹；写进 ui-prefs.json，卸载前一直有效 */
const FREE_NOTICE_KEY = 'freeNoticeAccepted';

async function openFreeNotice() {
  const el = $('#freeNotice');
  if (!el) return;
  // 平台页面是原生视图，层级压过一切 DOM，不先收起来会把它整个盖住
  if (browserOpen) await closeBrowser();
  el.hidden = false;
  el.classList.remove('is-closing');
  document.body.classList.add('is-locked');
  const btn = $('#btnFreeNoticeOk');
  if (btn) btn.focus();
}

function closeFreeNotice(remember) {
  const el = $('#freeNotice');
  if (!el || el.hidden) return;
  if (remember && window.Prefs) {
    window.Prefs.set(FREE_NOTICE_KEY, true);
    // 点完很可能顺手就关程序，不等 250ms 防抖，立刻落盘一次
    try { window.api.data.write('ui-prefs.json', window.Prefs.all()); } catch (_) { /* ignore */ }
  }
  el.classList.add('is-closing');
  document.body.classList.remove('is-locked');
  setTimeout(() => {
    el.hidden = true;
    el.classList.remove('is-closing');
  }, 180);
}

$('#btnFreeNoticeOk').addEventListener('click', () => closeFreeNotice(true));
$('#btnShowFreeNotice').addEventListener('click', () => openFreeNotice());

// Esc 等同「已看过」，免得有人习惯性按掉之后每次启动都再弹
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeFreeNotice(true);
});

// ------------------------------------------------------------ 启动自检

(async function boot() {
  setActiveView('overview');

  // 主题与偏好：theme-init.js 已完成首帧上色，这里只做运行时同步
  try {
    if (window.Prefs) await window.Prefs.ready();
    reviewStrict = !!(window.Prefs && window.Prefs.get('reviewStrict', false));
    renderReviewStrict();
    window.Theme.boot();
  } catch (_) { /* ignore */ }

  // 偏好里没有「已看过声明」的记录，就说明是第一次启动
  if (!window.Prefs || !window.Prefs.get(FREE_NOTICE_KEY, false)) openFreeNotice();

  await loadDismissed();
  renderExportBooks();
  renderChapterList();
  refreshVault(true);
  renderExecPool();
  refreshExecLog();
  refreshAiPanel();
  await refreshStoragePanel();
  await loadPlugins();

  try {
    const dir = await window.api.app.userDataPath();
    $('#kvUserData').textContent = dir;
    $('#kvUserData2').textContent = dir;
    $('#kvDataDir').textContent = await window.api.data.dir();
    const dataDir = await window.api.data.dir();
    $('#kvActionLog').textContent = dataDir + '\\actions-log.json';
  } catch (_) { /* ignore */ }

  try {
    crawlData = await window.api.data.read('tsukkomi.json');
    if (crawlData && crawlData.items && crawlData.items.length) {
      runReview();
      renderAll();
    } else {
      crawlData = null;
    }
  } catch (_) { crawlData = null; }

  try {
    const store = await window.api.data.read('stats-snapshots.json');
    if (store && Array.isArray(store.snapshots)) snapshots = store.snapshots;
  } catch (_) { snapshots = []; }
  renderBoard();

  try {
    const rs = await window.api.data.read('rank-history.json');
    if (rs && Array.isArray(rs.records)) rankRecords = rs.records;
  } catch (_) { rankRecords = []; }
  renderRank();

  const state = await window.api.browser.state();
  if (state && state.ready) renderConn(state);
})();
