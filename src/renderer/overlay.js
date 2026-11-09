'use strict';

/**
 * 摸鱼浮层的前端。
 *
 * 只做四件事：把主进程推来的正文铺进 textarea、按输入节奏回推、
 * 显示字数、提供「藏起来 / 回到软件 / 调外观」三个动作。
 *
 * 回推是 120ms 防抖的：逐字推会让码字台那边的整段替换 + 错别字扫描变成每键一次。
 * 但「藏起来 / 回到软件 / 失焦」都先 flush 一次，避免最后几个字留在浮层里没过去。
 */

const $ = (id) => document.getElementById(id);
// 变量名不带 api：主界面里 window.api 是 preload 挂的不可配置属性，
// 顶层再声明一个同名 const 会 SyntaxError（book-priority.js 就栽在这上面）
const bridge = window.overlayApi;

const editor = $('editor');
const panel = $('panel');

const LIMITS = {
  fontSize: [12, 48],
  lineHeight: [1.2, 2.6],
  bgAlpha: [0, 60],
};

const SIZE_WIDTHS = { small: 560, medium: 680, large: 880 };

let settings = {
  fontSize: 20,
  lineHeight: 1.9,
  textColor: '#FFFFFF',
  outline: true,
  bgAlpha: 0,
  bgColor: '#14121A',
  width: 680,
  height: 320,
};

let hotkey = '';
/** 正在等用户按下新组合 */
let capturing = false;
let captureTimer = null;
let pushTimer = null;
let composing = false;

