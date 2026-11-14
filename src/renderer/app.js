'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));

/**
 * 输入弹窗。
 *
 * Electron 的渲染进程不支持 window.prompt()，调用会直接抛出
 * "prompt() is and will not be supported"，函数在第一行就中断，
 * 表现就是按钮点了完全没反应。这里改用页面内的遮罩层替代，
 * 返回 Promise<string|null>，取消时为 null，与 prompt 的语义保持一致。
 */
window.askText = askText;

function askText({ title = '请输入', hint = '', value = '', okText = '确定', cancelText = '取消' } = {}) {
  const overlay = $('#textPrompt');
  const input = $('#textPromptInput');
  const hintEl = $('#textPromptHint');
  const okBtn = $('#textPromptOk');
  const cancelBtn = $('#textPromptCancel');
  if (!overlay || !input || !hintEl || !okBtn || !cancelBtn) return Promise.resolve(null);
  const wasLocked = document.body.classList.contains('is-locked');
  /*
   * 内嵌作者后台是原生 WebContentsView，压在 DOM 之上。输入弹窗如果不先
   * 把页面摘下来，遮罩会被页面盖住，用户看到的就是「网页突然跳出来」。
   * 复用更新弹窗那套摘取/恢复逻辑：页面不销毁，关掉弹窗后原样挂回去。
   */
  const guideOpen = !!(document.getElementById('guideDialog')
    && !document.getElementById('guideDialog').hidden);
  let overlayState = null;
  const prepare = !guideOpen && typeof window.prepareUpdateOverlay === 'function'
    ? window.prepareUpdateOverlay : null;

  const open = async () => {
    if (prepare) {
      try { overlayState = await prepare(); } catch (_) { overlayState = null; }
    }
    return new Promise((resolve) => {
      let finished = false;
      $('#textPromptTitle').textContent = title;
      okBtn.textContent = okText;
      cancelBtn.textContent = cancelText;
      hintEl.textContent = hint || '';
      hintEl.hidden = !hint;
      input.value = value == null ? '' : String(value);
      overlay.hidden = false;
      document.body.classList.add('is-locked');

      function onOk() { finish(input.value); }
      function onCancel() { finish(null); }
      function onKey(event) {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onOk(); }
        else if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      }
      function onBackdrop(event) { if (event.target === overlay) onCancel(); }
      function finish(result) {
        if (finished) return;
        finished = true;
        overlay.hidden = true;
        if (!wasLocked) document.body.classList.remove('is-locked');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        overlay.removeEventListener('mousedown', onBackdrop);
        // 等遮罩真正消失、界面重绘完成，再把原生页面挂回来；
        // 否则页面会在弹窗还亮着的时候盖上去。
        if (overlayState && typeof window.restoreUpdateOverlay === 'function') {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            // A caller may open the next prompt immediately after this promise resolves.
            // Its owner will restore the shared native view when the last dialog closes.
            if (['textPrompt', 'guideDialog', 'updateDialog', 'updateCompleteDialog'].some(id => {
              const dialog = document.getElementById(id);
              return dialog && !dialog.hidden;
            })) return;
            Promise.resolve(window.restoreUpdateOverlay()).catch(() => {});
          }));
        }
        resolve(result);
      }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
      overlay.addEventListener('mousedown', onBackdrop);
      setTimeout(() => { if (!overlay.hidden) { input.focus(); input.select(); } }, 0);
    });
  };

  return open();
}

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
  plugins: '功能中心',
  settings: '设置',
};

let browserOpen = false;
/** 进入平台页面之前停留的本地视图，退出后台时回到这里 */
let lastView = 'overview';
/** 进后台之前所在的界面：「回到…」按钮的落点 */
let browserReturnView = 'writer';
/** 专注模式：隐藏左侧导航/顶栏/右栏，只留目录与正文 */
let writerFocusOn = false;
/**
 * 上一次收到的浏览器状态。
 *
 * 初始 `isLoginPage: false`：还没打开过任何页面，不该被当成「之前在登录页」——
 * 否则第一次打开后台首页就会被误判成「从登录页跳出来 = 登录成功」。
 */
let lastState = { isLoginPage: false, url: '' };

/**
 * 这一次打开后台的过程中，用户是否**真的完成了一次登录**。
 *
 * 只在「之前停在登录页 → 现在离开登录页且到了作者后台」时置 true。
 *
 * 为什么不能只看「当前不是登录页」：点「打开作者后台」时，页面先加载
 * `author.ciweimao.com/homepage`，这个 URL 不含 `/login`，于是
 * `isLoginPage === false` —— 但它只是**还没跳转到登录页**，用户根本没登录。
 * 旧判断（`!state.isLoginPage && state.url`）就在这一刻成立，
 * 结果「登录成功」弹窗当场弹出、还把后台页面关掉了：
 * 用户看到的就是「点了打开后台，直接跳到抓取指引，中间没让我登录」。
 *
 * 声明放在这里（而不是靠近它的使用处）：浏览器事件回调注册在文件前面，
 * 若事件在 `let` 初始化之前到达，会抛 TDZ 错误让整个回调中断。
 */
let loginJustSucceeded = false;
let rafPending = false;
/**
 * 更新确认框打开期间暂存的内嵌页面状态。
 *
 * WebContentsView 位于渲染页面之上，普通 DOM 弹窗无法覆盖它。更新框
 * 打开前先把当前内嵌页摘下来，关闭后再把同一个页面挂回去，避免用户
 * 在作者后台填写到一半时被导航到首页或丢失页面状态。
 */
let updateOverlayState = null;
let updateOverlayPending = null;

async function prepareUpdateOverlay() {
  if (updateOverlayPending) await updateOverlayPending;
  if (updateOverlayState) return updateOverlayState;

  const state = {
    browser: browserOpen,
    miaoyu: miaoyuOpen,
  };
  if (!state.browser && !state.miaoyu) return null;

  updateOverlayState = state;
  updateOverlayPending = state.browser ? closeBrowser() : closeMiaoyu();
  try {
    await updateOverlayPending;
  } catch (_) {
    // 更新弹窗不能因为内嵌页摘取失败而打不开；下次关闭时仍会尝试恢复。
  } finally {
    updateOverlayPending = null;
  }
  return state;
}

async function restoreUpdateOverlay() {
  if (updateOverlayPending) await updateOverlayPending;
  const state = updateOverlayState;
  updateOverlayState = null;
  if (!state) return;

  try {
    if (state.browser) await showBrowserKeepPage();
    else if (state.miaoyu) await openMiaoyu();
  } catch (err) {
    console.warn('恢复更新前的内嵌页面失败', err);
  }
}

// 更新提示脚本在同一个渲染进程中加载，使用这两个窄接口即可协调页面层级。
window.prepareUpdateOverlay = prepareUpdateOverlay;
window.restoreUpdateOverlay = restoreUpdateOverlay;

// ------------------------------------------------------------ 尺寸同步

function currentRect() {
  const r = HOST.getBoundingClientRect();
  // 登录页上方会显示密码本工具条，平台视图要让出这段高度，否则会盖住它
  const bar = document.getElementById('vaultBar');
  const off = (browserOpen && bar && !bar.hidden) ? bar.offsetHeight : 0;
  return { x: r.x, y: r.y + off, width: r.width, height: Math.max(1, r.height - off) };
}

/**
 * 创作中心的右栏需要根据「编辑器实际可用高度」而不是固定窗口尺寸布局。
 * 系统最大化时顶栏、边距和缩放比例都可能改变，单靠 100vh 会让错别字面板
 * 或底部码字统计被挤出可视区域。给高编辑区加一个状态类，由 CSS 分配两个
 * 独立的滚动区域；窗口还原时自动恢复普通布局。
 */
function syncWriterViewportLayout() {
  const editor = $('#writerEditor');
  if (!editor) return;
  const height = editor.getBoundingClientRect().height;
  document.body.classList.toggle('is-writer-tall', height >= 820);
}

if (typeof ResizeObserver !== 'undefined') {
  const editor = $('#writerEditor');
  if (editor) new ResizeObserver(syncWriterViewportLayout).observe(editor);
}
window.addEventListener('resize', syncWriterViewportLayout);
syncWriterViewportLayout();


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

/* ------------------------------------------------------------ 侧边栏自定义 */

/**
 * 侧边栏自定义的界面部分。
 *
 * 排序规则全在 nav-order.js（那边有单测），这里只负责：
 * 把文字包成 span（好让工具条独立存在）、按顺序重排 DOM、接住工具条的点击。
 *
 * 关键约束：span 工具条放在 button 内部，点击必须用 capture 阶段拦下来并
 * stopPropagation，否则会先冒泡到「切换视图」的监听，变成点一下就跳页面。
 */
/* ------------------------------------------------------------ 侧边栏：调整态 / 草稿 / 保存
 *
 * 三个状态要分清，之前混在一起出过问题：
 *
 *   navEditing  是否处于「调整态」——决定 ▲▼× 这几个按钮显不显示
 *   navDraft    未保存的草稿顺序（null = 没改动）
 *   Prefs       已保存的顺序
 *
 * 交互：
 *   点「调整侧边栏」→ navEditing = true，侧边栏露出 ▲▼×
 *   点 ▲▼×          → 只改 navDraft，侧边栏立刻按草稿重排（预览），不落盘
 *   点「保存排列」  → 草稿写进 Prefs，并**退出调整态**（按钮收起）
 *   点「撤销修改」  → 丢掉草稿，退出调整态
 *   点「恢复初始」  → 立刻恢复默认顺序并落盘，保持调整态（接着还能调）
 *
 * **调整态刻意不持久化**：以前它绑在 Prefs.navCustom 上，于是保存之后按钮
 * 仍在显示、还能继续改动，用户以为「保存」没生效。现在它只活在本次会话里，
 * 保存即结束——重启软件也一定回到「不显示按钮」的干净状态。
 */

/** 是否处于调整态（不持久化：保存 / 撤销 / 离开设置页都会结束） */
let navEditing = false;
/** 草稿顺序；null 表示没有未保存的改动 */
let navDraft = null;
/** 上次保存时间，用于状态提示 */
let navSavedAt = '';

/** 已保存的顺序（不含草稿） */
function savedNavOrder() {
  const saved = window.Prefs ? window.Prefs.get('navOrder', null) : null;
  return window.NavOrder
    ? window.NavOrder.normalize(saved || window.NavOrder.defaultOrder())
    : [];
}

/** 界面应当显示的顺序：有草稿用草稿，否则用已保存的 */
function currentNavOrder() {
  return navDraft ? navDraft.slice() : savedNavOrder();
}

function navDirty() {
  if (!navDraft) return false;
  return navDraft.join(',') !== savedNavOrder().join(',');
}

function saveNavOrder(order) {
  if (!window.Prefs || !window.NavOrder) return;
  window.Prefs.set('navOrder', window.NavOrder.normalize(order));
  navSavedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  // 一并记下时间：重启软件后状态行还能显示「上次保存于几点」
  window.Prefs.set('navOrderSavedAt', navSavedAt);
}

/** 改草稿：只动内存，等用户点保存 */
function setNavDraft(order) {
  navDraft = window.NavOrder ? window.NavOrder.normalize(order) : [];
  applyNavOrder();
}

function navTimeText() {
  return navSavedAt || '';
}

/** 侧边栏设置里的操作反馈。3 秒后自己消失，只在这一页可见 */
let navFlashTimer = null;
function navFlash(text, isError) {
  const el = $('#navFlash');
  if (!el) return;
  clearTimeout(navFlashTimer);
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('is-error', !!isError);
  if (text) {
    navFlashTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }
}

/** 给每个 nav-item 补上「文字 span + 工具条」，重复调用无副作用 */
function ensureNavStructure() {
  const nav = $('#nav');
  if (!nav) return;
  $$('.nav-item').forEach((btn) => {
    if (btn.dataset.pluginNav) return; // 插件动态项不参与排序
    if (!btn.querySelector('.nav-label')) {
      const label = document.createElement('span');
      label.className = 'nav-label';
      label.textContent = btn.textContent.trim();
      btn.textContent = '';
      btn.appendChild(label);
    }
    if (!btn.querySelector('.nav-tools')) {
      const tools = document.createElement('span');
      tools.className = 'nav-tools';
      tools.innerHTML = '<span class="nav-tool" data-nav-tool="up" title="上移">▲</span>'
        + '<span class="nav-tool" data-nav-tool="down" title="下移">▼</span>'
        + '<span class="nav-tool" data-nav-tool="remove" title="从侧边栏移除">×</span>';
      btn.appendChild(tools);
    }
    if (window.NavOrder && window.NavOrder.isLocked(btn.dataset.view)) {
      const del = btn.querySelector('[data-nav-tool="remove"]');
      if (del) del.remove();
    }
  });
}

function applyNavOrder() {
  const nav = $('#nav');
  if (!nav || !window.NavOrder) return;
  ensureNavStructure();

  const order = currentNavOrder();
  const items = $$('.nav-item', nav).filter((b) => b.dataset.view && !b.dataset.pluginNav);
  const byView = new Map(items.map((b) => [b.dataset.view, b]));

  // appendChild 会移动已有节点，按目标顺序追加一遍就完成了重排
  for (const view of order) {
    const btn = byView.get(view);
    if (!btn) continue;
    btn.classList.remove('is-nav-hidden');
    nav.appendChild(btn);
  }
  // 不在顺序里的视为用户主动移除
  for (const [view, btn] of byView) {
    if (!order.includes(view)) btn.classList.add('is-nav-hidden');
  }

  // 动态插件项永远紧跟「设置」之前，不受自定义顺序影响
  const settings = byView.get('settings');
  $$('.plugin-nav-item', nav).forEach((el) => nav.insertBefore(el, settings || null));

  // 文字以 NavOrder 为准：改名只需要改一处，不用同步改 HTML
  for (const [view, btn] of byView) {
    const label = btn.querySelector('.nav-label');
    const text = window.NavOrder.labelOf(view);
    if (label && text && label.textContent !== text) label.textContent = text;
  }

  // 上移下移按钮的可用状态：第一项不能再上移，最后一项不能再下移
  const visible = order.filter((v) => byView.has(v));
  visible.forEach((view, i) => {
    const btn = byView.get(view);
    const up = btn.querySelector('[data-nav-tool="up"]');
    const down = btn.querySelector('[data-nav-tool="down"]');
    if (up) up.classList.toggle('is-disabled', i === 0);
    if (down) down.classList.toggle('is-disabled', i === visible.length - 1);
  });

  nav.classList.toggle('is-editing', navEditing);
  renderNavCustomHint();
}

function renderNavCustomHint() {
  const hint = $('#navCustomHint');
  const tag = $('#navCustomTag');
  const adjustBtn = $('#btnNavAdjust');
  const saveBtn = $('#btnNavSave');
  const discardBtn = $('#btnNavDiscard');
  const exitBtn = $('#btnNavExit');
  const resetBtn = $('#btnNavReset');
  const box = $('#panelNav');
  if (!window.NavOrder) return;

  const order = currentNavOrder();
  const hidden = window.NavOrder.hiddenOf(order);
  const isDefault = order.join(',') === window.NavOrder.defaultOrder().join(',');
  const dirty = navDirty();

  // 「调整侧边栏」只在未进入调整态时出现；进入后换成「保存排列 / 撤销修改 / 退出调整」。
  // 这样保存完按钮自动收起，用户不会以为还能继续改。
  if (adjustBtn) adjustBtn.hidden = navEditing;
  if (saveBtn) { saveBtn.hidden = !navEditing; saveBtn.disabled = !dirty; }
  if (discardBtn) { discardBtn.hidden = !navEditing; discardBtn.disabled = !dirty; }
  // 退出**永远可点**：进去但一个按钮都没动时，保存和撤销都是灰的，
  // 没有它就没有任何出口，用户只能关窗口。
  if (exitBtn) { exitBtn.hidden = !navEditing; exitBtn.disabled = false; }
  if (resetBtn) resetBtn.hidden = navEditing;

  if (box) box.classList.toggle('is-dirty', navEditing && dirty);

  if (tag) {
    tag.textContent = navEditing
      ? (dirty ? '调整中 · 未保存' : '调整中')
      : (isDefault ? '默认排列' : '已自定义');
  }

  if (!hint) return;
  if (navEditing) {
    hint.textContent = dirty
      ? '正在调整：点「保存排列」生效，点「撤销修改」还原，点「退出调整」放弃'
        + (hidden.length ? ` · ${hidden.length} 项将移出侧边栏（${hidden.map((v) => window.NavOrder.labelOf(v)).join('、')}）` : '')
      : '正在调整：用左侧各项右侧的 ▲▼× 重排或移除，改完点「保存排列」；不想改了直接点「退出调整」';
    return;
  }
  if (isDefault) {
    hint.textContent = '当前：默认排列。点「调整侧边栏」可以重排';
    return;
  }
  const when = navTimeText();
  hint.textContent = (hidden.length
    ? `已保存 · ${hidden.length} 项不在侧边栏（${hidden.map((v) => window.NavOrder.labelOf(v)).join('、')}）`
    : '已保存 · 自定义顺序')
    + (when ? ` · ${when}` : '');
}

$('#nav').addEventListener('click', (e) => {
  const tool = e.target.closest('[data-nav-tool]');
  if (!tool) return;
  // capture 阶段就拦下来：否则会冒泡到「切换视图」，点一下直接跳页
  e.preventDefault();
  e.stopPropagation();
  const item = tool.closest('.nav-item');
  if (!item || !window.NavOrder) return;
  // 不在调整态时这些按钮本来就不显示，这里再兜一层：万一被点到也不该改东西
  if (!navEditing) return;
  const view = item.dataset.view;
  const kind = tool.dataset.navTool;

  if (kind === 'remove') {
    const res = window.NavOrder.remove(currentNavOrder(), view);
    if (!res.removed) {
      if (res.reason) navFlash(res.reason, true);
      return;
    }
    setNavDraft(res.order);
    // 删的正好是当前页就跳走，避免停在一个从侧栏消失的页面里。
    // 跳到排在最前面的那一项（而不是固定回概览）——概览本身也可能被删掉。
    if (lastView === view) {
      const fallback = res.order.find((v) => v !== view) || 'settings';
      setActiveView(fallback);
    }
    return;
  }

  const delta = kind === 'up' ? -1 : 1;
  setNavDraft(window.NavOrder.move(currentNavOrder(), view, delta));
}, true);

/** 进入调整态：露出 ▲▼×，草稿从已保存的顺序起步 */
function beginNavAdjust() {
  if (!window.NavOrder || navEditing) return;
  navEditing = true;
  navDraft = savedNavOrder();
  applyNavOrder();
  navFlash('已进入调整：用侧边栏各项右侧的 ▲▼× 重排，改完点「保存排列」');
}

/** 退出调整态：草稿清空，按钮收起 */
function endNavAdjust() {
  navEditing = false;
  navDraft = null;
  applyNavOrder();
}

$('#btnNavAdjust').addEventListener('click', () => beginNavAdjust());

$('#btnNavSave').addEventListener('click', () => {
  if (!navEditing) return;
  if (!navDirty()) {
    // 没改动也允许「保存」，效果就是单纯结束调整——比让按钮灰着更符合直觉
    endNavAdjust();
    navFlash('排列未变化');
    return;
  }
  saveNavOrder(navDraft);
  endNavAdjust();
  navFlash('排列已保存，立即生效');
});

$('#btnNavDiscard').addEventListener('click', () => {
  if (!navEditing) return;
  const had = navDirty();
  endNavAdjust();
  navFlash(had ? '已撤销未保存的调整' : '已结束调整');
});

/**
 * 退出调整：不做任何保存，丢掉草稿并收起 ▲▼×。
 *
 * 存在的理由：进入调整态后如果一次都没点 ▲▼×，「保存排列」和「撤销修改」
 * 都是禁用状态（没有改动可存、也没有改动可撤），而「调整侧边栏」在调整态下是隐藏的 ——
 * 于是四个按钮里三个不可点、一个不显示，用户被卡在调整态里出不来，只能关窗口。
 * 这个按钮**永远可点**。
 */
$('#btnNavExit').addEventListener('click', () => {
  if (!navEditing) return;
  const had = navDirty();
  endNavAdjust();
  navFlash(had ? '已退出调整，改动未保存' : '已退出调整');
});

$('#btnNavReset').addEventListener('click', () => {
  // 「恢复初始」是一次性动作：回到默认顺序并**结束调整态**。
  //
  // 之前这里故意保持（甚至自动进入）调整态，想法是「恢复完还能接着调」，
  // 结果用户点完发现 ▲▼× 又出现在每一项上、标签写着「调整中」，
  // 直觉上就是「没恢复干净」。要接着调，再点一次「调整侧边栏」即可。
  if (!window.NavOrder) return;
  navDraft = null;
  saveNavOrder(window.NavOrder.defaultOrder());
  // 默认排列不算「自定义保存」，时间戳没意义，清掉免得状态行显示个旧时间
  navSavedAt = '';
  window.Prefs.set('navOrderSavedAt', '');
  navEditing = false;
  applyNavOrder();
  navFlash('已恢复初始排列');
});

function initNavCustom() {
  if (!window.NavOrder) return;
  // 上次保存时间从偏好里读回来，重启后状态行不至于变成空白
  navSavedAt = (window.Prefs && window.Prefs.get('navOrderSavedAt', '')) || '';
  // 每次启动都从「非调整态」开始：▲▼× 默认不出现，
  // 想看就点一次「调整侧边栏」。这一点不要改成读偏好——
  // 以前按偏好恢复,结果保存后按钮一直挂着，用户以为保存没生效。
  navEditing = false;
  navDraft = null;
  applyNavOrder();
}


function setActiveNav(name, pluginId) {
  $$('.nav-item').forEach((button) => {
    const active = pluginId
      ? button.dataset.pluginNav === pluginId
      : button.dataset.view === name && !button.dataset.pluginNav;
    button.classList.toggle('is-active', active);
  });
}

function setActiveView(name) {
  // 离开创作中心就退出专注模式，否则侧栏一直藏着、别的页面全被挤没
  if (name !== 'writer' && writerFocusOn) setWriterFocus(false);
  // 离开「设置」页就退出侧边栏的调整态：草稿还原、▲▼× 收起。
  // 不这么做的话，用户点完「调整侧边栏」切去别的页面再回来，
  // 按钮还挂在那儿，和他「刚才好像已经弄完了」的印象对不上。
  if (name !== 'settings' && typeof navEditing === 'boolean' && navEditing) {
    endNavAdjust();
  }
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

  if (name === 'writer' && !writerEditorBook) {
    // 先刷列表再对账：后台刚建的书会在这里补进来
    loadWriterBooks().then(() => adoptNewPlatformBooks());
  }
  if (name === 'writer') {
    // 词库可能在设置里加过词，进码字台时重读一遍再扫，避免用的是旧表
    loadWriterBadwordWords().then(() => { if (writerEditorBook) scanWriterBadwords(); });
  }
  if (name === 'writing-stats') loadWritingStats().then(renderWritingStats);
  if (name === 'books') ensureBoardReady();
  // 道具获得是数据看板的一部分，进这一页就跟着一起画

  // 回到抓取页时按已有数据重算引导状态（读过列表 / 抓过没抓过）
  if (name === 'sync') renderCrawlGuide();
  // 普通插件页随导航退出；常驻插件持有独立 iframe，继续运行。
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
  ['#btnCloseBrowser', '#btnReload', '#btnBackToView', '#btnHome', '#btnClearInboxTop'].forEach((sel) => {
    $(sel).hidden = !open;
  });
  if (open) {
    browserReturnView = lastView;
    const back = $('#btnBackToView');
    back.textContent = `← ${VIEW_TITLES[browserReturnView] || '上一界面'}`;
    back.title = `回到「${VIEW_TITLES[browserReturnView] || '上一界面'}」继续修改，后台这一页不会丢`;
  }
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
    // 已经有一页在看着（比如刚从后台回创作中心改稿），就只把它挂回来，
    // 不要重新 loadURL —— 否则「打开作者后台」会把停着的上传章节页冲回首页
    const state = url ? null : await window.api.browser.state().catch(() => null);
    if (state && state.ready && state.url) {
      await window.api.browser.show(currentRect());
      // show 不导航，不会触发 browser-state；主动同步一次，密码本工具条才会出现
      applyBrowserState(state);
    } else {
      await window.api.browser.open(currentRect(), url);
      const now = await window.api.browser.state().catch(() => null);
      if (now) applyBrowserState(now);
    }
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
  // 弹窗收起后重新挂载：同样没有导航事件，主动同步一次状态
  const state = await window.api.browser.state().catch(() => null);
  if (state) applyBrowserState(state);
}

window.showBrowserKeepPage = showBrowserKeepPage;

$('#btnOpenBrowser').addEventListener('click', () => openBrowser());
$('#btnGoAuthor').addEventListener('click', () => openBrowser());
$('#btnCloseBrowser').addEventListener('click', () => closeBrowser());
$('#btnReload').addEventListener('click', () => window.api.browser.reload());
// 只把后台视图从窗口上摘下来，平台页面本身不销毁：再点「跳转后台并发布」还是刚才那张表单
$('#btnBackToView').addEventListener('click', async () => {
  const target = browserReturnView || 'writer';
  if (browserOpen) await closeBrowser();
  setActiveView(target);
});
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

/**
 * 喵语是第三方页面，不会自己跟随主题。
 * 把当前主题的关键颜色整理一份推给主进程，由它在页面里注入 / 移除暗色样式。
 */