function countWords(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgba(hex, alpha) {
  const raw = String(hex || '#000000').replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`;
}

function updateCount() {
  $('countText').textContent = `${formatNumber(countWords(editor.value))} 字`;
}

/** 把设置铺到 CSS 变量与面板控件上（主进程存完会回推一份，那里是唯一真相） */
/**
 * 正文字体族，来自码字台的「字体」设置（随 open 传进来）。
 * 只跟随字体，不跟随字号/行距 —— 那两项浮层自己有自己的默认值（更大、更松）。
 * 空值就撤掉变量，退回样式里的兜底（微软雅黑）。
 */
function applyFont(stack) {
  const value = String(stack || '').trim();
  const root = document.documentElement.style;
  if (value) root.setProperty('--font', value);
  else root.removeProperty('--font');
}

function applySettings(raw) {
  if (raw && typeof raw === 'object') settings = { ...settings, ...raw };
  const root = document.documentElement.style;
  root.setProperty('--fs', `${settings.fontSize}px`);
  root.setProperty('--lh', String(settings.lineHeight));
  root.setProperty('--ink', settings.textColor);
  root.setProperty('--pad-tint', hexToRgba(settings.bgColor, (Number(settings.bgAlpha) || 0) / 100));
  document.body.classList.toggle('has-outline', !!settings.outline);

  $('fsValue').textContent = String(settings.fontSize);
  $('lhValue').textContent = Number(settings.lineHeight).toFixed(1);
  $('bgAlpha').value = String(settings.bgAlpha);
  $('bgAlphaValue').textContent = `${settings.bgAlpha}%`;
  $('outlineToggle').checked = !!settings.outline;

  const ink = String(settings.textColor || '').toUpperCase();
  document.querySelectorAll('.sw').forEach((el) => {
    el.classList.toggle('is-on', String(el.dataset.color || '').toUpperCase() === ink);
  });

  const width = Number(settings.width) || 0;
  const preset = Object.keys(SIZE_WIDTHS).find((key) => SIZE_WIDTHS[key] === width) || 'medium';
  document.querySelectorAll('.sz').forEach((el) => {
    el.classList.toggle('is-on', el.dataset.size === preset);
  });

  renderHotkey();
}

/** accelerator 给人看：CommandOrControl 太长，界面上写 Ctrl */
function formatCombo(combo) {
  return String(combo || '')
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/Super/g, 'Win');
}

/**
 * 把「生效的组合 / 用户设的组合」画到面板上。
 *
 * 两件事必须让用户看得出来：
 *   1. 现在真正按哪个键能叫回来（active）；
 *   2. 他自己设的那个是不是被别的软件占了（wanted !== active 时标黄）。
 */
function renderHotkey() {
  const btn = $('btnHotkey');
  const active = formatCombo(hotkey);
  const wanted = formatCombo((settings && settings.hotkey) || '');
  const fallback = !!wanted && wanted !== active;

  btn.classList.toggle('is-capture', capturing);
  btn.classList.toggle('is-warn', !capturing && fallback);
  btn.title = fallback
    ? `你设的 ${wanted} 被别的软件占用，现在用 ${active};点一下可以重设`
    : '点一下，然后按下想用的组合（字母、数字或 F1–F24，至少带一个修饰键）';

  if (capturing) {
    btn.textContent = '按下组合…';
  } else if (!active) {
    btn.textContent = wanted ? `${wanted} 被占用` : '—';
  } else if (fallback) {
    btn.textContent = `${wanted} → ${active}`;
  } else {
    btn.textContent = active;
  }

  let text;
  if (!active) {
    text = '候选组合都被别的软件占用了，用把手上的 ◑，或者在浮层里左键和右键同时按，都能藏起来。';
  } else if (fallback) {
    text = `${wanted} 被别的软件占着，现在用的是 ${active}；点上面的格子可以换一个。`;
  } else {
    text = `藏起来后按 ${active} 叫回来，浮层里左键和右键同时按也行；点上面的格子可以换。`;
  }
  $('hotkeyTip').textContent = text;

  $('btnHide').title = active ? `隐藏浮层（${active} 叫回来）` : '隐藏浮层';
}

// ---------------------------------------------------------------- 快捷键捕获

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight',
]);

/** 主键只认字母 / 数字 / F1–F24，与主进程 normaliseAccelerator 的白名单对齐 */
function mainKeyFromEvent(e) {
  const code = String(e.code || '');
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return '';
}

function comboFromEvent(e) {
  if (MODIFIER_CODES.has(String(e.code || ''))) return '';
  const main = mainKeyFromEvent(e);
  if (!main) return '';
  const mods = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length) return '';
  return `${mods.join('+')}+${main}`;
}

function stopCapture() {
  capturing = false;
  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }
  renderHotkey();
}

function startCapture() {
  capturing = true;
  renderHotkey();
  if (captureTimer) clearTimeout(captureTimer);
  // 10 秒没按就当放弃：卡在捕获态里连字都打不了，比设不成更烦人
  captureTimer = setTimeout(stopCapture, 10000);
}

document.addEventListener('keydown', (e) => {
  if (!capturing) return;
  e.preventDefault();
  // 必须 stopImmediatePropagation：下面还有个「Esc 藏起来」的监听挂在同一个
  // document 上，stopPropagation 拦不住同一节点上的其它监听。
  e.stopImmediatePropagation();
  if (e.key === 'Escape') {
    stopCapture();
    return;
  }
  const combo = comboFromEvent(e);
  if (!combo) return;          // 只按了修饰键，继续等主键
  stopCapture();
  bridge.settings({ hotkey: combo });
}, true);

window.addEventListener('blur', () => { if (capturing) stopCapture(); });

// ---------------------------------------------------------------- 回推正文

function pushNow() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  bridge.input(editor.value);
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 120);
}

editor.addEventListener('input', () => {
  updateCount();
  schedulePush();
});

editor.addEventListener('compositionstart', () => { composing = true; });
editor.addEventListener('compositionend', () => {
  composing = false;
  updateCount();
  pushNow();          // 输入法上屏后立刻推一次，不等防抖
});

window.addEventListener('blur', () => { if (!composing) pushNow(); });
window.addEventListener('beforeunload', () => { pushNow(); });

// ---------------------------------------------------------------- 拖动浮层

/**
 * 拖动是**自己算**的，不靠 -webkit-app-region: drag。
 *
 * 那个属性由系统接管鼠标：页面收不到 mousedown，光标也改不成十字箭头，
 * 而且在透明无边框窗口上时灵时不灵（用户反馈过根本拖不动）。
 * 现在只做两件事：按下时告诉主进程「开始跟光标」，松开时「停」；
 * 位移由主进程每 16ms 采一次系统光标算出来 —— 渲染层不用管 mousemove，
 * 光标移出窗口也不会断。
 */
const handleEl = $('handle');
let dragging = false;

handleEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // 按在按钮上是「点按钮」，不能顺手把窗口拖走
  if (e.target.closest('.hbtn')) return;
  if (dragging) return;
  e.preventDefault();       // 别让浏览器开始选字，否则拖动会拖出一片蓝色
  dragging = true;
  handleEl.classList.add('is-dragging');
  bridge.dragStart();
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  handleEl.classList.remove('is-dragging');
  bridge.dragEnd();
}

function hideAndPush() {
  pushNow();
  endDrag();
  bridge.hide();
}

document.addEventListener('mouseup', (e) => { if (e.button === 0) endDrag(); });
// 被 Alt+Tab 抢走焦点时 mouseup 收不到：兜底停掉，否则窗口会一直黏着光标
window.addEventListener('blur', endDrag);

// ---------------------------------------------------------------- 交互

$('btnHide').addEventListener('click', hideAndPush);

$('btnRestore').addEventListener('click', () => {
  pushNow();
  endDrag();
  bridge.restore();
});

$('btnSettings').addEventListener('click', () => {
  panel.hidden = !panel.hidden;
  if (panel.hidden && capturing) stopCapture();
});

$('btnPanelClose').addEventListener('click', () => {
  panel.hidden = true;
  if (capturing) stopCapture();
});

$('btnHotkey').addEventListener('click', () => {
  if (capturing) stopCapture();
  else startCapture();
});

$('btnHotkeyReset').addEventListener('click', () => {
  if (capturing) stopCapture();
  bridge.settings({ hotkey: '' });
});

$('fsDown').addEventListener('click', () => changeSetting('fontSize', -1, LIMITS.fontSize, 1));
$('fsUp').addEventListener('click', () => changeSetting('fontSize', 1, LIMITS.fontSize, 1));
$('lhDown').addEventListener('click', () => changeSetting('lineHeight', -0.1, LIMITS.lineHeight, 0.1));
$('lhUp').addEventListener('click', () => changeSetting('lineHeight', 0.1, LIMITS.lineHeight, 0.1));

function changeSetting(key, delta, range, decimals) {
  const cur = Number(settings[key]) || range[0];
  const next = Math.round(clamp(cur + delta, range[0], range[1]) * 10) / 10;
  if (next === cur) return;
  settings = { ...settings, [key]: next };
  applySettings();
  bridge.settings({ [key]: next });
}

$('swatches').addEventListener('click', (e) => {
  const sw = e.target.closest('.sw');
  if (!sw) return;
  applySettings({ textColor: sw.dataset.color });
  bridge.settings({ textColor: sw.dataset.color });
});

$('outlineToggle').addEventListener('change', (e) => {
  applySettings({ outline: e.target.checked });
  bridge.settings({ outline: e.target.checked });
});

$('bgAlpha').addEventListener('input', (e) => {
  const value = clamp(Number(e.target.value) || 0, LIMITS.bgAlpha[0], LIMITS.bgAlpha[1]);
  // 拖动时只在本地生效，松手才落盘，免得每一格都写一次配置
  applySettings({ bgAlpha: value });
});

$('bgAlpha').addEventListener('change', (e) => {
  const value = clamp(Number(e.target.value) || 0, LIMITS.bgAlpha[0], LIMITS.bgAlpha[1]);
  bridge.settings({ bgAlpha: value });
});

$('sizes').addEventListener('click', (e) => {
  const btn = e.target.closest('.sz');
  if (!btn) return;
  bridge.settings({ size: btn.dataset.size });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (!panel.hidden) { panel.hidden = true; return; }
  hideAndPush();
});

// 左键 + 右键同时按下 → 藏起来。
// e.buttons 是按位或：左 1、右 2，两键都按着就是 3；先按哪一只手都一样。
// 把手上的左键会开始拖动，接着按右键就先把拖动停掉再藏，别让窗口黏在光标上。
document.addEventListener('mousedown', (e) => {
  if (e.buttons !== 3) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (capturing) stopCapture();
  hideAndPush();
}, true);

// 浮层里没有需要右键菜单的地方，不拦掉的话设快捷键时会弹出系统菜单
document.addEventListener('contextmenu', (e) => e.preventDefault());

// 点面板外面收起：浮层本身很小，点到编辑区就是「继续写」
document.addEventListener('mousedown', (e) => {
  if (panel.hidden) return;
  if (panel.contains(e.target) || e.target.closest('#btnSettings')) return;
  panel.hidden = true;
  if (capturing) stopCapture();
});

// ---------------------------------------------------------------- 主进程推送

bridge.onInit((payload) => {
  if (!payload) return;
  applySettings(payload.settings);
  applyFont(payload.font);
  hotkey = payload.hotkey || '';
  renderHotkey();

  const title = payload.title || payload.bookName || '';
  $('chapterName').textContent = title || '摸鱼码字';
  $('chapterName').title = [payload.bookName, payload.title].filter(Boolean).join(' · ');

  editor.value = typeof payload.text === 'string' ? payload.text : '';
  updateCount();
  // 等一帧再聚焦：刚 show 出来的窗口立刻 focus 偶尔会被系统吞掉
  requestAnimationFrame(() => {
    editor.focus();
    const end = editor.value.length;
    editor.setSelectionRange(end, end);
    editor.scrollTop = editor.scrollHeight;
    pushNow();
  });
});

bridge.onSettings((next) => applySettings(next));
bridge.onHotkey((payload) => {
  // 主进程推的是 { combo, wanted, ok }；早期版本推过裸字符串，两种都接
  hotkey = payload && typeof payload === 'object' ? String(payload.combo || '') : String(payload || '');
  if (capturing) {
    capturing = false;
    if (captureTimer) {
      clearTimeout(captureTimer);
      captureTimer = null;
    }
  }
  renderHotkey();
});