function miaoyuThemePayload() {
  const el = document.documentElement;
  const css = getComputedStyle(el);
  const read = (name, fallback) => {
    const value = String(css.getPropertyValue(name) || '').trim();
    return value || fallback;
  };
  return {
    dark: el.dataset.theme === 'dark',
    colors: {
      bg: read('--bg', '#fbf7ef'),
      card: read('--surface', '#ffffff'),
      card2: read('--surface-2', '#f4eef8'),
      text: read('--text', '#2b2338'),
      muted: read('--text-3', '#8b8098'),
      line: read('--border', 'rgba(120,100,150,.18)'),
      accent: read('--accent', '#b491e0'),
    },
  };
}

async function pushMiaoyuTheme() {
  if (!window.api || !window.api.miaoyu || typeof window.api.miaoyu.theme !== 'function') return;
  try { await window.api.miaoyu.theme(miaoyuThemePayload()); } catch (_) { /* 主题推送失败不影响浏览 */ }
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
    // 视图可能是上次留在内存里的，样式要按当前主题重新上一次
    await pushMiaoyuTheme();
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

// 正停在喵语页时切主题，立刻重上一遍配色（页面留在内存里，下次进来也会补）
document.addEventListener('theme-changed', () => {
  if (miaoyuOpen) pushMiaoyuTheme();
});

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
    // 必须是「之前确实停在某个登录页」，才谈得上从登录页跳出来。
    // 注意还要 url 非空：lastState 的初始值是 { isLoginPage: true, url: '' }，
    // 不加这个条件，新用户第一次打开后台（首页 → 还没跳登录页）就会被判定成登录成功。
    const wasLoginPage = !!(lastState && lastState.isLoginPage && lastState.url);
    lastState = data;
    renderConn(data);
    updateVaultBar(data);

    // 「登录页 → 作者后台」= 这一次真的登录成功了。
    // 只认这个转变：单纯打开后台首页（还没跳登录页）不算，
    // 否则新用户刚点「打开作者后台」就会被当成登录成功。
    if (wasLoginPage && !data.isLoginPage && isAuthorUrl(data.url)) {
      loginJustSucceeded = true;
    }
    // 引导去抓评论：内部会再确认一次「确实登录成功」
    maybeShowAfterLoginGuide(data);
    // 后台的书目页加载完就去对一次账：新建的书在这里被补进作品库
    if (/author\.ciweimao\.com\/book_manage/i.test(String(data.url || ''))) {
      scheduleAdoptNewBooks();
    }
    // 应用启动时通常停在登录页。登录成功后即使没有跳到 book_manage，
    // 也要检查已绑定作品的章节目录，不能只等用户手动点一次创作中心。
    if (data.url && !data.isLoginPage && wasLoginPage) {
      scheduleAdoptNewBooks();
      // 刚登录成功，后台页面上才有作者名。这时候绑一次，密码本里的
      // 「账号」和「笔名」就对上号了，多账号用户下次能按笔名选。
      bindAuthorQuietly('');
    }
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

// ------------------------------------------------------------ 密码本
//
// 界面这一侧只负责「显示账号列表 + 发指令」。
// 密码的解密与填入都在主进程里完成，这里拿不到、也不需要明文。

let vaultItems = [];
/** 「记住这次输入」按钮上短暂显示保存结果的定时器 */
let flashTimer = 0;
/** 多选管理里勾中的记录 id（只在界面内有效，不落盘） */
const vaultPicked = new Set();

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
  // 提示文字一变长，工具条可能从一行变成两行；平台页面是原生视图、压在 HTML 之上，
  // 它的位置是按「当时量到的工具条高度」定的。不重算就会盖住新长出来的那一行 ——
  // 用户看到的正是「点了『记住这次输入』，什么反应都没有」（提示正好在那行上）。
  syncBounds();
}

/**
 * 工具条只要高度变了就要把平台视图重新让位。
 *
 * 覆盖的不止提示文字：展开「怎么用」说明、打开「管理」面板、窗口变窄导致按钮换行，
 * 都会让工具条变高。逐个在调用处补 syncBounds() 早晚会漏，直接盯高度最稳。
 */
if (typeof ResizeObserver !== 'undefined') {
  const vaultBarEl = $('#vaultBar');
  if (vaultBarEl) new ResizeObserver(() => syncBounds()).observe(vaultBarEl);
}

/** 下拉里的显示名：有作者名就以作者名为主，账号放后面 */
function vaultOptionLabel(it) {
  const author = String(it.authorName || '').trim();
  const account = String(it.username || '');
  const suffix = it.mode === 'email' ? '（邮箱登录）' : '';
  if (!author) return `${account}${suffix} · 未标作者名`;
  if (author === account) return `${author}${suffix}`;
  return `${author} · ${account}${suffix}`;
}

function renderVaultPick() {
  const sel = $('#vaultPick');
  if (!vaultItems.length) {
    sel.innerHTML = '<option value="">还没有保存的账号</option>';
    sel.disabled = true;
    $('#btnVaultFill').disabled = true;
    renderVaultManage();
    return;
  }
  sel.innerHTML = vaultItems.map((it) => (
    `<option value="${escapeHtml(it.id)}">${escapeHtml(vaultOptionLabel(it))}</option>`
  )).join('');
  sel.disabled = false;
  $('#btnVaultFill').disabled = false;
  renderVaultManage();
}

/** 多选管理面板：勾选后可以批量删除，也可以逐条标作者名 */
function renderVaultManage() {
  const box = $('#vaultManageList');
  if (!box) return;
  const count = $('#vaultManageCount');
  if (count) count.textContent = `已选 ${vaultPicked.size} 条`;

  if (!vaultItems.length) {
    box.innerHTML = '<div class="vault-manage-row vault-manage-empty">还没有保存的账号</div>';
    return;
  }
  box.innerHTML = vaultItems.map((it) => {
    const author = String(it.authorName || '').trim();
    // 用 div 而不是 label：行内还有「填入」「标作者名」两个按钮，
    // 放在 label 里点按钮会连带切换复选框，行为很怪
    return `
      <div class="vault-manage-row">
        <input type="checkbox" data-vault-pick="${escapeHtml(it.id)}" ${vaultPicked.has(it.id) ? 'checked' : ''} />
        <span class="vault-manage-author${author ? '' : ' is-missing'}">${escapeHtml(author || '未标作者名')}</span>
        <span class="vault-manage-account">${escapeHtml(it.username)}${it.mode === 'email' ? '（邮箱）' : ''}</span>
        <button class="link-btn" data-vault-fill="${escapeHtml(it.id)}" type="button">填入</button>
        <button class="link-btn" data-vault-author="${escapeHtml(it.id)}" type="button">${author ? '改作者名' : '标作者名'}</button>
      </div>`;
  }).join('');
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
      $('#btnVaultBind').disabled = true;
      if (!keepHint) setVaultHint('系统加密不可用，出于安全考虑不保存密码', 'error');
      return;
    }

    $('#btnVaultCapture').disabled = false;
    $('#btnVaultBind').disabled = false;
    renderVaultPick();
    if (!keepHint) {
      const unbound = vaultItems.filter((it) => !String(it.authorName || '').trim()).length;
      setVaultHint(
        vaultItems.length
          ? `已保存 ${vaultItems.length} 个账号`
            + (unbound ? ` · ${unbound} 条还没标作者名` : ' · 都已标作者名')
            + ' · 密码加密后仅存本机'
          : '先在页面里填好账号密码，再点「记住这次输入」',
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
  if (show) {
    refreshVault(false);
    showVaultIntro(false);
  } else if (!$('#vaultIntro').hidden) {
    // 登录成功后工具条收起，说明也跟着收；下次再回到登录页由「怎么用」自己看
    $('#vaultIntro').hidden = true;
  }
  syncBounds();
}

/**
 * 把一份浏览器状态同步到界面。
 *
 * `browser-state` 事件只会在导航/加载时来。重新「挂回」一个已经加载好的
 * 后台页面（show）不产生任何导航，靠事件就永远等不到 —— 表现就是刚点
 * 「作者后台」时密码本工具条不出现，点一次刷新才出来。所以 open/show
 * 完成后主动取一次 state 走这里。
 */
function applyBrowserState(state) {
  if (!state || typeof state !== 'object') return;
  lastState = state;
  renderConn(state);
  updateVaultBar(state);
}

// ------------------------------------------------------------ 密码本首次说明

/**
 * 密码本这条工具条只在登录页出现，第一次见面没人知道该先点哪个，所以自动展开一次用法。
 * 说明放在工具条的第二行（不是全屏弹窗）：平台页面是原生视图、压在 HTML 之上，
 * 全屏遮罩会被它挡住。展开后调 syncBounds() 把平台视图往下推，两者不会互相盖。
 */
function showVaultIntro(force) {
  const row = $('#vaultIntro');
  if (!row || !row.hidden) return;
  const seen = !!(window.Prefs && window.Prefs.get('vaultIntroShown', false));
  if (!force && seen) return;
  row.hidden = false;
  // 一展开就算「已经见过」：只自动出现这一次，之后想看就点「怎么用」
  if (!seen && window.Prefs) window.Prefs.set('vaultIntroShown', true);
  syncBounds();
}

function closeVaultIntro() {
  const row = $('#vaultIntro');
  if (!row || row.hidden) return;
  row.hidden = true;
  syncBounds();
}

$('#btnVaultIntroOk').addEventListener('click', closeVaultIntro);
$('#btnVaultHelp').addEventListener('click', () => {
  if ($('#vaultIntro').hidden) showVaultIntro(true);
  else closeVaultIntro();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#vaultIntro').hidden) closeVaultIntro();
});

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
  // 记下原文字，结束时按这个复原（不要在别处再写死一遍「记住这次输入」）
  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;

  /**
   * 结果直接写在按钮上。
   *
   * 提示条在工具条最右端、字号只有 10px，用户点完按钮视线还在按钮上，
   * 根本没往右边看 —— 反馈「已保存」的提示条一直被当成「没反应」。
   * 按钮自己变一下，是最不可能漏掉的反馈。
   */
  const flash = (text, ok) => {
    btn.textContent = text;
    btn.classList.toggle('is-flash-ok', !!ok);
    btn.classList.toggle('is-flash-err', !ok);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('is-flash-ok', 'is-flash-err');
    }, 1800);
  };

  btn.disabled = true;
  setVaultHint('正在保存…');
  try {
    const res = await window.api.vault.capture();
    vaultItems = res.items || [];
    renderVaultPick();
    if (res.item) $('#vaultPick').value = res.item.id;
    setVaultHint(`已保存：${res.item ? res.item.username : ''} · 下次点「填入」即可`, 'ok');
    flash('已保存 ✓', true);
    // 登录页还开着，趁后台能读就顺手把作者名认下来
    bindAuthorQuietly(res.item && res.item.id);
  } catch (err) {
    const msg = ipcError(err);
    setVaultHint(msg, 'error');
    flash('没保存 · 看右侧提示', false);
  } finally {
    btn.disabled = false;
  }
});

/** 静默尝试绑定作者名：读不到很正常（登录页上本来就没有作者名），不打扰用户 */
async function bindAuthorQuietly(id) {
  try {
    const res = await window.api.vault.bindAuthor(id || '');
    if (res && res.ok) {
      vaultItems = res.items || [];
      renderVaultPick();
      setVaultHint(`作者名已记为「${res.authorName}」`, 'ok');
    }
    return res;
  } catch (_) {
    return null;
  }
}

/* ---------- 密码本：作者名匹配与多选管理 ---------- */

function toggleVaultManage(show) {
  const box = $('#vaultManage');
  if (!box) return;
  box.hidden = show === undefined ? !box.hidden : !show;
  if (!box.hidden) renderVaultManage();
}

$('#btnVaultManage').addEventListener('click', () => toggleVaultManage());

$('#btnVaultManageClose').addEventListener('click', () => toggleVaultManage(false));

/** 手动认作者名：读当前后台页面；读不到就让用户手填，不瞎猜 */
$('#btnVaultBind').addEventListener('click', async () => {
  const btn = $('#btnVaultBind');
  btn.disabled = true;
  setVaultHint('正在读取当前后台的作者名…');
  try {
    const res = await window.api.vault.bindAuthor('');
    if (res && res.ok) {
      vaultItems = res.items || [];
      renderVaultPick();
      setVaultHint(`作者名已记为「${res.authorName}」`, 'ok');
    } else if (res && res.reason === 'no-author-name') {
      setVaultHint('页面上没找到作者名，可以点「管理」逐条手填', 'error');
    } else {
      setVaultHint('还没有可绑定的记录，先「记住这次输入」', 'error');
    }
  } catch (err) {
    setVaultHint(ipcError(err), 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#vaultManageList').addEventListener('change', (e) => {
  const box = e.target.closest('[data-vault-pick]');
  if (!box) return;
  if (box.checked) vaultPicked.add(box.dataset.vaultPick);
  else vaultPicked.delete(box.dataset.vaultPick);
  const count = $('#vaultManageCount');
  if (count) count.textContent = `已选 ${vaultPicked.size} 条`;
});

$('#vaultManageList').addEventListener('click', async (e) => {
  const fillBtn = e.target.closest('[data-vault-fill]');
  if (fillBtn) {
    $('#vaultPick').value = fillBtn.dataset.vaultFill;
    $('#btnVaultFill').click();
    return;
  }
  const authorBtn = e.target.closest('[data-vault-author]');
  if (!authorBtn) return;
  const id = authorBtn.dataset.vaultAuthor;
  const item = vaultItems.find((x) => x.id === id);
  const name = await askText({
    title: '这条账号的作者名',
    hint: '填你在刺猬猫用的笔名，以后就能按笔名认出这个账号',
    value: (item && item.authorName) || '',
    okText: '保存',
  });
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    setVaultHint('作者名不能为空', 'error');
    return;
  }
  try {
    const res = await window.api.vault.setAuthor(id, trimmed);
    vaultItems = res.items || [];
    renderVaultPick();
    setVaultHint(`已记为「${trimmed}」`, 'ok');
  } catch (err) {
    setVaultHint(ipcError(err), 'error');
  }
});

$('#btnVaultSelectAll').addEventListener('click', () => {
  vaultItems.forEach((it) => vaultPicked.add(it.id));
  renderVaultManage();
});

$('#btnVaultSelectNone').addEventListener('click', () => {
  vaultPicked.clear();
  renderVaultManage();
});

$('#btnVaultDeletePicked').addEventListener('click', async () => {
  if (!vaultPicked.size) {
    setVaultHint('先勾选要删除的记录', 'error');
    return;
  }
  const names = vaultItems
    .filter((it) => vaultPicked.has(it.id))
    .map((it) => String(it.authorName || '').trim() || it.username);
  if (!window.confirm(`确定从本机删除这 ${names.length} 条记录？\n\n${names.join('、')}\n\n此操作不可恢复。`)) return;
  try {
    let items = vaultItems;
    for (const id of Array.from(vaultPicked)) {
      const res = await window.api.vault.remove(id);
      items = res.items || items;
    }
    vaultItems = items;
    vaultPicked.clear();
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
let reviewType = 'all';
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
let readerHistory = { version: 1, readers: {} };
let readerWatchlist = [];
let reviewConfig = { high: 70, mid: 45, customWords: [], protectedReaders: [] };

const PAGE_SIZE = 60;

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  // new Date('坏数据') 不会抛异常，getFullYear() 会返回 NaN；
  // 只靠 try/catch 接不住，界面会显示 NaN-NaN-NaN。
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function splitSettingList(value) {
  return [...new Set(String(value || '').split(/[\n,，;；]+/).map((x) => x.trim()).filter(Boolean))];
}

function normalizeReviewConfig(raw) {
  const o = raw || {};
  let high = Math.min(100, Math.max(1, Number(o.high) || 70));
  let mid = Math.min(100, Math.max(1, Number(o.mid) || 45));
  if (mid >= high) mid = Math.max(1, high - 1);
  return {
    high,
    mid,
    customWords: Array.isArray(o.customWords) ? splitSettingList(o.customWords.join('\n')) : [],
    protectedReaders: Array.isArray(o.protectedReaders) ? splitSettingList(o.protectedReaders.join('\n')) : [],
  };
}

function renderReviewSettings() {
  $('#reviewHigh').value = reviewConfig.high;
  $('#reviewMid').value = reviewConfig.mid;
  $('#reviewCustomWords').value = reviewConfig.customWords.join('\n');
  $('#reviewProtectedReaders').value = reviewConfig.protectedReaders.join('\n');
}

async function saveReviewSettings() {
  reviewConfig = normalizeReviewConfig({
    high: $('#reviewHigh').value,
    mid: $('#reviewMid').value,
    customWords: splitSettingList($('#reviewCustomWords').value),
    protectedReaders: splitSettingList($('#reviewProtectedReaders').value),
  });
  await window.api.data.write('review-settings.json', reviewConfig);
  renderReviewSettings();
  if (crawlData && crawlData.items) { runReview(); renderAll(); }
  const hint = $('#reviewSettingsHint');
  hint.textContent = `已保存：高风险 ${reviewConfig.high} 分，中风险 ${reviewConfig.mid} 分。`;
  setTimeout(() => { hint.textContent = '设置保存后会立即重算当前评论，无需重新抓取。'; }, 1800);
}

function watchedReader(readerId) {
  return readerWatchlist.find((x) => String(x.readerId) === String(readerId));
}

async function saveReaderWatchlist() {
  await window.api.data.write('reader-watchlist.json', { version: 1, items: readerWatchlist });
}

async function toggleReaderWatch(item) {
  const readerId = String(item.readerId || '');
  if (!readerId || readerId === 'unknown') return;
  const pos = readerWatchlist.findIndex((x) => String(x.readerId) === readerId);
  if (pos >= 0) readerWatchlist.splice(pos, 1);
  else readerWatchlist.push({ readerId, nickname: item.nickname || '', reason: '手动关注', at: new Date().toISOString() });
  await saveReaderWatchlist();
  renderList();
}

async function mergeReaderHistory(items) {
  const store = readerHistory && readerHistory.readers ? readerHistory : { version: 1, readers: {} };
  for (const it of items || []) {
    const readerId = String(it.readerId || '');
    if (!readerId) continue;
    const rec = store.readers[readerId] || { nickname: '', books: {}, samples: [], seen: [], count: 0, lastAt: '' };
    rec.books = rec.books && typeof rec.books === 'object' ? rec.books : {};
    rec.samples = Array.isArray(rec.samples) ? rec.samples : [];
    rec.seen = Array.isArray(rec.seen) ? rec.seen : [];
    rec.count = Number(rec.count) || 0;
    rec.nickname = it.nickname || rec.nickname;
    if (it.bookId) rec.books[String(it.bookId)] = it.bookName || String(it.bookId);
    const key = String(it.id || `${it.kind || ''}:${it.content || ''}`);
    if (!rec.seen.includes(key)) {
      rec.seen.push(key);
      rec.count += 1;
      if (it.content && !rec.samples.includes(it.content)) rec.samples.push(it.content);
    }
    rec.seen = rec.seen.slice(-200);
    rec.samples = rec.samples.slice(-50);
    rec.lastAt = new Date().toISOString();
    store.readers[readerId] = rec;
  }
  readerHistory = store;
  await window.api.data.write('reader-history.json', store);
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
    renderCrawlGuide();
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
  // 完成提示里那个「去数据看板刷新」：跳过去之后把「刷新数据」闪一下，
  // 否则到了新页面还是得自己找按钮在哪
  const jump = n.querySelector('[data-jump]');
  if (jump) {
    jump.addEventListener('click', () => {
      setTimeout(() => {
        const btn = $('#btnRefreshStats');
        if (!btn) return;
        btn.classList.add('is-pulse');
        btn.scrollIntoView({ block: 'nearest' });
        setTimeout(() => btn.classList.remove('is-pulse'), 2400);
      }, 80);
    });
  }
}

/**
 * 抓取的三步引导：读列表 → 抓取 → 到数据看板刷新。
 * 状态完全由已有数据推出来（有没有作品列表、有没有抓过），所以切回这个界面时
 * 不用额外记忆，重新算一遍就是对的。
 */
function renderCrawlGuide() {
  const crawled = !!(crawlData && Array.isArray(crawlData.items) && crawlData.items.length);
  // 抓过就说明列表一定读过：重启后 bookList 是空的，不能因此把第一步又点亮
  const listed = bookList.length > 0 || crawled;
  const state = {
    list: listed ? 'done' : 'active',
    crawl: crawled ? 'done' : (listed ? 'active' : ''),
    // 抓完才提示第三步；数据看板那边刷不刷新，这里无从得知，就不擅自打勾
    refresh: crawled ? 'active' : '',
  };
  $$('#crawlGuide li').forEach((li) => {
    const s = state[li.dataset.step] || '';
    li.classList.toggle('is-done', s === 'done');
    li.classList.toggle('is-active', s === 'active');
  });
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
    const kinds = [];
    if ($('#crawlTsukkomi').checked) kinds.push('tsukkomi');
    if ($('#crawlReview').checked) kinds.push('review');
    if (!kinds.length) throw new Error('请至少选择一种抓取类型');
    const result = await window.Crawler.crawlComments({
      bookIds: [...pickedBooks],
      kinds,
      maxPages,
      shouldStop: () => crawlStop,
      onProgress: (p) => {
        if (p.phase === 'book-start') {
          $('#crawlText').textContent = `开始读取第 ${p.bookIndex}/${p.bookTotal} 本的${p.kindName}…`;
        } else if (p.phase === 'book-info') {
          $('#crawlText').textContent = `《${p.bookName}》${p.kindName}共 ${p.pages} 页`;
        } else if (p.phase === 'page') {
          const withinBook = (p.completedKinds + p.page / p.pages) / p.kindTotal;
          const overall = ((p.bookIndex - 1) + withinBook) / p.bookTotal;
          $('#crawlBar').style.width = Math.round(overall * 100) + '%';
          $('#crawlText').textContent =
            `《${p.bookName}》${p.kindName} ${p.page}/${p.pages} 页 · 本类 ${p.kindCount} 条 · 累计 ${p.total} 条`;
        }
      },
    });

    await window.api.data.write('tsukkomi.json', result);
    await mergeReaderHistory(result.items);
    crawlData = result;
    runReview();
    renderAll();

    $('#crawlBar').style.width = '100%';
    renderCrawlGuide();
    const truncated = result.books.some((b) => Object.values(b.kinds || {}).some((x) => x.pages >= maxPages)) && maxPages < 999;
    showCrawlNotice(
      `抓取完成：${result.items.length} 条评论（含间贴/书评），来自 ${result.books.length} 部作品。` +
      (truncated ? '<br>注意：已按「每本最多抓」限制截断，如需全量请调大页数。' : '') +
      '<div class="crawl-next">'
      + '<b>下一步</b>：这批评论已经进「评论审查」；字数、收藏、订阅要去「数据看板」点一次「刷新数据」才会更新。'
      + '<button class="btn primary btn-sm" type="button" data-jump="books">去数据看板刷新</button>'
      + '</div>'
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
  let all = (crawlData && crawlData.items) || [];
  if (reviewBook !== 'all') all = all.filter((x) => String(x.bookId || '') === String(reviewBook));
  if (reviewType !== 'all') all = all.filter((x) => String(x.kind || 'tsukkomi') === reviewType);
  return all;
}

function runReview() {
  if (!crawlData || !crawlData.items) { reviewResult = null; signalResult = null; return; }
  // 统计、列表、读者视图都基于「当前选中的作品」，否则单本筛选后数字会对不上
  reviewResult = window.Reviewer.review(scopedItems(), Object.assign({}, reviewConfig, { strictNegative: reviewStrict }));
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

$('#btnSaveReviewSettings').addEventListener('click', () => {
  saveReviewSettings().catch((err) => {
    $('#reviewSettingsHint').textContent = '保存失败：' + String((err && err.message) || err);
  });
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
      ? readers.map((r) => {
        const history = readerHistory.readers[String(r.readerId)] || null;
        const watched = watchedReader(r.readerId);
        return `
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
            ${history ? `<span>历史 ${history.count || 0} 条 · ${Object.keys(history.books || {}).length} 本书</span>` : '<span>暂无历史</span>'}
            ${watched ? '<span class="badge high">已关注</span>' : ''}
            <button class="link-btn" type="button" data-reader-watch="${escapeHtml(r.readerId)}">${watched ? '移出关注' : '加入关注'}</button>
            <button class="link-btn" type="button" data-reader-fan="${escapeHtml(r.readerId)}">查粉丝值</button>
            <span class="hint-line" data-reader-fan-result="${escapeHtml(r.readerId)}"></span>
          </div>
        </div>
      `; }).join('')
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
    const isTsukkomi = (x.kind || 'tsukkomi') === 'tsukkomi';
    const checkable = isTsukkomi && x.level !== 'none';
    const watched = watchedReader(x.readerId);
    return `
      <div class="review-item ${lvClass}${x.handled ? ' is-done' : ''}">
        <div class="review-head">
          ${checkable
            ? `<input type="checkbox" class="review-check" data-check-id="${id}" ${picked.has(String(x.id)) ? 'checked' : ''} />`
            : '<span class="review-check-space"></span>'}
          <span class="review-nick">${escapeHtml(x.nickname || '未知')}</span>
          <span class="badge">${isTsukkomi ? '间贴' : '书评'}</span>
          <span>${escapeHtml(x.time || '')}</span>
          ${x.level === 'high' ? '<span class="badge high">高风险 ' + x.score + '</span>' : ''}
          ${x.level === 'mid' ? '<span class="badge mid">中风险 ' + x.score + '</span>' : ''}
          ${x.handled ? '<span class="badge">已处理</span>' : ''}
          ${watched ? '<span class="badge high">关注读者</span>' : ''}
          ${isTsukkomi ? `<button class="link-btn review-paragraph-btn" type="button" data-paragraph-id="${id}">查看原段</button>` : ''}
          ${isTsukkomi ? `<button class="link-btn review-act" type="button" data-act-id="${id}">${x.handled ? '再看一眼' : '处理'}</button>` : '<span class="hint-line">书评暂仅审查</span>'}
          ${x.readerId ? `<button class="link-btn" type="button" data-reader-watch="${escapeHtml(x.readerId)}">${watched ? '移出关注' : '关注读者'}</button>` : ''}
          ${x.readerId ? `<button class="link-btn" type="button" data-reader-fan="${escapeHtml(x.readerId)}">查粉丝值</button><span class="hint-line" data-reader-fan-result="${escapeHtml(x.readerId)}"></span>` : ''}
          <button class="link-btn review-dismiss" type="button" data-dismiss-id="${id}">剔除</button>
        </div>
        <div class="review-body ${short ? 'is-short' : ''}">${escapeHtml(x.content || '（空）')}</div>
        ${hits}
        <div class="review-meta-line">${escapeHtml(x.bookName || '')}${isTsukkomi ? ` · ${escapeHtml(x.chapterName || '')} · ${escapeHtml(x.paraPos || '')}` : ' · 作品评论区'}</div>
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
  return reviewResult.items.filter((x) => (x.kind || 'tsukkomi') === 'tsukkomi' && picked.has(String(x.id)));
}

function renderBatchBar() {
  const bar = $('#batchBar');
  if (!bar) return;

  // 清掉已经不可选的选择（被剔除、被处理、评分变了）
  if (reviewResult) {
    const valid = new Set(
      reviewResult.items
        .filter((x) => (x.kind || 'tsukkomi') === 'tsukkomi' && x.level !== 'none' && !dismissed.has(String(x.id)))
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

$('#reviewType').addEventListener('change', (e) => {
  reviewType = e.target.value || 'all';
  reviewLimit = PAGE_SIZE;
  picked.clear();
  runReview();
  renderAll();
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
  const watch = e.target.closest('[data-reader-watch]');
  if (watch) {
    const readerId = String(watch.dataset.readerWatch || '');
    const source = (reviewResult && reviewResult.items || []).find((x) => String(x.readerId || '') === readerId)
      || { readerId, nickname: '' };
    toggleReaderWatch(source).catch((err) => execNotice('更新关注名单失败：' + escapeHtml(err.message || err), true));
    return;
  }

  const fan = e.target.closest('[data-reader-fan]');
  if (fan) {
    const readerId = String(fan.dataset.readerFan || '');
    const source = (reviewResult && reviewResult.items || []).find((x) => String(x.readerId || '') === readerId);
    const result = fan.parentElement.querySelector(`[data-reader-fan-result="${CSS.escape(readerId)}"]`);
    if (!source || !result) return;
    fan.disabled = true;
    result.textContent = '查询中…';
    window.Crawler.queryFanValue(source.nickname, source.bookId).then((res) => {
      result.textContent = res && res.ok
        ? `${res.level ? res.level + ' · ' : ''}粉丝值 ${Number(res.value || 0).toLocaleString('zh-CN')}`
        : '未查到粉丝值';
    }).catch((err) => { result.textContent = '查询失败：' + String(err.message || err); })
      .finally(() => { fan.disabled = false; });
    return;
  }

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
  filteredItems().filter((x) => (x.kind || 'tsukkomi') === 'tsukkomi' && x.level === level && !x.handled)
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

/**
 * 优先级作品缓存。
 *
 * 不能只靠 writerBooks：作品列表只在进入「创作中心」时才加载，
 * 用户开机后直接点「数据看板」的话手里没有书目，优先级就成了未知。
 * 所以启动时单独查一次（主进程只读 index.json，很轻），点亮星标后再刷新。
 */
let priorityInfo = null;

async function refreshPriorityInfo() {
  try {
    priorityInfo = await window.api.writer.priority();
  } catch (_) {
    priorityInfo = null;
  }
  return priorityInfo;
}

/**
 * 进数据看板前把这一页依赖的东西准备好。
 *
 * 优先级缓存**每次都刷新**，不只在为空时查：
 * 主进程只是读一下 index.json，很轻；而一旦缓存过期，
 * 用户明明在创作中心点了星标、看板却把另一本排在第一个，看起来就是功能失效。
 */
async function ensureBoardReady() {
  // 顺序：先把书目录进来，再查优先级，最后画。
  // 反过来的话第一次画时 writerBooks 还是空的，只能退回缓存，白画一遍。
  if (!Array.isArray(writerBooks) || !writerBooks.length) {
    await loadWriterBooks().catch(() => {});
  }
  await refreshPriorityInfo();
  renderBoard();
  // 道具获得是这一页的下半部分，作品下拉依赖作品库
  syncPropsBookOptions();
  renderProps();
}

/**
 * 创作中心里点亮星标的那本（优先级最高的）。
 *
 * 规则在 book-priority.js 里，那边有单测。这里只负责把它接到当前书目上。
 */
function priorityBook() {
  if (!window.BookPriority) return null;
  return window.BookPriority.pickPriority(writerBooks, { requirePlatform: true });
}

/**
 * 优先级作品在数据看板里的 bookId；没有就返回空串。
 *
 * 先用已加载的书目算（能反映刚点的星标），书目为空时退回启动时查到的缓存。
 */
function priorityBoardBookId() {
  if (window.BookPriority && Array.isArray(writerBooks) && writerBooks.length) {
    return window.BookPriority.boardBookIdOf(writerBooks);
  }
  return priorityInfo && priorityInfo.platformBookId
    ? String(priorityInfo.platformBookId)
    : '';
}

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

  // 默认停在「全部作品」，**不再自动跳到优先级作品**。
  //
  // 新交互下概览页就是一屏汇总 + 作品列表，优先级作品在列表里排第一并带星标；
  // 自动跳进单本详情反而让人以为「回不到全部」。
  // 唯一要处理的例外：选中的书当天没有快照（删了书 / 换了数据源），退回全部。
  let fellBack = false;
  if (boardBookId && !list.some((b) => String(b.bookId) === boardBookId)) {
    boardBookId = '';
    fellBack = true;
  }

  sel.value = boardBookId;
  sel.disabled = list.length === 0;
  const hint = $('#boardScopeHint');
  if (hint) {
    hint.textContent = fellBack
      ? '这本书在这一天还没有记录，已切回全部作品'
      : (!boardBookId && list.length ? `共 ${list.length} 部作品 · 点一本看详情` : '');
  }

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
    const backBtn = $('#btnBoardBack');
    if (backBtn) backBtn.hidden = true;
    const props = $('#propsSection');
    if (props) props.hidden = true;
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

  // 优先级作品在两种模式下都要能认出来：列表里排第一并带星标，详情页标题旁也有星标。
  // 「已入库 / 已上架」是平台状态，星标是我们自己的标记，两者并排不冲突。
  const priorityId = priorityBoardBookId();

  $('#boardDay').textContent = `统计日 ${cur.day} · ${single ? '单看一本' : '全部作品'}`;
  $('#boardSub').textContent = prev
    ? `对比基准 ${prev.day} · 采集于 ${fmtTime(cur.capturedAt)}`
    : `首次采集 · 采集于 ${fmtTime(cur.capturedAt)} · 明日 06:00 后即可对比`;

  const older = snapshots.filter((s) => s.day < snap.day);
  $('#btnPrevDay').hidden = older.length === 0;

  renderTotals(totalsBox, scoped.totals, single, cur.totals);

  // 换了一本书，就把道具区块的「亲手挑过」清掉：让它跟着新书走，
  // 否则从 A 的详情进到 B 的详情，道具还停在 A 上，看着像数据错了。
  if (propsBoardLink !== boardBookId) {
    propsBoardLink = boardBookId;
    propsBookChosen = '';
  }

  // 两种模式互斥：
  //   全部作品 → 汇总 + 一行一本的作品卡（整卡点进详情）
  //   单本详情 → 完整指标卡 + 其他指标 + 趋势图 + 道具获得
  // 道具获得是「某一本书」的数据，全部作品模式下没有意义，直接不显示。
  const backBtn = $('#btnBoardBack');
  const propsSection = $('#propsSection');
  booksBox.hidden = false;
  if (backBtn) backBtn.hidden = !single;
  if (propsSection) propsSection.hidden = !single;

  if (single) {
    renderBookCards(booksBox, [single], true, priorityId);
    renderSingleExtra(extraBox, single);
    // 道具获得是这一页的一部分，换成另一本书就要跟着换。
    // 放在 renderBoard 里而不是只在切页时刷新，才不会出现「点了行、上面变了、下面没变」。
    renderProps();
  } else {
    // 优先级作品排第一：这是「点亮星标」在看板概览里的直接体现
    renderBookCards(booksBox, orderForBoard(scoped.books, priorityId), false, priorityId);
    extraBox.hidden = true;
    extraBox.innerHTML = '';
  }
  renderBookChart(single);
}

/**
 * 概览列表排序：标星的那本提到第一位，其余保持原顺序。
 *
 * 规则本体在 book-priority.js（有单测），这里保留一份兜底实现：
 * 万一那个脚本没加载，也绝不能变成「星标亮着、却排在第三行」——
 * 那正是用户报过的现象，而且从界面上完全看不出是排序没执行。
 */
function orderForBoard(books, priorityId) {
  const list = Array.isArray(books) ? books.slice() : [];
  const want = String(priorityId || '').trim();
  if (!want) return list;
  if (window.BookPriority && typeof window.BookPriority.sortForBoard === 'function') {
    return window.BookPriority.sortForBoard(list, want);
  }
  const idx = list.findIndex((b) => String(b && b.bookId) === want);
  if (idx > 0) list.unshift(list.splice(idx, 1)[0]);
  return list;
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

/**
 * 书籍卡。
 *
 * 两处共用同一套六指标网格（「之前的数据排布」）：
 *   概览（isSingle=false）→ 一行一本、整卡可点进详情，卡片头右侧是「详情 ›」
 *   详情（isSingle=true） → 只画当前这本，头右侧是订阅最高的章节
 * priorityId 命中时标题前带实心星，整卡加强调底色。
 */
function renderBookCards(box, books, isSingle, priorityId) {
  if (!books.length) {
    box.innerHTML = '<div class="board-list-empty">这一天还没有作品数据</div>';
    return;
  }
  box.innerHTML = books.map((b) => {
    const pinned = priorityId && String(b.bookId) === String(priorityId);
    const clickable = !isSingle;
    return `
    <div class="book-card${pinned ? ' is-priority' : ''}${clickable ? ' is-clickable' : ''}"
         ${clickable ? `data-book="${escapeHtml(String(b.bookId))}" role="button" tabindex="0"
         title="查看《${escapeHtml(b.name)}》的完整数据"` : ''}>
      <div class="book-card-head">
        <span class="book-card-star${pinned ? ' is-on' : ''}" aria-hidden="true">${pinned ? '★' : '☆'}</span>
        <span class="book-card-name">《${escapeHtml(b.name)}》</span>
        ${b.status ? `<span class="badge">${escapeHtml(b.status)}</span>` : ''}
        ${clickable
          ? '<span class="book-card-go">详情 ›</span>'
          : `<span class="book-card-chapter">${escapeHtml(b.maxSubChapter || '')}</span>`}
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
  `;
  }).join('');
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

// 概览卡：整卡点进详情。卡片是 div[role=button]，Enter / Space 要自己转成点击。
const boardBooksEl = $('#boardBooks');
if (boardBooksEl) {
  const openCard = (card) => {
    if (!card || !card.dataset.book) return;
    boardBookId = card.dataset.book;
    renderBoard();
    // 进详情后把视线带回顶部，否则会停在原来那张卡的位置、看不到汇总卡
    const host = document.querySelector('section.view[data-view="books"]');
    if (host && typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'start' });
  };
  boardBooksEl.addEventListener('click', (e) => {
    openCard(e.target.closest('.book-card.is-clickable'));
  });
  boardBooksEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.book-card.is-clickable');
    if (!card) return;
    e.preventDefault();
    openCard(card);
  });
}

// 详情页的返回：回到全部作品的作品卡列表
const boardBackBtn = $('#btnBoardBack');
if (boardBackBtn) {
  boardBackBtn.addEventListener('click', () => {
    boardBookId = '';
    renderBoard();
  });
}

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
    const snap = await captureStatsSnapshot((p) => {
      if (!silent) notice.textContent = p.text || '采集中…';
    });

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
    if (!silent) {
      btn.disabled = false;
      btn.textContent = '刷新数据';
    }
  }
}

/**
 * 共用的作者后台统计采集入口。
 * 数据看板和获准读取作者统计的插件都从这里刷新，确保只维护一套采集、入库与并发保护逻辑。
 */
async function captureStatsSnapshot(onProgress) {
  if (statsBusy) throw new Error('作者后台数据正在刷新，请稍候再试');
  if (exportBusy) throw new Error('正在同步作品，请完成后再刷新作者后台数据');
  statsBusy = true;
  try {
    const snap = await window.Stats.captureSnapshot({ onProgress });
    snapshots = window.Stats.mergeSnapshot(snapshots, snap);
    viewDay = snap.day;
    await window.api.data.write('stats-snapshots.json', { snapshots });
    renderBoard();
    return snap;
  } finally {
    statsBusy = false;
  }
}

/* ------------------------------------------------------------ 道具获得
 *
 * 位置：数据看板里、现有统计内容的下方一栏（不再是独立页面）。
 * 版式照作者后台「统计中心 → 道具获得」：选作品 + 查看 → 四张卡 → 趋势 → 明细。
 *
 * 平台只有四项：总推荐票 / 总月票 / 总打赏 / 总刀片。**没有「宝箱」**——
 * 之前按猜测写过五项，多出来的那项永远读不到、只会显示「—」。
 *
 * 数据按「作品 + 统计日」存：道具必然是某一本书的，混在一起没有意义。
 */

/**
 * 道具获得页的候选地址。
 *
 * 平台把它放在「作者钱包 → 统计中心」下面，具体路径改过版，所以这里给几个候选；
 * 抓之前会逐个打开、检查页面里有没有「道具获得」四个字，命中就停。
 * 用户在后台已经手动翻到这一页时，直接用当前页，不重新导航。
 */
const PROPS_URLS = [
  'https://author.ciweimao.com/money_manage/index',
  'https://author.ciweimao.com/money_manage/statistics',
  'https://author.ciweimao.com/money_manage/prop',
];

/** 全部道具快照：[{ day, bookId, bookName, capturedAt, items, detail, scanned, raw }] */
let propsSnapshots = [];
let propsBusy = false;
/** 道具区块当前看的粒度：7 / 30 / 0（0 = 按月，用全部历史近似） */
let propsGrain = 7;

/** 统计日（与数据看板同口径：6 点为界） */
let propsTodayOverride = '';
function propsToday() {
  // 固定统计日的钩子只给界面测试用（见 __setPropsToday），生产流程里永远是空串
  if (propsTodayOverride) return propsTodayOverride;
  return window.Stats ? window.Stats.statDay() : new Date().toISOString().slice(0, 10);
}

/**
 * 供无 GUI 环境下的界面测试固定「统计日」。
 *
 * 不这么做的话，测试里的样例日期会随真实日期漂移：
 * 今天写 2026-11-08，明天跑就变成「昨天」，差值全对不上，测试会假红。
 */
window.__setPropsToday = (day) => {
  propsTodayOverride = String(day || '');
  renderProps();
};

/** 可以查道具的书：必须带平台书号，否则后台选不到这本 */
function propsBooks() {
  return (Array.isArray(writerBooks) ? writerBooks : [])
    .filter((b) => b && String(b.platformBookId || '').trim())
    .map((b) => ({
      bookId: String(b.platformBookId),
      name: String(b.name || '未命名作品'),
    }));
}

/** 用户亲手选过的作品；空串表示还没选过，此时跟随详情页的书 / 优先级作品 */
let propsBookChosen = '';
/** 上一次渲染时看板看的是哪本：用来判断「换书了」，换书就清掉上一条手动选择 */
let propsBoardLink = '';

/**
 * 当前选中的书。
 *
 * **不能直接读下拉框的 value**：下拉一旦填上选项，浏览器就会默认选第一项，
 * 于是「没选过就跟随优先级作品」这条逻辑永远轮不到执行——
 * 表现就是「点亮了星标，道具区块却盯着另一本书」。
 * 所以用一个独立的标记记住「用户是否亲手选过」。
 */
function propsBookId() {
  const list = propsBooks();
  // 用户在下拉里亲手挑过就听他的
  if (propsBookChosen && list.some((b) => b.bookId === propsBookChosen)) return propsBookChosen;
  // 否则跟着详情页正在看的那本 —— 两块数据讲同一本书才讲得通
  if (boardBookId && list.some((b) => b.bookId === String(boardBookId))) return String(boardBookId);
  const priority = priorityBoardBookId();
  if (priority && list.some((b) => b.bookId === priority)) return priority;
  return list.length ? list[0].bookId : '';
}

function propsBookName(bookId) {
  const hit = propsBooks().find((b) => b.bookId === String(bookId || ''));
  return hit ? hit.name : '';
}

/** 这一天这本的快照 */
function propsSnapshotOf(day, bookId) {
  return window.PropsDiff.findDay(propsSnapshots, day, bookId);
}

async function loadPropsSnapshots() {
  try {
    const store = await window.api.data.read('props-snapshots.json');
    const rows = store && Array.isArray(store.snapshots) ? store.snapshots : [];
    // 丢掉没有作品归属的记录：道具必然是某一本书的，
    // 早期版本没记 bookId 的那几条混进来会把别的书的数字显示到当前书上
    propsSnapshots = rows.filter((s) => s && s.day && String(s.bookId || '').trim());
  } catch (_) { propsSnapshots = []; }
  syncPropsBookOptions();
  renderProps();
}

/** 作品下拉：与看板的「查看范围」各自独立（后台道具页必须选一本，没有「全部」） */
function syncPropsBookOptions() {
  const sel = $('#propsBook');
  if (!sel) return;
  const list = propsBooks();
  const sig = list.map((b) => `${b.bookId}:${b.name}`).join('|');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = list.length
      ? list.map((b) => `<option value="${escapeHtml(b.bookId)}">《${escapeHtml(b.name)}》</option>`).join('')
      : '<option value="">尚未读取作品</option>';
  }
  sel.disabled = list.length === 0;

  const want = propsBookId();
  if (want) sel.value = want;
  const hint = $('#propsBookHint');
  if (hint) {
    hint.textContent = list.length
      ? (list.length > 1 ? `共 ${list.length} 本可选` : '')
      : '先在「创作中心」同步作者库，才能选作品';
  }
}

/**
 * 把道具区块画出来。
 *
 * 三块内容各自独立降级：卡片（数据）、趋势（本地累积）、明细（平台表格）。
 * 平台明细经常是「暂无任何数据」，这不算失败，别把它画成错误。
 */
function renderProps() {
  if (!window.PropsDiff) return;
  syncPropsBookOptions();

  const bookId = propsBookId();
  const today = propsToday();
  const snap = propsSnapshotOf(today, bookId);
  const prev = window.PropsDiff.findPrevious(propsSnapshots, today, bookId);
  const rows = window.PropsDiff.diffAgainst(prev ? prev.items : null, snap ? snap.items : {});

  // ---- 四张卡 ----
  const grid = $('#propsGrid');
  if (grid) {
    grid.innerHTML = rows.map((row) => {
      const missing = row.value === null;
      const diffLabel = !snap ? '今日尚未读取'
        : prev ? `较前一日 ${window.PropsDiff.diffText(row.diff)}` : '首次读取，明日可对比';
      return `
        <div class="props-card">
          <div class="props-card-head"><span class="props-label">${escapeHtml(row.label)}</span></div>
          <div class="props-value${missing ? ' is-missing' : ''}">${escapeHtml(missing ? '—' : String(row.value))}</div>
          <div class="props-diff" data-tone="${row.tone}">${escapeHtml(diffLabel)}</div>
          <div class="props-hint">${escapeHtml(row.hint)}</div>
        </div>`;
    }).join('');
  }

  const empty = $('#propsEmptyInline');
  if (empty) empty.hidden = !!snap;

  // ---- 顶部状态标签 ----
  const tag = $('#propsScanTag');
  if (tag) {
    if (!snap) tag.textContent = '今日未读取';
    else {
      const got = rows.filter((r) => r.value !== null).length;
      tag.textContent = got === rows.length ? `${snap.day} 已读取` : `${snap.day} · 识别 ${got}/${rows.length}`;
    }
  }

  // ---- 趋势 + 图例 ----
  renderPropsChart(bookId, today);

  // ---- 明细 ----
  renderPropsDetail(snap);

  // ---- 识别情况（折叠区，只在有内容时露出） ----
  const note = $('#propsNote');
  if (note) {
    const raw = snap && Array.isArray(snap.raw) ? snap.raw : [];
    const got = rows.filter((r) => r.value !== null).length;
    if (!snap) {
      note.hidden = true;
    } else {
      note.hidden = false;
      const detailTag = $('#propsScanDetailTag');
      if (detailTag) detailTag.textContent = `${got}/${rows.length} 项`;
      $('#propsNoteText').textContent = got === rows.length
        ? `四项全部识别成功，扫描了 ${snap.scanned || 0} 个文本块。`
        : `识别到 ${got} 项，扫描了 ${snap.scanned || 0} 个文本块。没识别的显示为「—」，`
          + '说明当前页面没有这几个字样，或者后台改版了。下面是实际读到的内容，可以截图反馈。';
      $('#propsRaw').innerHTML = raw.length
        ? raw.map((r) => `<div class="props-raw-row">${escapeHtml(r.key || '')}：`
          + `${escapeHtml(r.text || '')}`
          + `${r.ambiguous ? '（同一块里数字不唯一，已跳过）' : ''}</div>`).join('')
        : '<div class="props-raw-row">没有命中任何关键词</div>';
    }
  }
}

/** 趋势图：四条线共用一套 Y 轴，量级差看得见 */
function renderPropsChart(bookId, today) {
  const box = $('#propsChartCanvas');
  const legend = $('#propsLegend');
  const sub = $('#propsChartSub');
  if (!box || !window.Chart || !window.PropsDiff) return;

  const grain = propsGrain;
  const list = propsSnapshots.filter((s) => s && String(s.bookId || '') === String(bookId || ''));
  const picked = grain > 0
    ? window.PropsDiff.seriesFor(propsSnapshots, bookId, { days: grain, today })
    : list.slice().sort((a, b) => String(a.day).localeCompare(String(b.day)));

  const colors = ['--props-c1', '--props-c2', '--props-c3', '--props-c4'];
  const series = window.PropsDiff.ITEMS.map((item, i) => ({
    key: item.key,
    label: item.short,
    color: cssColor(colors[i], '#c89600'),
    values: picked.map((s) => {
      const v = s.items ? s.items[item.key] : null;
      return v === null || v === undefined ? null : Number(v);
    }),
  }));

  box.innerHTML = '';
  if (!picked.length) {
    box.innerHTML = '<div class="chart-empty">这本还没有任何道具快照，点「查看」抓一次就有了</div>';
  } else {
    window.Chart.multiLineChart(box, {
      days: picked.map((s) => s.day),
      series,
    });
  }

  if (sub) {
    sub.textContent = picked.length
      ? `${grain > 0 ? `最近 ${grain} 天` : '全部历史（按月对照平台口径）'} · 共 ${picked.length} 天有记录 · 空白处表示那天没抓到`
      : '按本地每天抓到的数据累积';
  }

  if (legend) {
    legend.innerHTML = series.map((s) => `
      <span class="props-legend-item">
        <i style="background:${escapeHtml(s.color)}"></i>${escapeHtml(s.label)}
      </span>`).join('');
  }
}

/** 读 CSS 变量的实际值：SVG 属性不认 var()，必须拿到字符串 */
function cssColor(varName, fallback) {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(varName).trim();
    return v || fallback;
  } catch (_) { return fallback; }
}

/** 明细表：平台有数据就画表，没有就说明「本期没有」 */
function renderPropsDetail(snap) {
  const box = $('#propsDetailBody');
  if (!box) return;
  const rows = snap && Array.isArray(snap.detail) ? snap.detail : [];
  if (!rows.length) {
    box.innerHTML = '<div class="props-detail-empty">'
      + (snap ? '平台本期没有道具获得明细' : '读取一次后显示')
      + '</div>';
    return;
  }
  const cols = rows[0].cols && rows[0].cols.length ? rows[0].cols : [];
  const head = cols.length
    ? `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`
    : '';
  const body = rows.map((r) => `<tr>${r.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  box.innerHTML = `<div class="props-detail-scroll"><table class="props-table">${head}<tbody>${body}</tbody></table></div>`;
}

async function savePropsSnapshot(snap) {
  propsSnapshots = window.PropsDiff.mergeSnapshot(propsSnapshots, snap);
  await window.api.data.write('props-snapshots.json', { snapshots: propsSnapshots });
  renderProps();
}

/**
 * 去作者后台读一次道具获得。
 *
 * 三步：找到道具获得页 → 选作品并点「查看」→ 读四项数字。
 * 全程只读（除了点平台自己的「查看」，那是重新查询，不改任何数据）。
 */
async function captureProps() {
  if (propsBusy) return;
  const btn = $('#btnPropsRefresh');
  const notice = $('#propsNotice');
  const bookId = propsBookId();

  const say = (text, isError) => {
    if (!notice) return;
    notice.hidden = false;
    notice.classList.toggle('is-error', !!isError);
    notice.textContent = text;
  };

  if (!bookId) {
    say('还没有可选的作品。先到「创作中心」点「同步作者库」，再来读道具数据。', true);
    return;
  }
  const state = await window.api.browser.state().catch(() => null);
  if (!state || !state.url) {
    say('请先在「抓取与同步」打开并登录作者后台，再回到这里点「查看」。', true);
    return;
  }
  if (state.isLoginPage) {
    say('当前停在登录页，请先完成登录。', true);
    return;
  }

  propsBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = '读取中…'; }
  notice && (notice.hidden = true);

  try {
    // 1) 找到道具获得页：先看当前页，不是再逐个试候选地址
    say('正在定位「道具获得」页面…');
    const looksLikeProps = async () => {
      const hit = await window.api.browser
        .evalInPage('document.body ? document.body.innerText.indexOf("道具获得") >= 0 : false')
        .catch(() => false);
      return !!hit;
    };

    let onPropsPage = await looksLikeProps();
    if (!onPropsPage) {
      for (const url of PROPS_URLS) {
        say('正在打开 ' + url.replace(/^https?:\/\/[^/]+/, ''));
        try {
          await window.api.browser.goto(url);
          await window.api.browser.waitIdle(15000);
        } catch (_) { continue; }
        const where = await window.api.browser.evalInPage('location.href').catch(() => '');
        if (/\/login/i.test(String(where || ''))) throw new Error('登录态已失效，请重新登录作者后台');
        if (await looksLikeProps()) { onPropsPage = true; break; }
      }
    }
    if (!onPropsPage) {
      throw new Error('没找到「道具获得」页面。可以在后台手动翻到该页（作者钱包 → 统计中心 → 道具获得），'
        + '再回来点「查看」。');
    }

    // 2) 选作品并点「查看」
    say('正在切换作品…');
    const sel = await window.api.browser
      .evalInPage(window.CiweimaoAdapter.pageSource('selectPropsBook', bookId))
      .catch(() => null);
    if (sel && sel.clicked) {
      // 点完「查看」页面会重新请求一次，等它回来
      await window.api.browser.waitIdle(15000);
      await new Promise((r) => setTimeout(r, 900));
    } else if (sel && !sel.picked) {
      say('后台的作品下拉里没有这本书（可能刚建还没同步）。读的是当前默认作品的数据。');
    }

    // 3) 读数
    say('正在读取…');
    const res = await window.api.browser
      .evalInPage(window.CiweimaoAdapter.pageSource('extractProps'))
      .catch(() => null);
    if (!res) throw new Error('页面读取失败，可能是后台改版了');

    const items = window.PropsDiff.normalizeItems(res.items || {});
    const snap = {
      day: propsToday(),
      bookId,
      bookName: propsBookName(bookId) || String(res.bookId || ''),
      capturedAt: new Date().toISOString(),
      items,
      detail: Array.isArray(res.detail) ? res.detail : [],
      raw: Array.isArray(res.raw) ? res.raw : [],
      scanned: Number(res.scanned) || 0,
    };
    await savePropsSnapshot(snap);

    const got = window.PropsDiff.keys().filter((k) => items[k] !== null).length;
    const total = window.PropsDiff.keys().length;
    say(got === total
      ? `读取完成：${snap.day}，四项都拿到了。`
      : `读取完成：${snap.day}，认出 ${got}/${total} 项。没认出的请看下方「识别情况」。`,
    got !== total);
  } catch (err) {
    say('读取失败：' + ipcError(err), true);
  } finally {
    propsBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '查看'; }
  }
}

$('#btnPropsRefresh').addEventListener('click', () => captureProps());

$('#propsBook').addEventListener('change', (e) => {
  // 记下用户的选择，之后就固定看这本，不再被优先级抢走
  propsBookChosen = e.target.value || '';
  renderProps();
});

$('#propsGrain').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-grain]');
  if (!btn) return;
  propsGrain = Number(btn.dataset.grain) || 0;
  $$('#propsGrain button').forEach((b) => b.classList.toggle('is-active', b === btn));
  renderPropsChart(propsBookId(), propsToday());
});

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
  signalResult = window.Signals.extract(scopedItems().filter((x) => (x.kind || 'tsukkomi') === 'tsukkomi'));
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
  recommend: { week: '推荐榜 · 周榜', month: '推荐榜 · 月榜' },
  subscribe: { week: '订阅榜 · 周榜', month: '订阅榜 · 月榜' },
  monthly: { week: '月票榜 · 周榜', month: '月票榜 · 月榜' },
  tsukkomi: { week: '吐槽榜 · 周榜', month: '吐槽榜 · 月榜' },
  newbook: { week: '新书榜 · 周榜', month: '新书榜 · 月榜' },
  blade: { week: '刀片榜 · 周榜', month: '刀片榜 · 月榜' },
  update: { week: '更新榜 · 周榜', month: '更新榜 · 月榜' },
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
      <span class="rank-card-name">${(RANK_LABELS[key] && RANK_LABELS[key][period]) || key}</span>
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
    $('#rankSub').textContent = '抓取一次即可看到平台公开榜单，排名变化需连续两天';
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

  const availableKeys = (window.Rank.RANK_KEYS || Object.keys(RANK_LABELS))
    .filter((key) => data[key] && ((data[key].week || []).length || (data[key].month || []).length));
  grid.innerHTML = availableKeys
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

/**
 * 给一个 Promise 加上「最多等多久」。
 *
 * 主进程侧已经给网络请求加了超时，但界面这一层也要有兜底：
 * IPC 卡住的原因不止网络（主进程忙、通道异常），而按钮一旦永久禁用，
 * 用户除了重启软件没有别的办法。宁可报一句「等太久了」也不能卡死。
 */
function withDeadline(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message || '操作超时，请重试')), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

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
    // 主进程侧 12 秒 × 2 次，这里给 30 秒上限，留出重试的余量。
    // 没有这个上限，一旦 IPC 那头不返回，finally 永远不执行，按钮就卡死了。
    const html = await withDeadline(
      window.api.rank.fetch(), 30000, '抓取超时（30 秒无响应），请检查网络后重试',
    );
    const parsed = window.Rank.parseRankHtml(html);
    const total = window.Rank.RANK_KEYS.reduce(
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
    notice.classList.remove('is-error');
    notice.textContent = prev
      ? `已更新 ${date}，共 ${total} 条，已与 ${prev.date} 对比。`
      : `已更新 ${date}，共 ${total} 条。这是第一份基准，明天再抓即可看到排名升降。`;
  } catch (err) {
    notice.hidden = false;
    notice.classList.add('is-error');
    notice.textContent = '抓取失败：' + ((err && err.message) || err);
  } finally {
    // 无论成功、失败、超时，按钮都要恢复 —— 这是「点了没反应」最后一道保险
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
  return reviewResult.items.filter((x) => (x.kind || 'tsukkomi') === 'tsukkomi' && !x.handled && !dismissed.has(String(x.id)));
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
    (x) => String(x.id) === String(slip.localId || slip.commentId)
  );
  if (!hit) return;
  hit.handled = true;
  hit.handledAt = new Date().toISOString();
  hit.handledBy = action;
  renderExecPool();

  // 落盘的是「已处理」标记，评论原文与审查结果都保留，方便日后回查
  if (crawlData && Array.isArray(crawlData.items)) {
    const raw = crawlData.items.find((x) => String(x.id) === String(slip.localId || slip.commentId));
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
/** 用户点了「停止」：翻页循环与页面内逐行点击都会看这个标记 */
let inboxStopFlag = false;

function inboxNotice(html, isError) {
  const n = $('#inboxNotice');
  n.hidden = false;
  n.classList.toggle('is-error', !!isError);
  n.innerHTML = html;
}

function setInboxStopEnabled(on) {
  const b = $('#btnStopInbox');
  if (!b) return;
  b.disabled = !on;
  b.textContent = '停止';
}

function stopInbox() {
  if (!inboxBusy || inboxStopFlag) return;
  inboxStopFlag = true;
  setInboxStopEnabled(false);
  $('#btnStopInbox').textContent = '正在停止…';
  $('#inboxText').textContent = '正在停止，等当前这条点完…';
  if (window.Inbox && typeof window.Inbox.requestStop === 'function') {
    Promise.resolve(window.Inbox.requestStop()).catch(() => { /* ignore */ });
  }
}

async function clearInbox() {
  if (inboxBusy) return;
  inboxBusy = true;
  inboxStopFlag = false;
  ['#btnClearInbox', '#btnClearInboxTop'].forEach((sel) => { $(sel).disabled = true; });
  setInboxStopEnabled(true);
  $('#inboxProgress').hidden = false;
  $('#inboxNotice').hidden = true;
  $('#inboxBar').style.width = '8%';
  $('#inboxText').textContent = '正在打开作者信箱…';
  $('#inboxStatus').textContent = '';

  try {
    const res = await window.Inbox.clearAll({
      allPages: $('#inboxAllPages').checked,
      shouldStop: () => inboxStopFlag,
      onProgress: (p) => {
        $('#inboxText').textContent = p.text || '';
        if (p.phase === 'done') $('#inboxBar').style.width = '100%';
        else if (p.phase !== 'stopped') $('#inboxBar').style.width = '60%';
      },
    });

    const cleared = res.pages.reduce((s, p) => s + Math.max(0, (p.before || 0) - (p.after || 0)), 0);

    // 中途停下：说清楚停了、清到哪、还能不能接着清，别让用户以为失败了
    if (res.stopped) {
      inboxNotice(`已停止：处理了 ${res.pages.length} 页，点开 ${res.clicked} 条消息，`
        + (cleared ? `消掉 ${cleared} 个红点。` : '红点数量没有变化。')
        + '<br>已经点过的不会恢复，剩下的再点一次「一键清除小红点」就能接着清。');
      $('#inboxStatus').textContent = cleared ? `已清除 ${cleared} 个（已停止）` : '已停止';
      $('#inboxBar').style.width = '100%';
      $('#inboxText').textContent = '已停止';
      return;
    }

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
    if (inboxStopFlag) {
      // 停止时页面可能正处于半截状态，异常不该被当成「清除失败」
      $('#inboxProgress').hidden = true;
      inboxNotice('已停止。已经点过的不会恢复，剩下的可以再点一次继续清。');
    } else {
      $('#inboxProgress').hidden = true;
      inboxNotice('清除失败：' + escapeHtml(String(err.message || err))
        + '<br>已把这一页的原始 HTML 存进诊断目录，若结构有变可按它修正。', true);
    }
  } finally {
    inboxBusy = false;
    setInboxStopEnabled(false);
    ['#btnClearInbox', '#btnClearInboxTop'].forEach((sel) => { $(sel).disabled = false; });
  }
}

$('#btnClearInbox').addEventListener('click', clearInbox);
$('#btnClearInboxTop').addEventListener('click', clearInbox);
$('#btnStopInbox').addEventListener('click', stopInbox);

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
let writerPinnedOnly = false;
let writerTypedMask = [];
let writerNextTypedToken = 1;
let writerSavingTokens = new Set();
let writerEditVersion = 0;
let writerSavedWordBaseline = 0;
let writerSavedBaselineChapterId = '';
let writerLastSavedChapterWords = 0;
let writerSaveQueue = Promise.resolve();
let writerNoticeTimer = null;

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

/** 非错误提示的默认停留时间：够看清一句话，又不至于赖在界面上 */
const WRITER_NOTICE_MS = 6000;
/** 进度类提示更短：它会被下一条覆盖，没必要耗到 6 秒 */
const WRITER_NOTICE_PROGRESS_MS = 2500;

/**
 * 创作中心的提示条。
 *
 * 默认**会自动消失**。之前的默认值是 0（永不消失），于是「读取完成：6 本共 1254 章」
 * 这种一次性结果会一直挂在页面顶部，用户以为还要点掉它 —— 但它根本没有关闭按钮。
 *
 * 错误提示（error=true）默认保留更久：读失败、同步失败这类要让人看清，
 * 但也会在 12 秒后消失，不制造「关不掉的弹窗」。
 * 需要常驻的特殊情况显式传 0。
 *
 * @returns {number} 实际设定的停留毫秒数（0 = 常驻）。返回它是为了让测试
 *   不必真等 6 秒就能断言「默认不会常驻」。
 */
function writerNotice(text, error, autoHideMs) {
  clearTimeout(writerNoticeTimer);
  writerNoticeTimer = null;
  const el = $('#writerNotice');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('is-error', !!error);
  if (!text) return 0;

  const ttl = autoHideMs === undefined
    ? (error ? WRITER_NOTICE_MS * 2 : WRITER_NOTICE_MS)
    : Number(autoHideMs);
  if (ttl > 0) {
    writerNoticeTimer = setTimeout(() => {
      el.hidden = true;
      el.textContent = '';
      writerNoticeTimer = null;
    }, ttl);
  }
  return ttl;
}

// -------------------------------------------------- 作品库自动补建（后台新书）

/**
 * 后台建了新书之后，本地作品库跟着建一本并绑定作品号，投递时不必再手动选。
 *
 * 触发点包括登录成功、切到创作中心、后台停在 book_manage 页面。都做去抖，
 * 并且**静默失败** —— 未登录、网络不通、后台改版都属于正常情况，
 * 不该在界面上弹错误去打断用户。
 *
 * 判定逻辑在主进程（library.adoptPlatformBooks），这里只负责把后台清单递过去，
 * 并对已绑定作品做新增章节增量同步。
 */
let writerAdoptTimer = null;
let writerAdoptBusy = false;
let writerRemoteSyncBusy = false;

function writerPlatformBookId(book) {
  return String((book && (book.platformBookId || (book.source === 'author' ? book.bookId : ''))) || '').trim();
}

async function adoptNewPlatformBooks(remoteOverride) {
  if (writerAdoptBusy) return null;
  if (!lastState || !lastState.url || lastState.isLoginPage) return null;

  writerAdoptBusy = true;
  try {
    const remote = Array.isArray(remoteOverride)
      ? remoteOverride
      : await window.Exporter.listBooks();
    if (!remote || !remote.length) return null;

    const res = await window.api.writer.adopt(remote.map((b) => ({
      bookId: b.bookId,
      name: b.name,
      chapters: b.chapters || 0,
      cover: b.cover || '',
    })));

    const created = (res && res.created) || [];
    const linked = (res && res.linked) || [];
    await loadWriterBooks();
    const sync = await syncWriterBoundBooks(remote);
    if (sync && sync.added) {
      writerNotice(`作者库已更新：新增 ${sync.added} 章`
        + (sync.conflicts ? `，发现 ${sync.conflicts} 个同章冲突` : '')
        + (sync.failed ? `，${sync.failed} 章读取失败` : ''),
        sync.failed > 0);
    } else if (created.length === 1) {
      writerNotice(`已在作品库创建《${created[0].name}》，并连到后台这本书`);
    } else if (created.length > 1) {
      writerNotice(`已在作品库创建 ${created.length} 本新书并全部连到后台`);
    } else if (linked.length) {
      writerNotice(`《${linked[0].name}》已连到后台作品 ${linked[0].platformBookId}`);
    } else if (sync && sync.skipped) {
      writerNotice(`作者库已检查，有 ${sync.skipped} 本正在编辑的作品将在保存后再检查`);
    } else if (sync && sync.books) {
      writerNotice('作者库已检查，没有新增章节');
    }
    return { ...res, sync };
  } catch (_) {
    return null;
  } finally {
    writerAdoptBusy = false;
  }
}

/** 后台页面一有跳转就会连发几次状态，去抖避免重复拉清单 */
function scheduleAdoptNewBooks() {
  clearTimeout(writerAdoptTimer);
  writerAdoptTimer = setTimeout(async () => {
    // 登录完成后可能还没有进入创作中心，先把本地索引读出来，增量同步才有目标。
    await loadWriterBooks();
    await adoptNewPlatformBooks();
  }, 1200);
}

async function loadWriterBooks() {
  try {
    const res = await window.api.writer.list();
    const local = (res && res.books) || [];
    await reconcileSavedOutputBooks(local);
    const ids = new Set(local.flatMap((b) => [b.bookId, b.platformBookId]
      .filter(Boolean).map(String)));
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

/** 本地作品还没落盘封面时，从作者库同步结果里借用同 bookId 的封面 */
function remoteCoverFor(book) {
  if (!book || !Array.isArray(writerRemoteBooks) || !writerRemoteBooks.length) return '';
  const hit = writerRemoteBooks.find((r) => String(r.bookId) === String(book.bookId));
  return (hit && hit.cover) || '';
}

/**
 * 封面图的两种结局都要接住：
 *   load  → 打上 has-cover，容器按图片自身比例撑开
 *   error → 退回渐变占位（去掉 has-cover 并移除 img），卡片仍有 3:4 高度
 *
 * 为什么不能渲染时就写死 has-cover：has-cover 会把「无封面时的 3:4 占位」关掉。
 * 图片一旦加载失败，容器高度就是 0 —— 卡片塌成一条，星标（原先在封面里）被
 * overflow:hidden 裁掉，看得见点不着，加了星就再也取消不了。
 *
 * 选择器必须覆盖整个 #writerLibrary：原来只查 #writerBookGrid，
 * 优先级栏（#writerPinnedGrid）里的封面拿不到兜底，
 * 偏偏是「加了星之后才发现那张图是坏的」。
 */
function bindWriterCoverFallback() {
  $$('#writerLibrary .writer-book-cover-img').forEach((img) => {
    const cover = img.closest('.writer-book-cover');
    const ok = () => { if (cover) cover.classList.add('has-cover'); };
    const fail = () => {
      if (cover) cover.classList.remove('has-cover');
      img.remove();
    };
    img.addEventListener('load', ok, { once: true });
    img.addEventListener('error', fail, { once: true });
    // 缓存命中时 load / error 可能在我们挂监听之前就结束了，补一次同步判断
    if (img.complete) {
      if (img.naturalWidth > 0) ok();
      else fail();
    }
  });
}

function renderWriterBookCard(book, i) {
  const cover = String(book.cover || remoteCoverFor(book) || '');
  const coverTag = cover
    ? `<img class="writer-book-cover-img" src="${escapeHtml(cover)}" alt="" loading="lazy" />`
    : '';
  const id = escapeHtml(String(book.bookId));
  // 星标是「这本书排第一」的开关，位置固定在封面右上角。
  // 但它**挂在卡片上、不放在封面里**：封面是 overflow:hidden 的容器，
  // 高度又完全取决于封面图（没图 / 图挂了就是 0），星标放进去会被裁掉 ——
  // 用户看到的就是「加了星之后星标消失，再也取消不了」。
  // 挂在卡片上，封面怎么塌星标都在（top/right 见样式表，位置视觉上仍是封面右上角）。
  // 远程作品不能点亮（没有本地归档，数据看板也定位不到）。
  const pinButton = book.source === 'remote' ? '' : `
      <button class="writer-book-pin${book.pinned ? ' is-pinned' : ''}" data-writer-pin="${id}"
              type="button" title="${book.pinned ? '取消优先级' : '设为优先：创作中心排第一、数据看板默认显示这本'}"
              aria-label="${book.pinned ? '取消优先级' : '设为优先'}"
              aria-pressed="${book.pinned ? 'true' : 'false'}">${book.pinned ? '★' : '☆'}</button>`;
  return `
    <article class="writer-book-card${book.pinned ? ' is-pinned' : ''}" data-writer-book="${id}">
      <div class="writer-book-cover tone-${i % 5}">
        ${coverTag}
        <span class="writer-book-source">${writerSourceLabel(book.source)}</span>
        <span class="writer-book-feather">✎</span>
      </div>
      ${pinButton}
      <div class="writer-book-info">
        <h3>${escapeHtml(book.name || '未命名作品')}</h3>
        <div class="writer-book-meta">
          <p>${writerFormatNumber(book.words)} 字 · ${Number(book.chapters) || 0} 章</p>
        </div>
      </div>
      <button class="writer-book-delete" data-writer-delete="${id}" type="button" title="从本地作品库删除">•••</button>
    </article>
  `;
}

function renderWriterBooks() {
  // 分组规则在 book-priority.js 里（有单测）：优先级作品 vs 其他作品。
  // 数据看板用的是同一份规则，避免两边对「哪本是优先级」判断不一致。
  const group = window.BookPriority
    ? window.BookPriority.partition(writerBooks)
    : {
      priority: writerBooks.filter((b) => !!b.pinned && b.source !== 'remote'),
      other: writerBooks.filter((b) => !b.pinned || b.source === 'remote'),
    };
  const pinned = group.priority;
  const other = group.other;
  const pinnedPanel = $('#writerPinnedPanel');
  const pinnedGrid = $('#writerPinnedGrid');
  const grid = $('#writerBookGrid');
  const filterEmpty = $('#writerFilterEmpty');
  const hasBooks = writerBooks.length > 0;

  $('#writerPinnedCount').textContent = String(pinned.length);
  $('#writerPinnedBadge').textContent = `${pinned.length} 本`;
  $$('.writer-library-filter').forEach((button) => {
    const active = (button.dataset.writerFilter === 'pinned') === writerPinnedOnly;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  pinnedPanel.hidden = writerPinnedOnly ? false : !pinned.length;
  pinnedGrid.innerHTML = pinned.map((book, i) => renderWriterBookCard(book, i)).join('');
  $('#writerPinnedEmpty').hidden = pinned.length > 0;

  $('#writerOtherLabel').hidden = writerPinnedOnly || !other.length;
  grid.hidden = writerPinnedOnly || !other.length;
  grid.innerHTML = writerPinnedOnly ? '' : other.map((book, i) => renderWriterBookCard(book, i)).join('');
  $('#writerEmpty').hidden = hasBooks;
  filterEmpty.hidden = !writerPinnedOnly || pinned.length > 0;
  bindWriterCoverFallback();
}

function normaliseWriterBook(book) {
  const b = book || {};
  b.chapters = (Array.isArray(b.chapters) ? b.chapters : []).map((c, i) => {
    const platformChapterId = String(c.platformChapterId
      || (window.WriterSync ? window.WriterSync.remoteChapterId(c) : '') || '');
    const isPlatform = String(c.origin || '').toLowerCase() === 'platform'
      || String(c.status || '').toLowerCase() === 'published'
      || !!platformChapterId;
    return {
      ...c,
      id: String(c.id || `chapter_${i + 1}`),
      title: String(c.title || `第${i + 1}章`),
      volume: String(c.volume || '正文'),
      content: String(c.content || ''),
      platformChapterId,
      origin: isPlatform ? 'platform' : 'local',
      status: isPlatform ? 'published' : 'unpublished',
      conflict: !!c.conflict,
      conflictKey: String(c.conflictKey || ''),
    };
  });
  if (!b.chapters.length) b.chapters.push({ id: 'chapter_1', title: '第一章', volume: '正文', content: '' });
  return b;
}

async function openWriterBook(bookId) {
  try {
    const res = await window.api.writer.open(bookId);
    if (!res || !res.book) throw new Error('没有找到这本书');
    writerEditorBook = normaliseWriterBook(res.book);
    // 打开就停在最新一章：显示顺序里最后一个，而不是数组里的第一个
    // （同步下来的书数组是新的在前，取第一个会停在最新章上「看着对、其实全靠巧合」）
    const ordered = writerDisplayChapters(writerEditorBook);
    writerChapterId = (ordered.length ? ordered[ordered.length - 1] : writerEditorBook.chapters[0]).id;
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

/**
 * 从作者后台把一本书的章节正文读下来并存进本地作品库。
 * 单本同步和「读取全部章节」共用这一份，避免两处各写一遍读取逻辑。
 *
 * @param {Object} book { bookId, name, cover }
 * @param {Function} [onStep] 进度回调，参数是给人看的一句话
 * @returns {Promise<{chapters:number, failed:number}>}
 */
async function pullWriterBookChapters(book, onStep) {
  const say = typeof onStep === 'function' ? onStep : () => {};
  const name = book.name || '未命名作品';

  say(`正在读取《${name}》的章节目录…`);
  const listed = await window.Exporter.listChapters(book.bookId, {
    onProgress: (p) => say(`正在读取《${name}》目录：已找到 ${p.count || 0} 章`),
  });
  if (!listed.chapters.length) throw new Error('没有读取到章节，请确认作品中已有章节');

  const result = await window.Exporter.readContents(book, listed.chapters, {
    onProgress: (p) => {
      if (p.phase === 'chapter') say(`正在同步《${name}》：${p.done}/${p.total} · ${p.title || ''}`);
    },
  });
  if (!result.chapters.length) throw new Error((result.failed[0] && result.failed[0].error) || '没有读取到正文');

  const meta = new Map(listed.chapters.map((c) => [String(c.chapterId), c]));
  const fetched = result.chapters.map((c, i) => {
    const m = meta.get(String(c.chapterId)) || {};
    const platformChapterId = String(c.chapterId || m.chapterId || '').trim();
    return {
      id: `chapter_${platformChapterId || i + 1}`,
      platformChapterId,
      title: c.title || m.title || `第${i + 1}章`,
      volume: m.volume || '正文',
      origin: 'platform',
      status: 'published',
      content: c.content || '',
    };
  });
  // 站点目录是「新在前」，存盘前先排成正序：存盘顺序、导出 TXT、下次打开三者一致，
  // 不用只靠显示层纠正
  const chapters = window.ChapterOrder.displayChapters({ chapters: fetched });
  await window.api.writer.save({
    bookId: book.bookId,
    name,
    cover: book.cover || '',
    source: 'author',
    platformBookId: String(book.platformBookId || book.bookId || ''),
    chapters,
  });
  writerRemoteBooks = writerRemoteBooks.filter((b) => String(b.bookId) !== String(book.bookId));
  return { chapters: chapters.length, failed: result.failed.length };
}

/**
 * 已经绑定到后台的本地作品只拉取新增章节，不覆盖作者在本地继续修改的正文。
 * 章节正文读取仍复用 Exporter，后台只读目录与新增章节内容。
 */
async function pullWriterBookNewChapters(localEntry, remoteBook, onStep) {
  const say = typeof onStep === 'function' ? onStep : () => {};
  const platformBookId = writerPlatformBookId(localEntry);
  if (!platformBookId) return { added: 0, failed: 0, total: 0 };

  const opened = await window.api.writer.open(localEntry.bookId);
  if (!opened || !opened.book) throw new Error(`本地作品《${localEntry.name || ''}》不存在`);
  const localBook = normaliseWriterBook(opened.book);
  const name = String(remoteBook.name || localBook.name || '未命名作品');

  say(`正在检查《${name}》的章节目录…`);
  const listed = await window.Exporter.listChapters(platformBookId, {
    onProgress: (p) => say(`正在检查《${name}》目录：已找到 ${p.count || 0} 章`),
  });
  const remoteChapters = listed && listed.chapters || [];
  if (!remoteChapters.length) return { added: 0, failed: 0, total: 0 };

  // 发布成功但站点没给 url 时，本地只记了「已发布」、没有后台章节号。
  // 先按标题/序号把这些章认领回来，否则下面会把它当成「后台新增」再拉一份，
  // 列表里出现两条同名章节，其中一条还标着「已发布 · 冲突」。
  const linked = window.WriterSync.linkPublishedChapters(localBook.chapters, remoteChapters);
  if (linked) {
    await window.api.writer.save({ ...localBook, chapters: localBook.chapters });
  }

  const missing = window.WriterSync.missingRemoteChapters(localBook.chapters, remoteChapters);
  if (!missing.length) return { added: 0, failed: 0, total: remoteChapters.length };

  const conflicts = new Map();
  missing.forEach((chapter) => {
    const hit = window.WriterSync.findChapterConflict(localBook.chapters, chapter);
    if (!hit) return;
    hit.chapter.conflict = true;
    hit.chapter.conflictKey = hit.key;
    conflicts.set(String(chapter.chapterId), hit);
  });

  const result = await window.Exporter.readContents(
    { bookId: platformBookId, name },
    missing,
    {
      onProgress: (p) => {
        if (p.phase === 'chapter') say(`正在同步《${name}》新增章节：${p.done}/${p.total} · ${p.title || ''}`);
      },
    }
  );
  if (!result.chapters.length) {
    return { added: 0, failed: result.failed.length || missing.length, total: remoteChapters.length };
  }

  const meta = new Map(missing.map((c) => [String(c.chapterId), c]));
  const fetched = result.chapters.map((c, i) => {
    const m = meta.get(String(c.chapterId)) || {};
    const platformChapterId = String(c.chapterId || m.chapterId || '').trim();
    return {
      id: `chapter_${platformChapterId || Date.now() + i}`,
      platformChapterId,
      title: c.title || m.title || `新增章节 ${i + 1}`,
      volume: m.volume || '正文',
      origin: 'platform',
      status: 'published',
      conflict: conflicts.has(platformChapterId),
      conflictKey: conflicts.get(platformChapterId)?.key || '',
      content: c.content || '',
    };
  });
  const chapters = window.ChapterOrder.displayChapters({
    chapters: localBook.chapters.concat(fetched),
  });
  await window.api.writer.save({
    ...localBook,
    bookId: localBook.bookId,
    name: localBook.name || name,
    cover: remoteBook.cover || localBook.cover || '',
    source: localBook.source === 'local' ? 'author' : (localBook.source || 'author'),
    platformBookId,
    chapters,
  });
  return {
    added: fetched.length,
    failed: result.failed.length,
    conflicts: conflicts.size,
    total: remoteChapters.length,
  };
}

/** 检查所有已经绑定的作品，逐本拉取新增章节。 */
async function syncWriterBoundBooks(remoteBooks) {
  if (writerRemoteSyncBusy) return { added: 0, failed: 0, conflicts: 0, books: 0, skipped: 0 };
  const remote = Array.isArray(remoteBooks) ? remoteBooks : [];
  const remoteById = new Map(remote.map((b) => [String(b && b.bookId || ''), b]));
  const targets = writerBooks.filter((book) => {
    const id = writerPlatformBookId(book);
    return book.source !== 'remote' && id && remoteById.has(id);
  });
  if (!targets.length) return { added: 0, failed: 0, conflicts: 0, books: 0, skipped: 0 };

  writerRemoteSyncBusy = true;
  let added = 0;
  let failed = 0;
  let conflicts = 0;
  let skipped = 0;
  try {
    for (const local of targets) {
      // 编辑中的正文以用户当前内容为准，等保存后下一次同步再检查，避免后台刷新
      // 把尚未落盘的本地修改悄悄覆盖掉。
      if (writerEditorBook && String(writerEditorBook.bookId) === String(local.bookId) && writerDirty) {
        skipped += 1;
        continue;
      }
      const remoteBook = remoteById.get(writerPlatformBookId(local));
      try {
        // **不要**把 writerNotice 当进度回调传进去。
        //
        // 这条同步是登录成功后自动跑的（切到创作中心也会跑），用户没有点任何按钮。
        // 以前进度直接写进页面顶部那条横幅，于是"从零开始打开创作中心"就冒出
        // 「正在检查《…》的章节目录…」并且长时间不动 —— 1254 章要读好几分钟，
        // 看起来就是卡死。后台任务不该占用用户的提示条，结果由下面统一汇报。
        const res = await pullWriterBookNewChapters(local, remoteBook, () => {});
        added += res.added;
        failed += res.failed;
        conflicts += res.conflicts || 0;
      } catch (_) {
        failed += 1;
      }
    }
  } finally {
    writerRemoteSyncBusy = false;
  }
  if (added) await loadWriterBooks();
  return { added, failed, conflicts, books: targets.length, skipped };
}

async function syncWriterRemoteBook(remote) {
  const btn = $('#btnWriterSync');
  btn.disabled = true;
  try {
    const res = await pullWriterBookChapters(remote, writerNotice);
    await loadWriterBooks();
    writerNotice(`《${remote.name}》已同步 ${res.chapters} 章${res.failed ? `，${res.failed} 章读取失败` : ''}`,
      res.failed > 0);
    await openWriterBook(remote.bookId);
  } catch (err) {
    writerNotice(`同步失败：${err.message || err}。请先点右上角“打开作者后台”完成登录。`, true);
  } finally {
    btn.disabled = false;
  }
}

/**
 * 作品库里那些只有空壳的书（0 字）批量补正文。
 *
 * 只补「本地还没有任何正文」的：本地写过的内容一律不覆盖——平台上的不一定比本地新，
 * 真要从平台覆盖，逐本点开同步自己确认。
 */
$('#btnWriterPullAll').addEventListener('click', async () => {
  const btn = $('#btnWriterPullAll');
  const origin = btn.textContent;
  const targets = writerBooks.filter((b) => b.source !== 'remote' && !Number(b.words));
  if (!targets.length) {
    writerNotice('所有作品都已经有正文了，不需要再读取。');
    return;
  }

  btn.disabled = true;
  let done = 0;
  let total = 0;
  const failed = [];
  try {
    for (const book of targets) {
      done += 1;
      btn.textContent = `读取中 ${done}/${targets.length}`;
      try {
        const res = await pullWriterBookChapters(book, (text) => {
          writerNotice(`[${done}/${targets.length}] ${text}`);
        });
        total += res.chapters;
        if (res.failed) failed.push(`《${book.name}》${res.failed} 章读取失败`);
      } catch (err) {
        failed.push(`《${book.name}》：${err.message || err}`);
      }
      await loadWriterBooks();
    }
    const skipped = writerBooks.filter((b) => b.source !== 'remote' && Number(b.words)).length;
    // writerNotice 走 textContent，不能塞 HTML
    writerNotice(
      `读取完成：${targets.length - failed.length} 本共 ${total} 章`
      + (skipped ? `；另有 ${skipped} 本本地已有正文，未覆盖` : '')
      + (failed.length ? `。未成功：${failed.slice(0, 3).join('；')}${failed.length > 3 ? ' …' : ''}` : ''),
      failed.length > 0
    );
  } finally {
    btn.disabled = false;
    btn.textContent = origin;
  }
});

/** 目录顺序在 chapter-order.js 里（纯函数，可在 Node 里直接测） */
const writerDisplayChapters = (book) => window.ChapterOrder.displayChapters(book);

function writerChapterStatus(chapter) {
  return String(chapter && chapter.status || '').toLowerCase() === 'published'
    || String(chapter && chapter.origin || '').toLowerCase() === 'platform'
    || !!(chapter && chapter.platformChapterId)
    ? '已发布' : '未发布';
}

function renderWriterChapterList() {
  if (!writerEditorBook) return;
  const query = $('#writerChapterSearch').value.trim().toLowerCase();
  const groups = new Map();
  writerDisplayChapters(writerEditorBook).forEach((chapter) => {
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
            <span class="writer-chapter-title" title="${escapeHtml(chapter.title)}">${escapeHtml(chapter.title)}</span>
            <em class="writer-chapter-status${chapter.conflict ? ' is-conflict' : ''}">${writerChapterStatus(chapter)}${chapter.conflict ? '·冲突' : ''}</em>
            <small>${writerFormatNumber(writerWordCount(chapter.content))}</small>
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
  const statusEl = $('#writerChapterStatus');
  if (statusEl) {
    const published = writerChapterStatus(chapter) === '已发布';
    statusEl.textContent = published
      ? (chapter.conflict ? '已发布 · 同章冲突' : '已发布')
      : (chapter.conflict ? '未发布 · 同章冲突' : '未发布');
    statusEl.classList.toggle('is-published', published && !chapter.conflict);
    statusEl.classList.toggle('is-conflict', !!chapter.conflict);
  }
  writerBeforeText = chapter.content;
  writerSavedWordBaseline = writerWordCount(chapter.content);
  writerSavedBaselineChapterId = String(chapter.id);
  writerLastSavedChapterWords = writerSavedWordBaseline;
  writerTypedMask = chapter.content.split('').map(() => 0);
  writerBeforeMask = writerTypedMask.slice();
  updateWriterWordCount();
  renderWriterChapterList();
  // 换章：上一章的「无视」不该带过来，重新扫一遍
  writerBadwordIgnored.clear();
  writerTypoIgnored.clear();
  scanWriterBadwords();
  // 目录长起来以后，当前章可能落在滚动区外：滚进视野。
  // 用 nearest 而不是 center，已经可见时不滚动，免得每点一次就整屏跳一下。
  const activeChapterEl = document.querySelector('#writerChapterList .writer-chapter-item.is-active');
  if (activeChapterEl && typeof activeChapterEl.scrollIntoView === 'function') {
    activeChapterEl.scrollIntoView({ block: 'nearest' });
  }
  refreshBuiltInIncomeEditorStat().catch((err) => console.error('刷新本章稿费失败', err));
}

// 正文 textarea 要先拿到，后面的高亮层同步与输入监听都靠它
const writerContent = $('#writerContent');

// ------------------------------------------------------ 码字区：敏感词实时检测
//
// 高亮不是画在 textarea 里的（它只认纯文本），而是垫一层同样排版的 div，
// 用 BadWords.highlightHtml 生成带 <mark> 的 HTML。两层共用 --writer-* 变量，
// 字号行距怎么调都不会错位；滚动位置靠 scroll 事件同步。

/** 词库里的词（只取 2 字以上：单字词几乎全是误报，会把整章刷红） */
let writerBadwordWords = [];
/** 本章被「无视」的词：换章就清空 */
const writerBadwordIgnored = new Set();
let writerBadwordHits = [];
let writerBadwordTimer = null;

async function loadWriterBadwordWords() {
  try {
    const list = await window.api.badword.list();
    writerBadwordWords = (list || [])
      .map((x) => String(x && x.w != null ? x.w : x))
      .filter((w) => w.length >= 2);
  } catch (_) {
    writerBadwordWords = [];
  }
  return writerBadwordWords;
}

/** 高亮层：文字透明，只画命中词的底色 */
function renderWriterHighlight(text, words, typoHits) {
  const layer = $('#writerHighlight');
  if (!layer) return;
  const marks = [];
  window.BadWords.hitRanges(text, words).forEach((hit) => {
    marks.push({ start: hit.start, end: hit.end, type: 'badword', priority: 2 });
  });
  (typoHits || []).forEach((hit) => {
    marks.push({ start: hit.start, end: hit.end, type: 'typo', priority: 1 });
  });
  marks.sort((a, b) => a.start - b.start || b.priority - a.priority || b.end - a.end);
  const visible = [];
  marks.forEach((mark) => {
    const previous = visible[visible.length - 1];
    if (previous && mark.start < previous.end) return;
    visible.push(mark);
  });

  // 行首缩进单独包一层：开了下划线时把这两个全角空格藏掉（宽度还在），
  // 否则「自动空开的两格」下面也会有一条线，看着像正文没对齐。
  const escapeHtml = window.BadWords.escapeHtml;
  let atLineStart = true;
  function plain(segment) {
    let html = '';
    let i = 0;
    while (i < segment.length) {
      if (atLineStart) {
        const indent = /^[\u3000 \t]+/.exec(segment.slice(i));
        if (indent) {
          html += `<span class="w-indent">${escapeHtml(indent[0])}</span>`;
          i += indent[0].length;
          atLineStart = false;
          continue;
        }
        atLineStart = false;
      }
      const nl = segment.indexOf('\n', i);
      if (nl < 0) {
        html += escapeHtml(segment.slice(i));
        break;
      }
      html += escapeHtml(segment.slice(i, nl + 1));
      i = nl + 1;
      atLineStart = true;
    }
    return html;
  }

  if (!visible.length) {
    layer.innerHTML = plain(text);
  } else {
    let html = '';
    let cursor = 0;
    visible.forEach((mark) => {
      html += plain(text.slice(cursor, mark.start));
      const cls = mark.type === 'typo' ? ' class="is-typo"' : '';
      const body = text.slice(mark.start, mark.end);
      html += `<mark${cls}>${escapeHtml(body)}</mark>`;
      // 命中词不含换行；万一下次改成整段标记，这里按实际内容重算
      atLineStart = body.endsWith('\n');
      cursor = mark.end;
    });
    html += plain(text.slice(cursor));
    layer.innerHTML = html;
  }
  layer.scrollTop = writerContent.scrollTop;
  layer.scrollLeft = writerContent.scrollLeft;
}

/** 右栏列表：按词聚合，同一个词只给一组处理按钮 */
function renderWriterBadwordPanel(hits, text) {
  const list = $('#wbpList');
  if (!list) return;
  $('#wbpCount').textContent = String(hits.length);
  $('#wbpEmpty').hidden = hits.length > 0;

  const byWord = new Map();
  hits.forEach((h) => {
    if (!byWord.has(h.word)) byWord.set(h.word, { word: h.word, count: 0, sample: null });
    const it = byWord.get(h.word);
    it.count += 1;
    if (!it.sample) it.sample = window.BadWords.contextOf(text, h.start, h.end, 10);
  });

  list.innerHTML = [...byWord.values()].map((it) => {
    const s = it.sample || { before: '', hit: it.word, after: '' };
    const hasSyn = window.BadWords.synonyms(it.word).length > 0;
    return `
      <div class="wbp-item">
        <div class="wbp-word">${escapeHtml(it.word)}${it.count > 1 ? ` ×${it.count}` : ''}</div>
        <div class="wbp-ctx">${escapeHtml(s.before)}<mark>${escapeHtml(s.hit)}</mark>${escapeHtml(s.after)}</div>
        <div class="wbp-acts">
          <button type="button" data-wb-word="${escapeHtml(it.word)}" data-wb-mode="dot">加间隔号</button>
          <button type="button" data-wb-word="${escapeHtml(it.word)}" data-wb-mode="synonym"
                  ${hasSyn ? '' : 'disabled title="词库里没有这个词的近义候选"'}>换近义词</button>
          <button type="button" data-wb-word="${escapeHtml(it.word)}" data-wb-mode="del">删掉</button>
          <button type="button" class="is-skip" data-wb-word="${escapeHtml(it.word)}" data-wb-mode="skip">无视</button>
        </div>
      </div>`;
  }).join('');
}

let writerTypoIgnoredWords = new Set();
/** 本章临时忽略：换章清空，避免误把一次性文学表达带到下一章。 */
const writerTypoIgnored = new Set();
let writerTypoHits = [];

function renderWriterTypoPanel(hits, text) {
  const list = $('#wtpList');
  if (!list) return;
  $('#wtpCount').textContent = String(hits.length);
  $('#writerTypoToolbarCount').textContent = String(hits.length);
  $('#wtpEmpty').hidden = hits.length > 0;
  list.innerHTML = hits.map((hit, index) => {
    const c = hit.context || { before: '', hit: hit.word, after: '' };
    return `
      <div class="wtp-item">
        <div class="wtp-word"><span>${escapeHtml(hit.word)}</span><b>→</b><strong>${escapeHtml(hit.suggestion)}</strong></div>
        <div class="wtp-ctx">${escapeHtml(c.before)}<mark>${escapeHtml(c.hit)}</mark>${escapeHtml(c.after)}</div>
        <div class="wtp-reason">${escapeHtml(hit.reason)}</div>
        <div class="wtp-acts">
          <button type="button" data-typo-index="${index}" data-typo-mode="replace">替换</button>
          <button type="button" data-typo-index="${index}" data-typo-mode="ignore">本章忽略</button>
          <button type="button" data-typo-index="${index}" data-typo-mode="save-ignore">加入忽略词库</button>
        </div>
      </div>`;
  }).join('');
}

function scanWriterBadwords() {
  const text = writerContent.value || '';
  const words = writerBadwordWords.filter((w) => !writerBadwordIgnored.has(w));

  // 区间合并交给 BadWords.hitRanges：高亮层和这里用同一份结果，
  // 否则会出现「正文高亮 3 处、右栏说 4 处」这种对不上
  const hits = window.BadWords.hitRanges(text, words);

  writerBadwordHits = hits;
  writerTypoHits = window.Typos
    ? window.Typos.find(text, { ignoredWords: [...writerTypoIgnoredWords, ...writerTypoIgnored] })
    : [];
  renderWriterHighlight(text, words, writerTypoHits);
  renderWriterBadwordPanel(hits, text);
  renderWriterTypoPanel(writerTypoHits, text);
}

function scheduleBadwordScan() {
  clearTimeout(writerBadwordTimer);
  writerBadwordTimer = setTimeout(scanWriterBadwords, 260);
}

/**
 * 处理一个命中词。模式与发布侧栏一致：dot 加间隔号 / synonym 换近义 / del 删掉 / skip 无视。
 * 改的是整章里这个词的所有出现（和侧栏「一键处理」的行为相同）。
 */
function applyWriterBadwordFix(word, mode) {
  if (!word) return;

  if (mode === 'skip') {
    writerBadwordIgnored.add(word);
    scanWriterBadwords();
    $('#writerBottomState').textContent = `已无视「${word}」，本章不再提示`;
    return;
  }

  const before = writerContent.value;
  const res = window.BadWords.applyPlan(before, [{ word, mode }]);
  if (!res.text || res.text === before) {
    $('#writerBottomState').textContent = mode === 'synonym'
      ? `「${word}」没有可用的近义候选，可以改用「加间隔号」`
      : `没能修改「${word}」`;
    return;
  }

  const caret = writerContent.selectionStart;
  writerContent.value = res.text;
  // 直接改 value 会把输入掩码与撤销栈打断，按「一键排版」的老办法重置一次
  writerTypedMask = writerContent.value.split('').map(() => 0);
  const shift = res.text.length - before.length;
  const pos = Math.max(0, Math.min(writerContent.value.length, caret + shift));
  writerContent.setSelectionRange(pos, pos);

  syncWriterChapterFromForm();
  updateWriterWordCount();
  markWriterDirty();
  scanWriterBadwords();
  writerContent.focus();
  $('#writerBottomState').textContent = `已处理「${word}」`;
}

$('#wbpList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-wb-word]');
  if (!btn) return;
  applyWriterBadwordFix(btn.dataset.wbWord, btn.dataset.wbMode);
});

function applyWriterTypoFix(index, mode) {
  const hit = writerTypoHits[Number(index)];
  if (!hit) return;
  if (mode === 'ignore') {
    writerTypoIgnored.add(hit.word);
    scanWriterBadwords();
    $('#writerBottomState').textContent = `本章已无视「${hit.word}」的错别字提示`;
    return;
  }
  if (mode === 'save-ignore') {
    writerTypoIgnoredWords.add(hit.word);
    if (window.Prefs) window.Prefs.set('typoIgnoredWords', [...writerTypoIgnoredWords]);
    scanWriterBadwords();
    $('#writerBottomState').textContent = `已将「${hit.word}」加入错别字忽略词库`;
    return;
  }
  const current = writerContent.value.slice(hit.start, hit.end);
  if (current !== hit.word) { scanWriterBadwords(); return; }
  writerContent.focus();
  writerContent.setSelectionRange(hit.start, hit.end);
  writerContent.setRangeText(hit.suggestion, hit.start, hit.end, 'end');
  writerTypedMask = writerContent.value.split('').map(() => 0);
  syncWriterChapterFromForm();
  updateWriterWordCount();
  markWriterDirty();
  scanWriterBadwords();
  $('#writerBottomState').textContent = `已将「${hit.word}」替换为「${hit.suggestion}」`;
}

$('#wtpList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-typo-index]');
  if (!btn) return;
  applyWriterTypoFix(btn.dataset.typoIndex, btn.dataset.typoMode);
});

// 设置页手动加词之后，码字台的词表要跟着换（不然得重启才生效）
window.addEventListener('badwords:changed', () => {
  loadWriterBadwordWords().then(() => {
    if (writerEditorBook) scanWriterBadwords();
  });
});

writerContent.addEventListener('scroll', () => {
  const layer = $('#writerHighlight');
  if (!layer) return;
  layer.scrollTop = writerContent.scrollTop;
  layer.scrollLeft = writerContent.scrollLeft;
});

// ------------------------------------------------------ 码字区：显示设置

/**
 * 码字台可选的字体族。
 *
 * 每一项都以通用族收尾：思源、霞鹜这类需要用户自己装，没装时浏览器会往下
 * 找第一个存在的字体，所以每串都排在「一定能拿到」的中文字体前面之后。
 * 键名存进 Prefs，改名字会让老用户的选择失效——只能加，不能改名。
 */
const WRITER_FONTS = {
  yahei: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
  hei: 'SimHei, "Heiti SC", "Noto Sans SC", sans-serif',
  sans: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  dengxian: 'DengXian, "Microsoft YaHei", "PingFang SC", sans-serif',
  serif: '"Noto Serif SC", "Source Han Serif SC", SimSun, "Songti SC", serif',
  fangsong: 'FangSong, "FangSong_GB2312", STFangsong, SimSun, serif',
  kai: 'KaiTi, "Kaiti SC", STKaiti, serif',
  stkai: 'STKaiti, "Kaiti SC", KaiTi, serif',
  wenkai: '"LXGW WenKai", "LXGW WenKai GB", KaiTi, "Kaiti SC", serif',
  yuanti: 'YouYuan, "Yuanti SC", "Microsoft YaHei", sans-serif',
  system: 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
};
const WRITER_DISPLAY_DEFAULT = {
  font: 'yahei', size: 16, line: 2.05, width: 760,
  letter: 0.2, bold: false, underline: false,
};

function writerDisplayPrefs() {
  const saved = (window.Prefs && window.Prefs.get('writerDisplay', null)) || {};
  const v = Object.assign({}, WRITER_DISPLAY_DEFAULT, saved);
  // 配置文件被手改过、或以后删掉某个字体时，别让下拉框变成空白
  if (!WRITER_FONTS[v.font]) v.font = WRITER_DISPLAY_DEFAULT.font;
  return v;
}

function applyWriterDisplay(patch) {
  const v = Object.assign(writerDisplayPrefs(), patch || {});
  const host = $('#writerWorkspace');
  if (host) {
    // 这些变量挂在工作区上：纸张读 --writer-paper-width，正文与高亮层共用其余几个
    host.style.setProperty('--writer-font', WRITER_FONTS[v.font] || WRITER_FONTS.yahei);
    host.style.setProperty('--writer-size', `${v.size}px`);
    host.style.setProperty('--writer-line', String(v.line));
    host.style.setProperty('--writer-letter', `${v.letter}px`);
    host.style.setProperty('--writer-weight', v.bold ? '600' : '400');
    host.style.setProperty('--writer-paper-width', `${v.width}px`);
  }
  // 下划线画在高亮层上（textarea 自己不接受 text-decoration），用 body 类开关
  document.body.classList.toggle('is-writer-underline', !!v.underline);
  $('#wdpFont').value = v.font;
  $('#wdpSizeVal').textContent = `${v.size} px`;
  $('#wdpLineVal').textContent = Number(v.line).toFixed(2);
  $('#wdpLetterVal').textContent = `${Number(v.letter).toFixed(1)} px`;
  $('#wdpWidthVal').textContent = `${v.width} px`;
  const styleBox = $('#wdpStyle');
  if (styleBox) {
    Array.prototype.forEach.call(styleBox.children, (b) => {
      b.classList.toggle('is-active', !!v[b.dataset.wdpStyle]);
    });
  }
  syncWdpGap(detectWriterGap());
  // 换字号/行距后行高变了，高亮层要跟着重新对齐滚动位置
  const layer = $('#writerHighlight');
  if (layer) layer.scrollTop = writerContent.scrollTop;
  return v;
}

/** 当前正文里段落之间实际空了几行（最多算 2 档） */
function detectWriterGap() {
  return window.WriterParagraph
    ? window.WriterParagraph.detectGap(writerContent.value)
    : 0;
}

function syncWdpGap(gap) {
  const box = $('#wdpParaGap');
  if (!box) return;
  Array.prototype.forEach.call(box.children, (b) => {
    b.classList.toggle('is-active', Number(b.dataset.wdpGap) === gap);
  });
}

/**
 * 段间距：把正文里的空行统一成「段与段之间空 N 行」。
 *
 * 纯文本编辑器没有 CSS 段间距（textarea 只认 line-height），要做到「段距比行距大」
 * 只能真的插空行。这是会写进正文的操作，发布到站点后同样是空行，和作者手动敲空行一致。
 */
function applyWriterParagraphGap(gap) {
  const wanted = Math.max(0, Math.min(2, Number(gap) || 0));
  const before = String(writerContent.value || '').replace(/\r\n?/g, '\n');
  const text = window.WriterParagraph
    ? window.WriterParagraph.applyGap(before, wanted)
    : before;
  syncWdpGap(wanted);
  if (text === before) {
    $('#writerBottomState').textContent = wanted ? `段落之间已经是空 ${wanted} 行` : '段落之间已经是紧凑的';
    return;
  }
  const caret = Math.min(writerContent.selectionStart, text.length);
  writerContent.value = text;
  writerTypedMask = text.split('').map(() => 0);
  writerContent.setSelectionRange(caret, caret);
  syncWriterChapterFromForm();
  updateWriterWordCount();
  markWriterDirty();
  scanWriterBadwords();
  $('#writerBottomState').textContent = wanted ? `段落之间已空 ${wanted} 行` : '已收紧段落间距';
}

/** 加减号的步长与上下限；页面宽度上限放到 1600，专注模式下才拉得开 */
const WDP_LIMITS = {
  size: { min: 12, max: 32, step: 1 },
  line: { min: 1.2, max: 3.0, step: 0.05 },
  letter: { min: 0, max: 4, step: 0.2 },
  width: { min: 620, max: 1600, step: 20 },
};

function clampWdp(key, value) {
  const l = WDP_LIMITS[key];
  if (!l) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const stepped = Math.round(n / l.step) * l.step;
  return Math.min(l.max, Math.max(l.min, Number(stepped.toFixed(2))));
}

function saveWriterDisplay(patch) {
  const v = applyWriterDisplay(patch);
  if (window.Prefs) window.Prefs.set('writerDisplay', v);
  return v;
}

/**
 * 专注模式：界面只留章节列表与正文，窗口同时最大化。
 * 退出时按「进来之前是不是已经最大化」还原，不会把用户原本的窗口缩小。
 */
async function setWriterFocus(on) {
  writerFocusOn = !!on;
  document.body.classList.toggle('is-focus', writerFocusOn);
  const btn = $('#btnWriterFocus');
  if (btn) {
    btn.classList.toggle('is-active', writerFocusOn);
    btn.textContent = writerFocusOn ? '退出专注' : '专注模式';
  }
  // 专注模式左右都让出来了，页面默认给到 1100；退出时还原成偏好里的宽度
  const saved = writerDisplayPrefs();
  applyWriterDisplay({ width: writerFocusOn ? Math.max(1100, saved.width) : saved.width });
  // 侧栏藏起来后内容区变宽，平台视图的矩形要重算
  syncBounds();
  try {
    await window.api.app.focusMode(writerFocusOn);
  } catch (_) { /* 最大化失败也不影响界面切换 */ }
}

$('#btnWriterFocus').addEventListener('click', () => setWriterFocus(!writerFocusOn));


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

/**
 * 做下一件事之前，先把当前改动落盘。
 *
 * writerSaveNow 失败会 reject（错误提示已在保存流程里显示）。直接 await 的
 * 后果是 async 事件处理器被中断，用户看到的是「点了没反应」；统一在这里
 * 吞掉异常并返回 false，让调用方显式 return，至少行为是可解释的。
 */
async function writerFlushBeforeAction() {
  if (!writerDirty) return true;
  try {
    await writerSaveNow(true);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 退出兜底：主进程关闭主窗口时会触发 beforeunload。
 *
 * 自动保存是 900ms 防抖，而主进程 before-quit 会直接关窗口 ——
 * 不在这里同步写一次，最后敲的那几个字就没了。异步 invoke 在窗口销毁后
 * 不一定能跑完，所以用 sendSync：主进程写完盘才放行关闭。
 */
window.addEventListener('beforeunload', () => {
  if (!writerDirty || !writerEditorBook) return;
  try {
    syncWriterChapterFromForm();
    const snapshot = {
      ...writerEditorBook,
      chapters: writerEditorBook.chapters.map((c) => ({ ...c })),
    };
    window.api.app.flushSync(snapshot);
    writerDirty = false;
  } catch (_) { /* 退出路径尽力而为，失败也不阻止关闭 */ }
});

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
  /*
   * 只做浅拷贝，不再 JSON.parse(JSON.stringify(整本))。
   * 章节正文是字符串（不可变），逐章浅拷贝就足够隔离；
   * 原来每 900ms 对几十 MB 的书做一次完整序列化 + 解析，大长篇会明显卡顿。
   */
  const bookSnapshot = {
    ...writerEditorBook,
    chapters: writerEditorBook.chapters.map((c) => ({ ...c })),
  };
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

$('#writerLibrary').addEventListener('click', async (e) => {
  const pin = e.target.closest('[data-writer-pin]');
  if (pin) {
    e.stopPropagation();
    const book = writerBooks.find((b) => String(b.bookId) === pin.dataset.writerPin);
    if (!book || book.source === 'remote') return;
    pin.disabled = true;
    try {
      const result = await window.api.writer.pin(book.bookId, !book.pinned);
      if (!result || !result.result) throw new Error('优先级状态保存失败');
      const on = !!result.result.pinned;

      // 主进程已经把写入后的完整书目一起返回了，直接用它重画。
      // 比再发一次 list 更稳：不会再出现「pin 成功但界面还是 0 本」的空档。
      if (Array.isArray(result.books)) {
        const ids = new Set(result.books.flatMap((b) => [b.bookId, b.platformBookId]
          .filter(Boolean).map(String)));
        writerRemoteBooks = writerRemoteBooks.filter((b) => !ids.has(String(b.bookId)));
        writerBooks = result.books.concat(writerRemoteBooks);
        renderWriterBooks();
      } else {
        await loadWriterBooks();
      }

      // 看板刷新单独兜起来：它要用快照、图表等一堆东西，
      // 万一这里抛错，不能连带把「优先级已保存」这个结果变成失败提示。
      try {
        await refreshPriorityInfo();
        // 概览列表里那一行会换成实心星并排到第一；详情页的星标也跟着变。
        // 只是重画，不改查看范围 —— 用户正在看哪本就继续看哪本。
        renderBoard();
      } catch (err) {
        console.warn('刷新数据看板失败', err);
      }

      writerNotice(
        on
          ? `《${book.name}》已设为优先：创作中心与数据看板都会排在第一个并显示星标`
          : `《${book.name}》已取消优先`,
        false,
        3000,
      );
    } catch (err) {
      writerNotice(`设置优先级失败：${err.message || err}`, true);
      pin.disabled = false;
    }
    return;
  }
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

$$('.writer-library-filter').forEach((button) => {
  button.addEventListener('click', () => {
    writerPinnedOnly = button.dataset.writerFilter === 'pinned';
    renderWriterBooks();
  });
});

$('#btnWriterRefresh').addEventListener('click', loadWriterBooks);
$('#btnWriterSync').addEventListener('click', async () => {
  const btn = $('#btnWriterSync');
  btn.disabled = true;
  writerNotice('正在读取作者后台作品列表…');
  try {
    const remote = await window.Exporter.listBooks();
    // 先把封面写进本地作品库：这样已同步的书也能显示封面，且重启后仍保留
    try {
      await window.api.writer.covers(remote.map((b) => ({ bookId: b.bookId, cover: b.cover || '' })));
    } catch (_) { /* 封面写不进去不影响同步主流程 */ }
    writerRemoteBooks = remote.map((b) => ({
      ...b,
      source: 'remote',
      chapters: b.chapters || 0,
      words: b.words || 0,
    }));
    const adopted = await adoptNewPlatformBooks(remote);
    const sync = adopted && adopted.sync;
    if (sync && (sync.added || sync.failed || sync.skipped)) {
      writerNotice(`作者库已刷新：新增 ${sync.added} 章`
        + (sync.conflicts ? `，发现 ${sync.conflicts} 个同章冲突` : '')
        + (sync.failed ? `，${sync.failed} 章读取失败` : '')
        + (sync.skipped ? `，${sync.skipped} 本正在编辑的作品稍后再检查` : ''), sync.failed > 0);
    } else {
      await loadWriterBooks();
      writerNotice(writerRemoteBooks.length
        ? `作者库中还有 ${writerRemoteBooks.length} 本作品未同步，点击作品即可读取正文并开始创作。`
        : `作者库中的 ${remote.length} 本作品均已在本地。`);
    }
  } catch (err) {
    writerNotice(`读取作者库失败：${err.message || err}。请先点右上角“打开作者后台”完成登录。`, true);
  } finally {
    btn.disabled = false;
  }
});
$('#btnWriterCreate').addEventListener('click', async () => {
  const name = await askText({
    title: '新建书籍',
    hint: '给这本书取个名字，之后可以在作品设置里修改。',
    value: '我的新书',
  });
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
  if (!(await writerFlushBeforeAction())) return;
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
  if (!(await writerFlushBeforeAction())) return;
  writerChapterId = btn.dataset.writerChapter;
  loadWriterChapter();
  $('#writerContent').focus();
});

$('#writerChapterSearch').addEventListener('input', renderWriterChapterList);

/** 「101」「１２」「一百零一」「十二」→ 数字；认不出来返回 NaN。实现见 chapter-order.js */
function writerChineseNumber(text) {
  return window.ChapterOrder.numberFromText(text);
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
$('#btnWriterNewVolume').addEventListener('click', async () => {
  if (!writerEditorBook) return;
  const volume = await askText({
    title: '新建分卷',
    hint: '卷名会作为目录分组显示。',
    value: `第${new Set(writerEditorBook.chapters.map((c) => c.volume)).size + 1}卷`,
  });
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

/** 段首缩进：两个全角空格。计算逻辑在 writer-indent.js（纯函数，可在 Node 里测） */
const WRITER_INDENT = window.WriterIndent.INDENT;

/**
 * 回车即带段首缩进。
 *
 * 以前要写完再点「一键排版」才把每段顶格的字推到两个字符，现在直接照排版后的样子写。
 * 只影响回车产生的新段首：一行写满自动折行的那部分仍然顶格，和排版工具的观感一致。
 * Shift+回车保留原本的纯换行，需要顶格续行时用它。
 */
writerContent.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  // 输入法候选框里的回车是「上屏」，不能拦
  if (e.isComposing || writerComposing || e.keyCode === 229) return;

  const plan = window.WriterIndent.planEnter(
    writerContent.value, writerContent.selectionStart, writerContent.selectionEnd
  );

  e.preventDefault();
  writerContent.setSelectionRange(plan.from, plan.to);
  try {
    // 走原生输入路径：撤销栈、beforeinput/input 都是浏览器自己发的，
    // 码字统计与自动保存不用另外通知
    if (!document.execCommand('insertText', false, plan.text)) throw new Error('execCommand 未生效');
  } catch (_) {
    writerContent.setRangeText(plan.text, plan.from, plan.to, 'end');
    writerContent.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

/**
 * 新章第一段：正文还空着时开始输入，先补上段首缩进。
 * 不加这段的话整篇只有第一段顶格，得点一次「一键排版」才对齐。
 * 只认手工输入的 insertText（粘贴、输入法上屏都不插），空文本以外的内容一律不碰。
 *
 * 注意不能「改完 value 再交给浏览器继续插入」：DOM 值被脚本换掉之后，
 * 浏览器先前算好的插入点会失效，字被插到缩进前面、光标停在第一个字之前。
 * 所以这里拦住默认插入，自己写入「缩进 + 这个字符」，光标明确落在末尾。
 */
writerContent.addEventListener('beforeinput', (e) => {
  if (writerContent.value !== '') return;
  if (e.inputType !== 'insertText' || !e.data || e.data === '\n') return;
  e.preventDefault();
  writerBeforeText = '';
  writerBeforeMask = [];
  writerInputType = 'insertText';
  writerExcludeInput = false;
  writerSuppressInput = false;
  writerContent.setRangeText(WRITER_INDENT + e.data, 0, 0, 'end');
  writerContent.dispatchEvent(new Event('input', { bubbles: true }));
});

/**
 * 输入法在 beforeinput 里的类型是 insertCompositionText，上面那条接不到。
 * 中文写作基本都走这条路，所以在第一个按键（输入法起始时 key 是 Process）先把缩进补上，
 * 组合输入随后从缩进之后开始。
 */
writerContent.addEventListener('keydown', (e) => {
  if (writerContent.value !== '') return;
  if (e.isComposing || writerComposing) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const printable = e.key.length === 1 || e.key === 'Process' || e.keyCode === 229;
  if (!printable) return;
  writerContent.value = WRITER_INDENT;
  writerContent.setSelectionRange(WRITER_INDENT.length, WRITER_INDENT.length);
});

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
  scheduleBadwordScan();
});

$('#btnWriterFormat').addEventListener('click', async () => {
  if (!(await writerFlushBeforeAction())) return;
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
    out.push(`${WRITER_INDENT}${text.replace(/^[　 ]+/, '')}`);
  });
  writerContent.value = out.join('\n').trimEnd();
  writerTypedMask = writerContent.value.split('').map(() => 0);
  syncWriterChapterFromForm();
  updateWriterWordCount();
  markWriterDirty();
  $('#writerBottomState').textContent = '已完成段首缩进与空行整理';
});

// 显示设置面板：改动即生效，并写进偏好，下次打开还是这套观感
$('#btnWriterDisplay').addEventListener('click', () => {
  const panel = $('#writerDisplayPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) applyWriterDisplay();
});
$('#btnWdpClose').addEventListener('click', () => { $('#writerDisplayPanel').hidden = true; });

$('#wdpFont').addEventListener('change', () => {
  saveWriterDisplay({ font: $('#wdpFont').value });
  scanWriterBadwords();
});

// 加减号与样式开关：一次一格，改完即时生效
$('#writerDisplayPanel').addEventListener('click', (e) => {
  const styleBtn = e.target.closest('[data-wdp-style]');
  if (styleBtn) {
    const key = styleBtn.dataset.wdpStyle;
    saveWriterDisplay({ [key]: !writerDisplayPrefs()[key] });
    return;
  }
  const gapBtn = e.target.closest('[data-wdp-gap]');
  if (gapBtn) {
    applyWriterParagraphGap(Number(gapBtn.dataset.wdpGap));
    return;
  }
  const btn = e.target.closest('[data-wdp-dir]');
  if (!btn) return;
  const key = btn.closest('[data-wdp]').dataset.wdp;
  const limit = WDP_LIMITS[key];
  if (!limit) return;
  const dir = Number(btn.dataset.wdpDir) || 0;
  const cur = Number(writerDisplayPrefs()[key]) || 0;
  const next = clampWdp(key, cur + dir * limit.step);
  if (next == null || next === cur) return;
  saveWriterDisplay({ [key]: next });
});

// 点面板外面就收起：以前必须再点一次「收起」，多一下很别扭
document.addEventListener('click', (e) => {
  const panel = $('#writerDisplayPanel');
  if (!panel || panel.hidden) return;
  if (panel.contains(e.target) || e.target.closest('#btnWriterDisplay')) return;
  panel.hidden = true;
});

document.addEventListener('keydown', (e) => {
  const panel = $('#writerDisplayPanel');
  if (e.key === 'Escape' && panel && !panel.hidden) panel.hidden = true;
});

$('#btnWdpReset').addEventListener('click', () => {
  saveWriterDisplay(WRITER_DISPLAY_DEFAULT);
  scanWriterBadwords();
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
  if (!(await writerFlushBeforeAction())) return;
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
  if (!(await writerFlushBeforeAction())) return;
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
$('#btnWriterTypos').addEventListener('click', () => {
  const panel = $('#writerTypos');
  panel.hidden = !panel.hidden;
  $('#btnWriterTypos').classList.toggle('is-active', !panel.hidden);
});
$('#btnWriterTyposCollapse').addEventListener('click', () => {
  const body = $('#writerTypoBody');
  const collapsed = body.hidden;
  body.hidden = !collapsed;
  const button = $('#btnWriterTyposCollapse');
  button.textContent = collapsed ? '收起⌃' : '展开⌄';
  button.setAttribute('aria-expanded', String(collapsed));
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
      const entered = await askText({
        title: '绑定后台作品',
        hint: `请填写《${localBook.name}》对应的后台作品号：\n\n${choices}`,
        value: '',
      });
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
    if (!(await writerFlushBeforeAction())) throw new Error('当前修改保存失败，已取消替换');
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
    chapter.origin = 'platform';
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

$('#btnWriterSchedule').addEventListener('click', async () => {
  if (!window.Publish) return;
  const current = window.Publish.getSchedule() || '';
  const value = await askText({
    title: '定时发布',
    hint: '留空代表立即发布；定时发布请填写：年-月-日 时:分',
    value: current,
  });
  if (value == null) return;
  const next = String(value).trim();
  if (next && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(next)) {
    writerNotice('时间格式不正确，请填写成 2026-11-06 08:00', true);
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

// ------------------------------------------------------------ 摸鱼码字（透明浮层）

/**
 * 功能中心里「摸鱼码字」开着时，码字台工具栏才出现入口。
 *
 * 浮层是主进程里的独立窗口（src/main/moyu-writer.js），这里只做两件事：
 *   1. 点按钮时把当前章节的标题与正文递过去，并先落一次盘；
 *   2. 浮层按输入节奏推回正文时，用和「一键排版」同一条落地路径覆盖正文 ——
 *      保存、字数、错别字都在这里重算，不另走一套。
 */
const MOYU_PLUGIN_ID = 'moyu-writer';

function moyuEntryEnabled() {
  return pluginItems.some((p) => p.id === MOYU_PLUGIN_ID && p.enabled && !p.invalid);
}

function syncMoyuEntry() {
  const btn = $('#btnWriterMoyu');
  if (btn) btn.hidden = !moyuEntryEnabled();
}

/** 浮层推回的正文（浮层是这期间的唯一输入源，整段覆盖即可） */
function applyMoyuText(text) {
  if (typeof text !== 'string') return;
  if (!writerCurrentChapter()) return;
  if (writerContent.value === text) return;
  writerContent.value = text;
  writerBeforeText = text;
  writerTypedMask = text.split('').map(() => 0);
  writerBeforeMask = writerTypedMask.slice();
  syncWriterChapterFromForm();
  updateWriterWordCount();
  markWriterDirty();
  renderWriterStats();
  scheduleBadwordScan();
  $('#writerBottomState').textContent = '正在从摸鱼浮层同步…';
}

/** 第一次点「摸鱼码字」的说明卡只出现一次，按功能记在 ui-prefs.json 里 */
const MOYU_GUIDE_KEY = 'moyuGuideShown';

/**
 * 第一次点按钮先讲清楚它到底在做什么。
 *
 * 这个功能的入口文案（「摸鱼码字」）猜不出交互：窗口会整个消失、
 * 输入区浮在网页之上、要靠快捷键叫回来。不先说明的话，用户第一反应
 * 基本都是「点了按钮软件怎么没了」。
 *
 * @returns {boolean} true 表示正在显示说明卡，这次不要打开浮层
 */
function maybeShowMoyuGuide() {
  if (window.Prefs && window.Prefs.get(MOYU_GUIDE_KEY, false)) return false;
  if (window.Prefs) window.Prefs.set(MOYU_GUIDE_KEY, true);
  showGuideDialog({
    badge: '第一次使用',
    title: '摸鱼码字怎么用',
    lead: '点「开始写」，软件窗口会收起来，屏幕上只剩一条几乎看不见的输入区。'
      + '在那里写的字会实时同步到当前章节，保存、字数、错别字扫描照常进行，不会多出一份稿子。',
    steps: [
      '鼠标放到浮层上，顶部那条透明工具行会亮起来：按住它「任意位置」（光标是十字箭头）都能拖动，左端那块淡粉的握把就是抓的地方；点 ⚙ 调字号、字色、底色和快捷键',
      '要临时藏起来：按快捷键（默认 Ctrl + Alt + M），或者在浮层里「左键和右键同时按」；再按一次快捷键就回来',
      '写完点把手上的「↩ 回到软件」，浮层关闭、窗口还原，光标停在这章正文末尾',
      '说明卡只出现这一次，之后点按钮就直接进浮层',
    ],
    secondary: { label: '先不写' },
    primary: { label: '开始写', onClick: () => { void openMoyuOverlay(); } },
  });
  return true;
}

async function openMoyuOverlay() {
  const chapter = writerCurrentChapter();
  if (!chapter || !writerEditorBook) return;
  // 先把当前正文落盘：浮层拿到的是磁盘上这一版，两边不至于写出两个副本
  if (writerDirty) {
    try { await writerSaveNow(true); } catch (_) { /* 存失败也放行，内容以内存为准 */ }
  }
  const current = writerCurrentChapter() || chapter;
  try {
    await window.api.moyu.open({
      bookId: writerEditorBook.bookId,
      bookName: writerEditorBook.name,
      chapterId: String(current.id),
      title: current.title,
      content: writerContent.value,
      // 只跟随字体：码字台里选了宋体/楷体，浮层里也是那个字体。
      // 字号和行距仍用浮层自己的（浮层悬在别的窗口上，字小看不清）。
      font: WRITER_FONTS[writerDisplayPrefs().font] || WRITER_FONTS.yahei,
    });
  } catch (err) {
    $('#writerBottomState').textContent = `浮层没打开：${ipcError(err)}`;
  }
}

$('#btnWriterMoyu').addEventListener('click', () => {
  if (!writerCurrentChapter() || !writerEditorBook) return;
  // 第一次先看说明，点「开始写」才真正进浮层
  if (maybeShowMoyuGuide()) return;
  void openMoyuOverlay();
});

window.api.moyu.onText((payload) => { applyMoyuText(payload && payload.text); });

window.api.moyu.onClosed(() => {
  if (!$('#writerEditor').hidden) $('#writerContent').focus();
  $('#writerBottomState').textContent = '已从摸鱼浮层同步';
});

// ------------------------------------------------------------ 功能中心

let pluginItems = [];
let activePlugin = null;
let activePluginToken = '';
let activePluginRuntime = null;
const pluginBackgroundRuntimes = new Map();
const pluginEditorStats = new Map();
const pluginFloatingRuntimes = new Map();
let pluginFloatingSync = Promise.resolve();

function sendPluginHostState(runtime, payload) {
  runtime.frame.contentWindow?.postMessage({
    type: 'ciweimao-plugin-host', token: runtime.token, ...payload,
  }, '*');
}

function disposeFloatingPlugin(id) {
  const runtime = pluginFloatingRuntimes.get(id);
  if (!runtime) return;
  if (runtime.themeSwitchTimer) {
    clearTimeout(runtime.themeSwitchTimer);
    runtime.themeSwitchTimer = null;
  }
  sendPluginHostState(runtime, { event: 'dispose', mode: 'floating' });
  runtime.controller.dispose();
  pluginFloatingRuntimes.delete(id);
}

function syncPluginFloatingFrames() {
  // 串行对账避免重复启动；失败的单个插件不影响其他插件。
  pluginFloatingSync = pluginFloatingSync.catch(() => {}).then(async () => {
    const desired = new Map(pluginItems.filter((p) => p.enabled && !p.invalid
      && p.contributes && p.contributes.floatingWidget).map((p) => [p.id, p]));
    for (const id of pluginFloatingRuntimes.keys()) {
      if (!desired.has(id)) disposeFloatingPlugin(id);
    }
    for (const plugin of desired.values()) {
      const old = pluginFloatingRuntimes.get(plugin.id);
      if (old && old.plugin.version === plugin.version) continue;
      if (old) disposeFloatingPlugin(plugin.id);
      try {
        const bundle = await window.api.plugins.get(plugin.id);
        const position = await window.api.plugins.storageGet(plugin.id, '__host.floating.position');
        const frame = document.createElement('iframe');
        frame.sandbox = 'allow-scripts';
        frame.title = plugin.name;
        const host = document.createElement('div');
        host.className = 'plugin-persistent-host';
        $('#pluginPersistentHosts').appendChild(host);
        const runtime = {
          plugin: { ...plugin, manifest: bundle.manifest }, frame, token: pluginToken(),
          kind: 'floating', messageStartedAt: Date.now(), messageCount: 0,
        };
        runtime.controller = window.PluginFloating.create({
          frame, host, initialPosition: position,
          notify: (state) => sendPluginHostState(runtime, state),
          savePosition: (value) => window.api.plugins.storageSet(plugin.id, '__host.floating.position', value),
        });
        pluginFloatingRuntimes.set(plugin.id, runtime);
        frame.addEventListener('load', () => runtime.controller.render());
        const documentText = buildPluginDocument(bundle, runtime.token);
        frame.src = `data:text/html;base64,${pluginUtf8Base64(documentText)}`;
      } catch (err) {
        disposeFloatingPlugin(plugin.id);
        console.error(`插件 ${plugin.id} 常驻启动失败`, err);
      }
    }
  });
  return pluginFloatingSync;
}

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
    'stats.author': '刷新作者后台统计',
    'ui.editorStat': '显示编辑器指标',
    'ui.theme': '切换软件主题',
  }[permission] || permission;
}

/**
 * 读取功能列表并渲染。
 *
 * `autoRepair` 默认开着：列表为空时先让主进程补装一次内置功能再读一遍。
 *
 * 为什么需要它：`installBundled` 只在**启动时**跑一次。而「清除所有数据」失败后
 * 用户往往不会重启（他只是看到报错），此时 data/plugins 已经被清空、界面还是旧进程，
 * 功能中心就一直是空的 —— 用户看到的是「我的两个功能没了」，
 * 而且内置功能没有单独的重装入口，除了重装软件没别的办法。
 * 现在加载时会自愈，最多重试一次，不会递归。
 */
async function loadPlugins(opts) {
  const allowRepair = !(opts && opts.autoRepair === false);
  try {
    let result = await window.api.plugins.list();
    let list = (result && result.plugins) || [];

    if (!list.length && allowRepair
      && window.api.plugins && typeof window.api.plugins.repair === 'function') {
      const repaired = await window.api.plugins.repair().catch(() => null);
      if (repaired && Array.isArray(repaired.plugins)) {
        list = repaired.plugins;
        if (Array.isArray(repaired.installed) && repaired.installed.length) {
          const names = repaired.installed
            .map((id) => (list.find((p) => p.id === id) || {}).name || id)
            .join('、');
          pluginNotice(`已自动恢复内置功能：${names}`);
        }
      }
    }

    pluginItems = list;
    window.Theme.registerPlugins(pluginItems);
    if (activePlugin && !pluginItems.some((item) => item.id === activePlugin.id && item.enabled && !item.invalid)) {
      closePlugin();
    }
    renderPlugins();
    syncPluginNavigation();
    // 码字台的「摸鱼码字」入口跟着功能中心的开关走：关掉就整条入口消失
    syncMoyuEntry();
    await syncPluginBackgrounds();
    await syncPluginFloatingFrames();
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

/**
 * 功能中心的卡片渲染。
 *
 * 内置功能和自己导入的扩展分两组画：内置的没有「删除」，只有开关——
 * 它们没有重新安装的入口，删掉就只能重装软件。分组也让用户一眼看出
 * 哪些是软件自带、哪些是自己装的。
 */
function renderPluginCard(plugin) {
  const builtin = !!plugin.builtin;
  const selected = window.Theme.current().pluginTheme;
  const themes = (plugin.contributes && plugin.contributes.themes) || [];
  const themeButtons = themes.map((theme) => {
    const active = selected && selected.pluginId === plugin.id && selected.themeId === theme.id;
    return '<button class="btn ghost btn-sm" type="button" data-plugin-theme="' + escapeHtml(theme.id)
      + '" data-theme-plugin="' + escapeHtml(plugin.id) + '" '
      + ((!plugin.enabled || plugin.invalid || active) ? 'disabled' : '') + '>'
      + escapeHtml(theme.name) + (active ? ' · 使用中' : ' · 应用') + '</button>';
  }).join('');
  return `
    <article class="plugin-card ${plugin.enabled ? '' : 'is-disabled'} ${plugin.invalid ? 'is-invalid' : ''}">
      <div class="plugin-card-top">
        <div class="plugin-icon">${escapeHtml((plugin.name || '?').slice(0, 1))}</div>
        <div class="plugin-title">
          <h3>${escapeHtml(plugin.name)}${builtin ? '<span class="plugin-builtin-tag">内置</span>' : ''}</h3>
          <span>v${escapeHtml(plugin.version || '—')}</span>
        </div>
        ${plugin.invalid ? '<span class="tag">无效</span>' : `
          <label class="plugin-switch" title="${plugin.enabled ? '关闭这个功能' : '开启这个功能'}">
            <input type="checkbox" data-plugin-enable="${escapeHtml(plugin.id)}" ${plugin.enabled ? 'checked' : ''} />
            <i></i>
          </label>`}
      </div>
      <p>${escapeHtml(plugin.description || '没有填写说明')}</p>
      <div class="plugin-permissions">
        ${(plugin.permissions || []).length
          ? plugin.permissions.map((p) => `<span>${escapeHtml(pluginPermissionLabel(p))}</span>`).join('')
          : '<span>无需额外权限</span>'}
      </div>
      <div class="plugin-card-foot">
        <span>${plugin.author ? `作者：${escapeHtml(plugin.author)}` : escapeHtml(plugin.id)}</span>
        <button class="btn primary btn-sm" data-plugin-open="${escapeHtml(plugin.id)}"
                ${!plugin.enabled || plugin.invalid ? 'disabled' : ''} type="button">打开</button>
        ${builtin
          ? '<span class="plugin-builtin-note" title="内置功能不能删除，只能停用">随软件提供</span>'
          : `<button class="link-btn" data-plugin-remove="${escapeHtml(plugin.id)}" type="button">删除</button>`}
      </div>
      ${themeButtons ? '<div class="plugin-theme-actions">' + themeButtons + '</div>' : ''}
    </article>
  `;
}

function renderPlugins() {
  const builtin = pluginItems.filter((p) => p.builtin);
  const external = pluginItems.filter((p) => !p.builtin);
  $('#pluginEmpty').hidden = !!pluginItems.length;

  const group = (title, list, hint) => {
    if (!list.length) return '';
    return `
      <div class="plugin-group">
        <div class="plugin-group-head">
          <h3>${escapeHtml(title)}</h3>
          <span>${escapeHtml(hint)}</span>
        </div>
        <div class="plugin-grid">${list.map(renderPluginCard).join('')}</div>
      </div>`;
  };

  $('#pluginGrid').innerHTML = group('内置功能', builtin, `${builtin.length} 项 · 可开关，不可删除`)
    + group('自己装的扩展', external, `${external.length} 个 · 来自导入或开发模板`);
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
    let disposed = false;
    let hostState = null;
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const waiting = new Map();
    const listeners = new Map();
    const cleanup = new Set();
    function on(name, callback) {
      if (typeof callback !== 'function') throw new TypeError('事件回调必须是函数');
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
      return () => listeners.get(name)?.delete(callback);
    }
    function emit(name, value) {
      for (const callback of listeners.get(name) || []) {
        try { callback(value); } catch (error) { console.error('插件事件处理失败', name, error); }
      }
    }
    function dispose() {
      if (disposed) return;
      emit('dispose');
      disposed = true;
      for (const fn of cleanup) fn();
      cleanup.clear();
      for (const item of waiting.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('插件已卸载'));
      }
      waiting.clear();
      listeners.clear();
    }
    function request(method, payload, timeoutMs) {
      if (disposed) return Promise.reject(new Error('插件已卸载'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          const item = waiting.get(id);
          if (!item) return;
          waiting.delete(id);
          item.reject(new Error('插件请求超时'));
        }, timeoutMs || 15000);
        waiting.set(id, { resolve, reject, timer });
        parent.postMessage({ type: 'ciweimao-plugin-request', token: TOKEN, id, method, payload }, '*');
      });
    }
    function hostEvent(event, payload) {
      if (!disposed) parent.postMessage({ type: 'ciweimao-plugin-host-event', token: TOKEN, event, ...payload }, '*');
    }
    function bindDrag(element, options = {}) {
      if (!element || typeof element.addEventListener !== 'function') throw new TypeError('请传入可拖动元素');
      let drag = null;
      let scheduled = 0;
      let latest;
      function flush() {
        scheduled = 0;
        if (latest) hostEvent('drag-move', latest);
        latest = null;
      }
      function down(e) {
        if (e.button !== 0 || drag) return;
        e.preventDefault();
        drag = { id: e.pointerId, x: e.screenX, y: e.screenY, moved: false };
        element.setPointerCapture(e.pointerId);
        element.classList.add('dragging');
        hostEvent('drag-start', {});
      }
      function move(e) {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (!drag.moved) return;
        latest = { dx, dy };
        if (!scheduled) scheduled = requestAnimationFrame(flush);
      }
      function end(e) {
        if (!drag || e.pointerId !== drag.id) return;
        const clicked = !drag.moved && e.type === 'pointerup';
        drag = null;
        if (scheduled) { cancelAnimationFrame(scheduled); scheduled = 0; }
        flush();
        element.classList.remove('dragging');
        try { element.releasePointerCapture(e.pointerId); } catch (_) {}
        hostEvent(e.type === 'pointerup' ? 'drag-end' : 'drag-cancel', {});
        if (clicked && typeof options.onClick === 'function') options.onClick(e);
      }
      element.addEventListener('pointerdown', down);
      element.addEventListener('pointermove', move);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(name, end);
      const unbind = () => {
        if (scheduled) cancelAnimationFrame(scheduled);
        drag = null;
        element.classList.remove('dragging');
        element.removeEventListener('pointerdown', down);
        element.removeEventListener('pointermove', move);
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) element.removeEventListener(name, end);
        cleanup.delete(unbind);
      };
      cleanup.add(unbind);
      return unbind;
    }
    addEventListener('message', (event) => {
      const data = event.data || {};
      if (event.source !== parent || data.token !== TOKEN) return;
      if (data.type === 'ciweimao-plugin-host') {
        if (data.event === 'dispose') { dispose(); return; }
        if (data.event === 'theme') {
          /*
           * 插件文档内部也有 .12s/.15s 的颜色过渡。换主题时先压住，
           * 让新配色一步到位；两帧后恢复，插件的 hover 等交互过渡照常。
           */
          const root = document.documentElement;
          root.classList.add('is-theme-switching');
          root.dataset.theme = data.theme;
          const style = document.getElementById('plugin-host-theme');
          if (style) style.textContent = data.css || '';
          // 视觉样式已经落地，先回执让宿主恢复显示；插件的 JS 回调放在后面，
          // 免得一个耗时监听把浮层藏得更久。
          hostEvent('theme-applied', { theme: data.theme });
          emit('theme-changed', { theme: data.theme });
          requestAnimationFrame(() => requestAnimationFrame(() => {
            root.classList.remove('is-theme-switching');
          }));
          return;
        }
        if (data.event) { emit(data.event, data); return; }
        hostState = data;
        document.documentElement.dataset.ciweimaoEmbed = data.mode === 'floating' ? 'floating' : 'page';
        readyResolve(data);
        emit('floating-changed', data);
        window.dispatchEvent(new CustomEvent('ciweimao-plugin-embed-mode', { detail: data }));
        return;
      }
      if (data.type !== 'ciweimao-plugin-response') return;
      const item = waiting.get(data.id);
      if (!item) return;
      waiting.delete(data.id);
      clearTimeout(item.timer);
      if (data.ok) item.resolve(data.result);
      else item.reject(new Error(data.error || '插件请求失败'));
    });
    const api = {
      version: '1.3.0',
      ready,
      on,
      app: { info: () => request('app.info'), notify: (message) => request('app.notify', { message }) },
      editor: {
        getContext: () => request('editor.getContext'),
        setContent: (content) => request('editor.setContent', { content }),
        insertText: (text, position = 'selection') => request('editor.insertText', { text, position }),
      },
      stats: {
        get: () => request('stats.get'),
        refreshAuthorSubscriptions: () => request('stats.refreshAuthorSubscriptions', null, 300000),
      },
      ui: { setEditorStat: (item) => request('ui.setEditorStat', item) },
      theme: {
        list: () => request('theme.list'),
        get: () => request('theme.get'),
        apply: (themeId) => request('theme.apply', { themeId }),
        reset: () => request('theme.reset'),
        configure: (themeId, options) => request('theme.configure', { themeId, options }),
      },
      floating: {
        configure: (options) => request('floating.configure', options),
        setExpanded: (expanded) => request('floating.setExpanded', { expanded: !!expanded }),
        getState: () => hostState,
        onChange: (callback) => on('floating-changed', callback),
        bindDrag,
      },
      storage: {
        get: (key) => request('storage.get', { key }),
        set: (key, value) => request('storage.set', { key, value }),
      },
    };
    for (const name of ['app', 'editor', 'stats', 'ui', 'theme', 'floating', 'storage']) Object.freeze(api[name]);
    Object.defineProperty(window, 'PluginAPI', { value: Object.freeze(api), writable: false });
    addEventListener('pagehide', dispose, { once: true });
    setTimeout(() => hostEvent('ready', {}), 0);
  })();`;
}

/**
 * 给插件页面注入一段跟随主题的覆盖样式。
 *
 * 插件在自己的 iframe 里，拿不到主窗口的 CSS 变量，插件作者也普遍是写死颜色，
 * 所以这里把当前主题的关键色读出来，用 !important 覆盖掉那几处硬编码。
 * 只对内置插件调过的类名生效，第三方插件不受影响（它们本来也没引这些类）。
 */
function pluginThemeCss() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  const bg = pick('--bg', '#f8f3e7');
  const surface = pick('--surface', '#ffffff');
  const surface2 = pick('--surface-2', '#fffdf6');
  const surface3 = pick('--surface-3', '#fdf6e6');
  const border = pick('--border', '#f0e7d3');
  const borderStrong = pick('--border-strong', '#e2d4b6');
  const text = pick('--text', '#2b2620');
  const text2 = pick('--text-2', '#6e6555');
  const text3 = pick('--text-3', '#a79d89');
  const accent = pick('--accent', '#f9bf03');
  const accentInk = pick('--accent-ink', '#7a5600');
  const accentLine = pick('--accent-line', '#e0ac00');
  /*
   * color-scheme 必须跟随应用主题。
   *
   * 插件 iframe 是 sandbox 的 data: 文档，在 Electron 里走 OOPIF 合成；
   * 根元素写死 color-scheme: light 时，浏览器会给这个跨进程 iframe 铺一层
   * 白色基础背景 —— 浮层文档本身是透明的，于是深色模式下番茄钟周围出现
   * 一块刺眼的白底。改成 dark 后基础背景变成透明/深色，白块消失。
   */
  const colorScheme = (document.documentElement.dataset.theme || 'light') === 'dark'
    ? 'dark' : 'light';

  return `
    html { color-scheme: ${colorScheme}; }
    html.is-theme-switching *,
    html.is-theme-switching *::before,
    html.is-theme-switching *::after {
      transition: none !important;
      animation-duration: 0s !important;
    }
    body { background: ${bg} !important; color: ${text} !important; }
    header span, .summary span, .summary small, .panel-title p, .rule,
    .limit-note, .bar span, .book-row span, .empty { color: ${text3} !important; }
    .panel-title h2, h1, .book-row strong { color: ${text} !important; }
    button { background: ${surface} !important; color: ${text} !important; border-color: ${borderStrong} !important; }
    button:hover { border-color: ${accentLine} !important; }
    #save { background: ${accent} !important; border-color: ${accentLine} !important; color: ${accentInk} !important; }
    .summary article, .panel { background: ${surface} !important; border-color: ${border} !important; }
    .summary article.primary { background: ${surface2} !important; border-color: ${accentLine} !important; }
    .summary b { color: ${text} !important; }
    .panel-title > strong { background: ${surface3} !important; color: ${text2} !important; }
    .chart { border-bottom-color: ${borderStrong} !important;
      background: repeating-linear-gradient(to top, transparent 0, transparent 54px, ${border} 55px) !important; }
    .bar i { background: ${accent} !important; }
    .book-row { background: ${surface2} !important; }
    input, select { background: ${surface} !important; color: ${text} !important; border-color: ${borderStrong} !important; }
    html[data-ciweimao-embed="floating"], html[data-ciweimao-embed="floating"] body {
      background: transparent !important;
      overflow: hidden !important;
    }
    html[data-ciweimao-embed="floating"] #app {
      width: 100vw !important;
      height: 100vh !important;
      min-height: 0 !important;
      padding: 0 !important;
      background: transparent !important;
    }
  ` + (window.Theme && window.Theme.skinCss ? window.Theme.skinCss() : '');
}

function buildPluginDocument(bundle, token) {
  const page = String(bundle.page || '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  // 主题覆盖放在插件自带样式后面，靠 !important 压过硬编码
  const style = String(bundle.style || '').replace(/<\/style/gi, '<\\/style');
  const bridge = pluginBridgeSource(token).replace(/<\/script/gi, '<\\/script');
  const script = String(bundle.script || '').replace(/<\/script/gi, '<\\/script');
  const nonce = 'ciweimao-plugin';
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
    <meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style><style id="plugin-host-theme">${pluginThemeCss()}</style></head>
    <body>${page}<script nonce="${nonce}">${bridge}</script><script nonce="${nonce}">${script}</script></body></html>`;
}

async function openPlugin(id) {
  try {
    const floating = pluginFloatingRuntimes.get(id);
    if (floating) {
      floating.controller.setExpanded(true);
      sendPluginHostState(floating, { event: 'open', mode: 'floating' });
      return;
    }
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
    const frame = $('#pluginFrame');
    const runtime = activePluginRuntime;
    frame.addEventListener('load', () => {
      if (activePluginRuntime === runtime) sendPluginHostState(runtime, { mode: 'page' });
    }, { once: true });
    frame.src = `data:text/html;base64,${pluginUtf8Base64(documentText)}`;
  } catch (err) {
    // 原始错误长这样：Error invoking remote method 'plugins:get':
    //   Error: 缺少有效的 manifest.json —— 对用户毫无意义。
    // 它真正的含义是「这个功能的文件已经不在本机了」（目录被清掉 / 写坏），
    // 而内置功能可以靠「重新加载」自动补装，所以直接把出路说出来。
    const raw = String((err && err.message) || err);
    if (/manifest|不存在|ENOENT/i.test(raw)) {
      pluginNotice('这个功能的文件已经不在本机了。点「重新加载」，内置功能会自动补装回来。', true);
    } else {
      pluginNotice(`打开插件失败：${raw}`, true);
    }
  }
}

function closePlugin() {
  if (activePluginRuntime) sendPluginHostState(activePluginRuntime, { event: 'dispose', mode: 'page' });
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
    return { plugin: plugin.id, version: plugin.version, apiVersion: '1.3.0',
      capabilities: ['events', 'lifecycle', 'floating', 'themes', 'themeImages', 'themeStyles', 'themeBranding'],
      theme: document.documentElement.dataset.theme || 'light' };
  }
  if (method.startsWith('floating.')) {
    if (runtime.kind !== 'floating' || !runtime.controller) throw new Error('插件未声明常驻悬浮能力');
    if (method === 'floating.configure') return runtime.controller.configure(payload);
    if (method === 'floating.setExpanded') return runtime.controller.setExpanded(payload && payload.expanded);
  }
  if (method === 'app.notify') {
    const message = String((payload && payload.message) || '').slice(0, 160);
    if (runtime.kind === 'page') $('#pluginHostStatus').textContent = message;
    return true;
  }
  if (method === 'theme.get') return window.Theme.current();
  if (method === 'theme.list') return window.Theme.pluginThemes(plugin.id);
  if (method === 'theme.apply' || method === 'theme.reset' || method === 'theme.configure') {
    requirePluginPermission(plugin, 'ui.theme');
    if (runtime.kind !== 'page') throw new Error('请在插件页面主动切换主题');
    if (!pluginItems.some(item => item.id === plugin.id && item.enabled && !item.invalid)) {
      throw new Error('主题插件已停用');
    }
    if (method === 'theme.configure') {
      const id = String(payload.themeId || '');
      if (!window.Theme.pluginThemes(plugin.id).some(item => item.id === id)) throw new Error('只能设置本插件声明的主题');
      await window.api.plugins.configureTheme(plugin.id, id, payload.options);
      const result = await window.api.plugins.list();
      pluginItems = result.plugins || [];
      window.Theme.registerPlugins(pluginItems);
      renderPlugins();
      await window.Theme.whenSaved();
      return window.Theme.pluginThemes(plugin.id).find(item => item.id === id);
    }
    if (method === 'theme.apply') {
      const result = window.Theme.applyPlugin(plugin.id, String(payload.themeId || ''));
      await window.Theme.whenSaved();
      return result;
    }
    const selected = window.Theme.current().pluginTheme;
    if (selected && selected.pluginId !== plugin.id) throw new Error('只能恢复本插件应用的主题');
    const result = window.Theme.resetPlugin();
    await window.Theme.whenSaved();
    return result;
  }
  if (method === 'storage.get') return window.api.plugins.storageGet(plugin.id, payload && payload.key);
  if (method === 'storage.set') {
    const result = await window.api.plugins.storageSet(plugin.id, payload && payload.key, payload && payload.value);
    for (const candidate of [activePluginRuntime, ...pluginBackgroundRuntimes.values(), ...pluginFloatingRuntimes.values()]) {
      if (candidate && candidate !== runtime && candidate.plugin.id === plugin.id) {
        sendPluginHostState(candidate, { event: 'storage-changed', key: payload && payload.key });
      }
    }
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
    if (!(await writerFlushBeforeAction())) throw new Error('当前修改保存失败，已取消写入');
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
        platformBookId: String(book.platformBookId || ''),
      })),
      updatedAt: Math.max(writingStatsData.updatedAt || 0, savedOutputStatsData.updatedAt || 0),
      currentBookId: writerEditorBook ? String(writerEditorBook.bookId) : '',
      currentBookName: writerEditorBook ? String(writerEditorBook.name || '未命名作品') : '',
      currentChapterSavedWords: writerEditorBook && writerCurrentChapter()
        ? writerLastSavedChapterWords : 0,
    };
  }
  if (method === 'stats.refreshAuthorSubscriptions') {
    requirePluginPermission(plugin, 'stats.author');
    if (runtime.kind !== 'page') throw new Error('只有插件页面可以主动刷新作者后台统计');
    const oldStatus = $('#pluginHostStatus').textContent;
    try {
      const snap = await captureStatsSnapshot((progress) => {
        $('#pluginHostStatus').textContent = String((progress && progress.text) || '正在读取作者后台…');
      });
      const library = await window.api.writer.list();
      const localBooks = (library && library.books) || [];
      const resultBooks = window.Stats.mapAuthorBooksToLibrary(snap.books, localBooks);
      $('#pluginHostStatus').textContent = '作者后台统计已刷新';
      return { day: snap.day, capturedAt: snap.capturedAt, books: resultBooks };
    } catch (err) {
      $('#pluginHostStatus').textContent = oldStatus || '隔离运行中';
      throw err;
    }
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
      && data.token === activePluginRuntime.token) {
    runtime = activePluginRuntime;
  }
  if (!runtime) {
    for (const candidate of [...pluginBackgroundRuntimes.values(), ...pluginFloatingRuntimes.values()]) {
      // 仅对早期悬浮插件的布局消息兼容缺少 token 的格式，其他接口始终校验 token。
      const legacyLayout = candidate.kind === 'floating' && data.type === 'ciweimao-plugin-host-event'
        && data.token == null && ['popover', 'drag-start', 'drag-move', 'drag-end'].includes(data.event);
      if (event.source === candidate.frame.contentWindow && (data.token === candidate.token || legacyLayout)) {
        runtime = candidate;
        break;
      }
    }
  }
  if (!runtime || !['ciweimao-plugin-request', 'ciweimao-plugin-host-event'].includes(data.type)) return;
  const now = Date.now();
  if (now - runtime.messageStartedAt > 1000) {
    runtime.messageStartedAt = now;
    runtime.messageCount = 0;
  }
  runtime.messageCount += 1;
  if (runtime.messageCount > 240) return;
  if (data.type === 'ciweimao-plugin-host-event') {
    if (data.event === 'theme-applied') {
      if (runtime.themeSwitchTimer) {
        clearTimeout(runtime.themeSwitchTimer);
        runtime.themeSwitchTimer = null;
      }
      if (runtime.frame) runtime.frame.style.visibility = '';
      return;
    }
    if (data.event === 'ready') {
      if (runtime.controller) runtime.controller.render();
      else sendPluginHostState(runtime, { mode: 'page' });
    } else if (runtime.controller) runtime.controller.event(data);
    return;
  }
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
  const theme = e.target.closest('[data-plugin-theme]');
  if (theme) {
    try {
      window.Theme.applyPlugin(theme.dataset.themePlugin, theme.dataset.pluginTheme);
      await window.Theme.whenSaved();
      pluginNotice('已应用主题，选择已自动保存');
    } catch (err) {
      pluginNotice(err.message || String(err), true);
    }
    return;
  }
  const open = e.target.closest('[data-plugin-open]');
  if (open) { await openPlugin(open.dataset.pluginOpen); return; }
  const remove = e.target.closest('[data-plugin-remove]');
  if (!remove) return;
  const plugin = pluginItems.find((item) => item.id === remove.dataset.pluginRemove);
  if (!plugin) return;
  // 内置功能在卡片上就没有删除按钮，这里再兜一层：万一界面漏了也不该让主进程抛错
  if (plugin.builtin) {
    pluginNotice('内置功能不能删除，请在卡片右上角把它关掉', true);
    return;
  }
  if (!confirm(`确定删除扩展“${plugin.name}”吗？\n\n扩展自己的存储数据会保留。`)) return;
  try {
    await window.api.plugins.remove(plugin.id);
  } catch (err) {
    pluginNotice('删除失败：' + ipcError(err), true);
    return;
  }
  await loadPlugins();
});

$('#btnPluginFolder').addEventListener('click', () => window.api.plugins.openFolder());
$('#btnPluginReload').addEventListener('click', async () => {
  const btn = $('#btnPluginReload');
  btn.disabled = true;
  try {
    // 「重新加载」顺手做一次内置功能补装：
    // 内置功能没有单独的重装入口，plugins 目录一旦被清掉或写坏，
    // 用户除了重装整个软件没有别的办法。这一步让它自己能修回来。
    let restored = [];
    if (window.api.plugins && typeof window.api.plugins.repair === 'function') {
      const res = await window.api.plugins.repair();
      restored = (res && Array.isArray(res.installed)) ? res.installed : [];
    }
    for (const id of pluginFloatingRuntimes.keys()) disposeFloatingPlugin(id);
    await loadPlugins();
    if (restored.length) {
      const names = restored
        .map((id) => (pluginItems.find((p) => p.id === id) || {}).name || id)
        .join('、');
      pluginNotice(`已补装内置功能：${names}`);
    } else if (!pluginItems.length) {
      pluginNotice('没有可显示的功能。若是刚清过数据，请重启软件。', true);
    }
  } catch (err) {
    pluginNotice(`重新加载失败：${err.message || err}`, true);
  } finally {
    btn.disabled = false;
  }
});
$('#btnPluginImport').addEventListener('click', async () => {
  const result = await window.api.plugins.importZip();
  if (!result || result.canceled) return;
  if (!result.ok) { pluginNotice(`导入失败：${result.error}`, true); return; }
  pluginNotice(`扩展“${result.plugin.name}”导入成功`);
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

/* ------------------------------------------------------------ 数据管理（清除 / 恢复） */

/**
 * 「清除所有数据」的确认文案。
 *
 * 单独抽出来是为了能直接单测：这段话里必须把「清什么」「备份在哪」「会重启」
 * 三件事都写清楚——清库是不可逆操作，不能只写一句「确定吗」。
 */
function dataResetConfirm(config) {
  const scope = Array.isArray(config && config.scope) ? config.scope : [];
  return {
    badge: '危险操作',
    title: '清除所有数据并重启？',
    lead: '清完之后软件会像刚拿到手一样：没有作品、没有登录、没有偏好设置。'
      + '清除前会自动备份一份，万一清错了可以在「数据管理」里恢复。',
    steps: [
      '会被清除：' + scope.join('、'),
      `备份位置：${(config && config.backupRoot) || '本机数据备份目录'}`,
      '清除后立刻自动重启，无法取消',
    ],
    secondary: { label: '先不清除' },
    primary: { label: '清除并重启' },
  };
}

/** 恢复确认：说清楚「从哪一份恢复」「恢复范围」「当前状态也会被备份」 */
function dataRestoreConfirm(backup) {
  const when = backup && backup.createdAt
    ? new Date(backup.createdAt).toLocaleString('zh-CN')
    : '未知时间';
  return {
    badge: '恢复数据',
    title: '用这份备份覆盖当前数据？',
    lead: `选中的备份创建于 ${when}，共 ${(backup && backup.files) || 0} 个文件、${(backup && backup.sizeText) || '未知大小'}。`,
    steps: [
      '恢复范围：作品库、章节草稿、敏感词库、插件与设置、界面偏好、密码本',
      '当前的登录态不在备份里，恢复后需要重新登录作者后台',
      '恢复前会自动把现在的状态再备份一份，选错了能退回来',
      '恢复完成后自动重启',
    ],
    secondary: { label: '取消' },
    primary: { label: '恢复并重启' },
  };
}

let dataBackups = [];

function renderDataBackups() {
  const box = $('#dataBackupList');
  if (!box) return;
  if (!dataBackups.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const rows = dataBackups.map((b) => {
    const when = b.createdAt ? new Date(b.createdAt).toLocaleString('zh-CN') : '未知时间';
    const why = b.reason === 'before-reset' ? '清除前自动备份'
      : b.reason === 'restore-pre' ? '恢复前自动备份'
        : b.reason === 'manual' ? '手动备份' : '备份';
    return `
      <div class="data-backup-row" data-backup="${escapeHtml(b.name)}">
        <div class="data-backup-main">
          <div class="data-backup-when">${escapeHtml(when)}</div>
          <div class="data-backup-meta">${escapeHtml(why)} · ${b.files || 0} 个文件 · ${escapeHtml(b.sizeText || '')}</div>
        </div>
        <button class="btn ghost" data-backup-restore="${escapeHtml(b.name)}" type="button">恢复到这一份</button>
      </div>`;
  }).join('');
  box.innerHTML = `<div class="data-backup-title">本机备份（${dataBackups.length} 份，新的在前）</div>${rows}`;
}

async function refreshDataManage() {
  const rootEl = $('#dataBackupRoot');
  try {
    const res = await window.api.data.backups();
    dataBackups = res.backups || [];
    if (rootEl) rootEl.textContent = res.root || '—';
    renderDataBackups();
  } catch (err) {
    dataBackups = [];
    if (rootEl) rootEl.textContent = '读取失败：' + ipcError(err);
    renderDataBackups();
  }
}

/** 清除后重启。写进一个函数，方便以后改成「先提示再重启」而不动调用点 */
async function relaunchNow() {
  try { await window.api.app.relaunch(); } catch (_) { /* 主进程已经在退了 */ }
}

$('#btnBackupNow').addEventListener('click', async () => {
  const btn = $('#btnBackupNow');
  const hint = $('#dataManageHint');
  btn.disabled = true;
  try {
    const res = await window.api.data.backupNow();
    if (hint) {
      hint.hidden = false;
      hint.textContent = `已备份 ${res.files} 个文件（${res.sizeText}），备份名 ${res.name}`;
    }
    await refreshDataManage();
  } catch (err) {
    if (hint) { hint.hidden = false; hint.textContent = '备份失败：' + ipcError(err); }
  } finally {
    btn.disabled = false;
  }
});

$('#btnDataReset').addEventListener('click', async () => {
  const res = await window.api.data.backups().catch(() => ({ root: '' }));
  const cfg = dataResetConfirm({
    backupRoot: res.root,
    scope: [
      '作品库与章节草稿', '敏感词库', '插件与功能设置', '统计数据快照',
      '界面偏好', '密码本', '登录态',
    ],
  });
  // 这三个确认框都可能在内嵌页面开着时弹出，统一走 showBlockingDialog 处理遮挡
  await showBlockingDialog({
    ...cfg,
    primary: {
      label: cfg.primary.label,
      onClick: async () => {
        try {
          const res = await window.api.data.reset();
          // 部分文件被占用时照样重启：已经清掉的不可能回来，
          // 但要让用户知道哪一步没干净，别以为全清了。
          if (res && res.problem) {
            alert('清除基本完成，但有一处没清干净：\n\n' + res.problem
              + '\n\n备份已保留，可在「数据管理」里恢复。');
          }
          await relaunchNow();
        } catch (err) {
          alert('清除失败：' + ipcError(err));
        }
      },
    },
  });
});

$('#dataBackupList').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-backup-restore]');
  if (!btn) return;
  const name = btn.dataset.backupRestore;
  const backup = dataBackups.find((b) => b.name === name);
  if (!backup) return;
  const cfg = dataRestoreConfirm(backup);
  await showBlockingDialog({
    ...cfg,
    primary: {
      label: cfg.primary.label,
      onClick: async () => {
        try {
          await window.api.data.restore(name);
          await relaunchNow();
        } catch (err) {
          alert('恢复失败：' + ipcError(err));
        }
      },
    },
  });
});

/* ------------------------------------------------------------ 窗口行为 */

/**
 * 关闭按钮的行为偏好。
 *
 * 真值由主进程维护（写在 ui-prefs.json 里，close 事件要用），这里只负责
 * 读出来画选中态、把点击传回去。刻意不走 Prefs 模块：主进程首次关闭时也会
 * 写这个字段，两边各持一份缓存容易互相覆盖。
 */
function initCloseBehavior() {
  const box = $('#closeBehaviorSeg');
  const tag = $('#closeBehaviorTag');
  if (!box) return;

  const LABEL = { minimize: '最小化到托盘', quit: '直接退出' };
  const paint = (value) => {
    const v = value === 'quit' ? 'quit' : 'minimize';
    Array.prototype.forEach.call(box.children, (b) => {
      b.classList.toggle('is-active', b.dataset.closeBehavior === v);
    });
    if (tag) tag.textContent = LABEL[v];
  };

  // 桥接层缺方法时**不能让整个脚本崩在这里**。
  //
  // 之前 preload 里有两个重复的 app 键，后一个把前一个覆盖掉，`closeBehavior`
  // 变成 undefined。这一行原来直接 `window.api.app.closeBehavior.get()`，
  // 抛出的 TypeError 把 app.js 顶层后面的代码全部带走：
  //   深色模式绑定、右上角关闭询问、末尾的 boot() 都没执行，
  //   连 `let guideFallback` 都没初始化 —— 之后弹窗全抛 TDZ 错误。
  // 用户看到的就是「深色模式、关闭按钮、清除数据，点了都没反应」。
  //
  // 现在的写法：能读到就画选中态，读不到就按默认画，**点击绑定一定装上**。
  const behaviorApi = window.api && window.api.app && window.api.app.closeBehavior;

  if (behaviorApi && typeof behaviorApi.get === 'function') {
    behaviorApi.get()
      .then((r) => paint(r && r.value))
      .catch(() => paint('minimize'));
  } else {
    paint('minimize');
  }

  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-close-behavior]');
    if (!btn) return;
    try {
      const r = behaviorApi && typeof behaviorApi.set === 'function'
        ? await behaviorApi.set(btn.dataset.closeBehavior)
        : null;
      paint(r && r.value ? r.value : btn.dataset.closeBehavior);
    } catch (_) { /* 写不进去就保持原样，不画成没保存的状态 */ }
  });

  // 主进程首次询问后回推结果，让这里跟着变
  if (window.api.app.onCloseBehaviorChanged) {
    window.api.app.onCloseBehaviorChanged(paint);
  }
}

initCloseBehavior();

/**
 * 首次点关闭时的询问卡片。
 *
 * 主进程只发一个信号，这里用自己的 notice-card 问，样式跟主题走；
 * Esc 等同于「最小化到托盘」，和默认选项保持一致，避免误触直接退出。
 */
function initCloseAskDialog() {
  const box = $('#closeAskDialog');
  if (!box || !window.api.app.onAskCloseBehavior) return;

  const answer = (value) => {
    if (box.hidden) return;
    box.hidden = true;
    window.api.app.answerCloseBehavior(value);
  };

  $('#btnCloseAskMin').addEventListener('click', () => answer('minimize'));
  $('#btnCloseAskQuit').addEventListener('click', () => answer('quit'));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !box.hidden) {
      e.preventDefault();
      answer('minimize');
    }
  });

  window.api.app.onAskCloseBehavior(() => {
    box.hidden = false;
    setTimeout(() => {
      const btn = $('#btnCloseAskMin');
      if (btn) btn.focus();
    }, 30);
  });
}

initCloseAskDialog();

$('#btnStorageChoose').addEventListener('click', async () => {
  if (!(await writerFlushBeforeAction())) return;
  const result = await window.api.storage.choose();
  if (!result || result.canceled) return;
  writingStatsData = null;
  savedOutputStatsData = null;
  await refreshStoragePanel();
  writerEditorBook = null;  $('#writerEditor').hidden = true;
  $('#writerLibrary').hidden = false;
  await loadWriterBooks();
});
$('#btnStorageReset').addEventListener('click', async () => {
  if (!confirm('恢复系统默认保存位置？旧目录里的文件会保留，不会被删除。')) return;
  if (!(await writerFlushBeforeAction())) return;
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

// 码字台工具栏：一键深色 + 旁边那枚配色切换（暗金 / 暗蓝）
$('#btnWriterDark').addEventListener('click', () => window.Theme.toggle());
$('#btnWriterDarkTone').addEventListener('click', () => {
  const t = window.Theme;
  // 浅色下点这枚按钮，多半是想看深蓝黑长什么样：先切深色再换配色，
  // 否则点了没有任何视觉变化，看着像没反应
  if (t.current().pluginTheme || t.effective(t.mode()) !== 'dark') t.set('dark');
  t.toggleDarkTone();
});

$('#darkToneSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-dark-tone]');
  if (!btn) return;
  window.Theme.setDarkTone(btn.dataset.darkTone);
});

$('#pluginThemeSelect').addEventListener('change', async (event) => {
  const value = event.target.value;
  try {
    if (!value) window.Theme.resetPlugin();
    else {
      const [pluginId, themeId] = value.split('/');
      window.Theme.applyPlugin(pluginId, themeId);
    }
    await window.Theme.whenSaved();
  }
  catch (err) { pluginNotice(err.message || String(err), true); }
});
$('#btnPluginThemeReset').addEventListener('click', () => window.Theme.resetPlugin());
document.addEventListener('theme-changed', () => renderPlugins());
document.addEventListener('theme-save-failed', () => pluginNotice('主题已显示，但保存失败，请检查数据目录后重新选择主题。', true));

// 折线图的颜色取自 CSS 变量，换主题后得重画一次
document.addEventListener('theme-changed', () => {
  const snap = currentSnapshot();
  if (!snap || !boardBookId) return;
  const b = (snap.books || []).find((x) => String(x.bookId) === boardBookId);
  if (b) renderBookChart(b);
});

/** 上一次推给插件的明暗档；只有明暗真正变化时才需要临时藏浮层 */
let pluginColorScheme = (document.documentElement.dataset.theme || 'light') === 'dark'
  ? 'dark' : 'light';

// 主题通过事件同步，不重载 iframe，保留计时器、拖动位置和插件界面状态。
document.addEventListener('theme-changed', () => {
  const css = pluginThemeCss();
  const theme = document.documentElement.dataset.theme || 'light';
  const nextScheme = theme === 'dark' ? 'dark' : 'light';
  const schemeChanged = nextScheme !== pluginColorScheme;
  pluginColorScheme = nextScheme;
  for (const runtime of [activePluginRuntime, ...pluginBackgroundRuntimes.values(), ...pluginFloatingRuntimes.values()]) {
    if (!runtime) continue;
    /*
     * 浮层 iframe 是 sandbox 的 data: 文档，主题消息跨进程，注定比主界面
     * 晚一拍。这一拍里 iframe 还按旧主题铺底：深色→浅色会留一块深色方块。
     * 先把它藏起来，等插件回执 theme-applied 再显示；期间露出的是已经
     * 换好主题的主界面，不会出现颜色对不上的方块。
     *
     * 只有明暗档真正变化（light/pink ↔ dark）才需要藏：浅色与粉白之间、
     * 深黄黑与深蓝黑之间的底色一致，藏一下反而多一次眨眼。
     */
    if (schemeChanged && runtime.kind === 'floating' && runtime.frame) {
      runtime.frame.style.visibility = 'hidden';
      if (runtime.themeSwitchTimer) clearTimeout(runtime.themeSwitchTimer);
      runtime.themeSwitchTimer = setTimeout(() => {
        runtime.themeSwitchTimer = null;
        if (runtime.frame) runtime.frame.style.visibility = '';
      }, 250);
    }
    sendPluginHostState(runtime, { event: 'theme', css, theme });
  }
});

document.addEventListener('view-changed', (event) => {
  for (const runtime of pluginFloatingRuntimes.values()) {
    sendPluginHostState(runtime, { event: 'view-changed', view: event.detail.name });
  }
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
    // 开场引导排在声明之后，否则两张卡片会叠在一起
    if (startGuidePending) {
      startGuidePending = false;
      setTimeout(maybeShowStartGuide, 260);
    }
  }, 180);
}

$('#btnFreeNoticeOk').addEventListener('click', () => closeFreeNotice(true));
$('#btnShowFreeNotice').addEventListener('click', () => openFreeNotice());

// Esc 等同「已看过」，免得有人习惯性按掉之后每次启动都再弹
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeFreeNotice(true);
  closeGuideDialog(true);
});

// ------------------------------------------------------------ 首次使用引导
//
// 两次引导共用一张卡片：刚打开软件时告诉用户「先登录」，登录成功后再告诉「去抓评论」。
// 都只出现一次，写进 ui-prefs.json。
//
// 注意：登录成功那次，平台页面是原生视图、压在所有 DOM 之上，弹窗会被整个盖住，
// 所以先把视图从窗口上摘下来（页面本身不销毁），关掉弹窗再挂回去。

/** 声明卡片还开着的时候先别弹，两张卡片叠一起很难看 */
let startGuidePending = false;
/** Esc 关弹窗时补跑的「次要动作」（比如把后台页面挂回去） */
let guideFallback = null;
/** 关闭引导弹窗后的收尾回调（用于挂回临时摘下的内嵌页面） */
let guideAfterClose = null;

function showGuideDialog(cfg) {
  $('#guideBadge').textContent = cfg.badge || '第一次使用';
  $('#guideTitle').textContent = cfg.title || '';
  $('#guideLead').textContent = cfg.lead || '';
  $('#guideSteps').innerHTML = (cfg.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');

  // Esc 关掉时按「次要按钮」处理：登录那次要把后台页面挂回去，
  // 否则用户一按 Esc 就莫名其妙回到了概览
  guideFallback = cfg.onDismiss || (cfg.secondary && cfg.secondary.onClick) || null;
  guideAfterClose = typeof cfg.afterClose === 'function' ? cfg.afterClose : null;

  const box = $('#guideActions');
  box.innerHTML = '';
  if (cfg.secondary) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost';
    btn.textContent = cfg.secondary.label;
    btn.addEventListener('click', () => {
      closeGuideDialog();
      if (typeof cfg.secondary.onClick === 'function') cfg.secondary.onClick();
    });
    box.appendChild(btn);
  }
  if (cfg.primary) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.textContent = cfg.primary.label;
    btn.addEventListener('click', () => {
      closeGuideDialog();
      if (typeof cfg.primary.onClick === 'function') cfg.primary.onClick();
    });
    box.appendChild(btn);
  }
  $('#guideDialog').hidden = false;
  const first = box.querySelector('.btn.primary') || box.querySelector('.btn');
  if (first) first.focus();
}

function closeGuideDialog(runFallback) {
  const el = $('#guideDialog');
  if (!el || el.hidden) return;
  el.hidden = true;
  const fn = guideFallback;
  guideFallback = null;
  if (runFallback && typeof fn === 'function') fn();
  // 关闭后收尾（目前用于把临时摘下的内嵌页面挂回去）
  const after = guideAfterClose;
  guideAfterClose = null;
  if (typeof after === 'function') {
    try { after(); } catch (_) { /* 收尾失败不该影响界面 */ }
  }
}

/**
 * 显示一个「需要用户看清再说」的确认弹窗，并处理内嵌页面遮挡。
 *
 * 为什么需要这一层：作者后台 / 喵语数据是 WebContentsView，画在渲染页面**之上**，
 * 普通 DOM 弹窗会被它整个盖住——用户既看不到文案也点不到按钮。
 * 更新确认框已经踩过这个坑（v1.0.6 修的就是它），这次新增的
 * 「是否继承旧数据」「清除所有数据」「恢复数据」三个确认框是同一类场景，
 * 所以复用更新器挂出来的 prepareUpdateOverlay / restoreUpdateOverlay：
 * 弹窗前把页面摘下来，关掉后原样挂回去（保留页面与表单状态，不重新导航）。
 */
async function showBlockingDialog(cfg) {
  let detached = false;
  if (typeof window.prepareUpdateOverlay === 'function') {
    try {
      detached = !!(await window.prepareUpdateOverlay());
    } catch (_) {
      // 摘取失败也要让弹窗出来，否则用户彻底没法操作
      detached = false;
    }
  }
  showGuideDialog({
    ...cfg,
    afterClose: () => {
      if (detached && typeof window.restoreUpdateOverlay === 'function') {
        void window.restoreUpdateOverlay();
      }
    },
  });
}

/** 第一次打开软件（还没连过后台）→ 告诉用户先登录 */
function maybeShowStartGuide() {
  if (window.Prefs && window.Prefs.get('guideStartShown', false)) return;
  if (browserOpen || lastState.url) return;
  if (!$('#guideDialog').hidden) return;
  if (window.Prefs) window.Prefs.set('guideStartShown', true);
  showGuideDialog({
    badge: '第一次使用',
    title: '先连上作者后台',
    lead: '软件的数据都从你的作者后台读出来。登录一次就够了，登录态会留在浏览器里，通常几周内不用再登。',
    steps: [
      '点下面「打开作者后台」，在弹出的页面里完成登录（滑块验证码要自己点）',
      '登录成功后回到「抓取与同步」',
      '先点「读取作品列表」，再点「开始抓取」',
    ],
    secondary: { label: '先自己看看' },
    primary: { label: '打开作者后台', onClick: () => openBrowser() },
  });
}

/** 是不是作者后台的地址（喵语数据是另一个域，不该触发登录引导） */
function isAuthorUrl(url) {
  return /^https:\/\/author\.ciweimao\.com\//i.test(String(url || ''));
}

/** 第一次连上后台（真的登录成功）→ 告诉用户下一步去抓评论 */
function maybeShowAfterLoginGuide(state) {
  if (!state || state.isLoginPage || !state.url) return;
  // 还在加载中：等它停下来再说，否则可能在重定向前就误判
  if (state.isLoading) return;
  // 必须已经在作者后台里
  if (!isAuthorUrl(state.url)) return;
  // 必须真的经历过「登录页 → 后台」这一步。
  // 只是打开了后台首页不等于登录成功。
  if (!loginJustSucceeded) return;

  if (window.Prefs && window.Prefs.get('guideAfterLoginShown', false)) return;
  if (!$('#freeNotice').hidden || !$('#guideDialog').hidden) return;
  if (window.Prefs) window.Prefs.set('guideAfterLoginShown', true);
  loginJustSucceeded = false;

  // 平台视图压在 DOM 之上，弹窗会被整个盖住，所以先退回本地界面（页面不销毁，
  // 选「先看看后台」会原样挂回去），这样弹窗背后是正常界面而不是一片空白
  closeBrowser().catch(() => {});

  showGuideDialog({
    badge: '登录成功',
    title: '接下来抓一次评论',
    lead: '现在能读你的作者后台了。抓一次评论，「评论审查」和「数据看板」才会有内容。',
    steps: [
      '去「抓取与同步」点「读取作品列表」',
      '勾选作品后点「开始抓取」，等进度条走完',
      '抓完到「数据看板」点一次「刷新数据」，字数与订阅才会更新',
    ],
    secondary: { label: '先看看后台', onClick: () => { showBrowserKeepPage(); } },
    primary: {
      label: '去抓取与同步',
      onClick: () => { closeBrowser(); setActiveView('sync'); },
    },
  });
}


// ------------------------------------------------------------ 启动自检

(async function boot() {
  setActiveView('overview');

  // 主题与偏好：theme-init.js 已完成首帧上色，这里只做运行时同步
  try {
    if (window.Prefs) await window.Prefs.ready();
    writerTypoIgnoredWords = new Set(
      (window.Prefs && window.Prefs.get('typoIgnoredWords', [])) || [],
    );
    reviewStrict = !!(window.Prefs && window.Prefs.get('reviewStrict', false));
    renderReviewStrict();
    await window.Theme.boot();
    // 侧边栏顺序依赖已加载的偏好，必须在 Prefs.ready() 之后应用，
    // 否则首屏会先按 HTML 里的默认顺序闪一下再跳到用户排好的顺序
    initNavCustom();
  } catch (_) { /* ignore */ }

  try {
    reviewConfig = normalizeReviewConfig(await window.api.data.read('review-settings.json'));
  } catch (_) { reviewConfig = normalizeReviewConfig({}); }
  renderReviewSettings();

  try {
    const stored = await window.api.data.read('reader-history.json');
    if (stored && stored.readers) readerHistory = stored;
  } catch (_) { readerHistory = { version: 1, readers: {} }; }
  try {
    const stored = await window.api.data.read('reader-watchlist.json');
    readerWatchlist = stored && Array.isArray(stored.items) ? stored.items : [];
  } catch (_) { readerWatchlist = []; }

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
  await refreshDataManage();
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
  // 优先级要先查到再画看板：否则开机直接进「数据看板」时，
  // 手里没有书目也没有缓存，默认定位不到优先级作品
  await refreshPriorityInfo();
  renderBoard();
  await loadPropsSnapshots();

  try {
    const rs = await window.api.data.read('rank-history.json');
    if (rs && Array.isArray(rs.records)) rankRecords = rs.records;
  } catch (_) { rankRecords = []; }
  renderRank();

  const state = await window.api.browser.state();
  if (state && state.ready) renderConn(state);

  // 码字区：恢复上次的字体/字号/行距/宽度，并把敏感词库读进来待用
  applyWriterDisplay();
  await loadWriterBadwordWords();

  // 开场引导放最后：等偏好、书目、状态都读完，用户点按钮过去才不会是空页面。
  // 声明卡片还开着就先挂着，关掉之后由 closeFreeNotice 接上。
  if ($('#freeNotice').hidden) setTimeout(maybeShowStartGuide, 700);
  else startGuidePending = true;

  // 版本变化询问排在引导之后：先让用户看到声明/引导，再问数据继承，
  // 两个弹层抢同一个位置会互相盖住。声明卡片可能一直开着，所以这里轮询等它关。
  scheduleInheritAsk(0);
})();

/** 等声明/引导卡片关掉再问版本继承，最多等 30 秒（20 次 × 1.5s） */
function scheduleInheritAsk(attempt) {
  if ($('#guideDialog').hidden && $('#freeNotice').hidden) {
    maybeAskInheritData();
    return;
  }
  if (attempt >= 20) return;
  setTimeout(() => scheduleInheritAsk(attempt + 1), 1500);
}

/**
 * 手动装了新版本时问一句「要不要接着用旧数据」。
 *
 * 只在主进程判定为 manual-update 时才问；软件自己装的更新（auto-update）
 * 与首次运行（first-run）都由主进程直接返回 ask=false，不打扰用户。
 *
 * 「继承」= 什么都不做：数据本来就在磁盘上，新版本读的是同一个目录。
 * 「不继承」= 先备份再清空，然后重启，等于用新版本从零开始。
 */
async function maybeAskInheritData() {
  if (!window.api.version || !$('#guideDialog').hidden || !$('#freeNotice').hidden) return;
  let info;
  try { info = await window.api.version.change(); } catch (_) { return; }
  if (!info || !info.ask) return;

  const dirText = info.direction === 'down' ? '降级' : '升级';
  await showBlockingDialog({
    badge: `版本${dirText}`,
    title: '要不要接着用旧版本的数据？',
    lead: `检测到版本从 ${info.from || '（未知）'} 变到 ${info.to}，看起来是你自己下载安装的。`
      + '如果你的作品、敏感词库和设置都在原来那台电脑的这个软件里，选「继承」就能直接用。',
    steps: [
      '继承：作品库、章节草稿、敏感词库、密码本、偏好全部保留，行为与升级前一样',
      '不继承：先自动备份一份，再清空全部数据并从空白开始，适合想重测完整流程',
      '两种情况都不会动你导出到磁盘上的 TXT 文件',
    ],
    secondary: {
      label: '不继承，从空白开始',
      onClick: async () => {
        try {
          await window.api.version.resetData();
          await relaunchNow();
        } catch (err) {
          alert('清除旧数据失败：' + ipcError(err));
        }
      },
    },
    primary: { label: '继承旧数据' },
  });
}
