'use strict';

/**
 * 摸鱼码字的设置与快捷键选择。
 *
 * 单独一个文件是为了能被 node:test 直接 require：主进程模块要 require('electron')，
 * 在测试环境里拿不到 app / BrowserWindow，把纯逻辑抽出来才测得到。
 *
 * 观感参数只保留「用户真的会调」的几项：字号、行高、字色、描边、底色透明度、
 * 浮层尺寸与位置。其余（字体、字距）写死在样式里，少一个旋钮少一处出错。
 */

/** 默认值。x / y 为 null 表示还没摆过，按鼠标所在屏居中 */
const DEFAULTS = {
  fontSize: 20,
  lineHeight: 1.9,
  textColor: '#FFFFFF',
  outline: true,
  bgAlpha: 0,
  bgColor: '#14121A',
  width: 680,
  height: 320,
  x: null,
  y: null,
  hotkey: '',
};

const LIMITS = {
  fontSize: [12, 48],
  lineHeight: [1.2, 2.6],
  bgAlpha: [0, 60],
  width: [360, 1400],
  height: [120, 900],
};

/**
 * 快捷键降级链。
 *
 * 全局热键只能独占，被别人注册过的组合会直接失败（本机实测 F12 类组合经常
 * 已经被录屏/游戏工具占着），所以必须准备一条链，逐个试到能注册为止。
 */
const HOTKEYS = [
  'CommandOrControl+Alt+M',
  'CommandOrControl+Shift+M',
  'CommandOrControl+Alt+F9',
  'CommandOrControl+Shift+F9',
];

/**
 * 自定义热键允许的修饰键写法。
 * 用户在界面上是按出来的，但配置文件可能被手改，所以两种来源都要过一遍这里。
 */
const MOD_ALIASES = {
  ctrl: 'CommandOrControl',
  control: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  commandorcontrol: 'CommandOrControl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  win: 'Super',
  cmd: 'Super',
  command: 'Super',
};

/** 输出顺序固定，避免 Ctrl+Shift+K 和 Shift+Ctrl+K 被当成两个键 */
const MOD_ORDER = ['CommandOrControl', 'Alt', 'Shift', 'Super'];

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function normaliseColor(value, fallback) {
  return COLOR_RE.test(String(value || '')) ? String(value).toUpperCase() : fallback;
}

/**
 * 字体族字符串（例如 `"Microsoft YaHei", "Noto Serif SC", sans-serif`）。
 *
 * 来源是码字台的「字体」设置，本来就是我们自己拼的值，但配置文件可能被手改，
 * 而它最终会通过 CSS 变量进入浮层页面 —— 所以花括号、分号、尖括号一律剔掉，
 * 免得一个字符串把后面的样式全吃掉。
 */
function normaliseFontStack(value) {
  const raw = String(value || '').replace(/[{};<>\\\u0000-\u001f]/g, '').trim();
  return raw.slice(0, 160);
}

/**
 * 主键只放行「字母 / 数字 / F1–F24」。
 *
 * 不是偷懒：全局热键会把整台机器的这个键吃掉。允许 Space、Enter、Esc、Tab
 * 当主键，等于把用户所有程序里的这些键一起废掉——那是很不讲理的行为，
 * 所以这里直接不给过，宁可让用户改组合。
 */
function normaliseMainKey(raw) {
  const s = String(raw || '').trim();
  if (/^[a-zA-Z]$/.test(s)) return s.toUpperCase();
  if (/^[0-9]$/.test(s)) return s;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(s)) return s.toUpperCase();
  return '';
}

/**
 * 把用户给的组合串收敛成 Electron 认的 accelerator；不合法返回空串。
 *
 * 至少一个修饰键 + 一个主键。单键（哪怕合法）一律不收——见 normaliseMainKey。
 */
function normaliseAccelerator(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = raw.split('+').map((p) => p.trim());
  // 空片段说明写法有问题（Ctrl++M、Ctrl+），别自作聪明替人补
  if (parts.some((part) => !part)) return '';
  if (parts.length < 2) return '';
  const main = normaliseMainKey(parts[parts.length - 1]);
  if (!main) return '';
  const mods = new Set();
  for (const part of parts.slice(0, -1)) {
    const mod = MOD_ALIASES[part.toLowerCase()];
    if (!mod) return '';
    mods.add(mod);
  }
  if (!mods.size) return '';
  return [...MOD_ORDER.filter((m) => mods.has(m)), main].join('+');
}

/**
 * 注册顺序：用户自定义的组合排在最前面，失败再走内置降级链。
 * 自定义和内置重合时去重，免得同一个键注册两次。
 */
function hotkeyCandidates(custom) {
  const want = normaliseAccelerator(custom);
  const list = want ? [want, ...HOTKEYS] : [...HOTKEYS];
  return list.filter((combo, index) => list.indexOf(combo) === index);
}

/**
 * 把磁盘上/来自界面的设置收敛成一份可信的值。
 *
 * 用户可能手改配置文件、旧版本可能留下多余的键，这里一律重算：
 * 数值夹到区间内、颜色不是 #RRGGBB 就退回默认、多余字段直接丢掉。
 */
function normaliseSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fontSize = Math.round(clampNumber(src.fontSize, LIMITS.fontSize[0], LIMITS.fontSize[1],
    DEFAULTS.fontSize));
  const width = Math.round(clampNumber(src.width, LIMITS.width[0], LIMITS.width[1], DEFAULTS.width));
  const height = Math.round(clampNumber(src.height, LIMITS.height[0], LIMITS.height[1],
    DEFAULTS.height));
  const x = Number.isFinite(Number(src.x)) && src.x !== null ? Math.round(Number(src.x)) : null;
  const y = Number.isFinite(Number(src.y)) && src.y !== null ? Math.round(Number(src.y)) : null;

  return {
    fontSize,
    lineHeight: round2(clampNumber(src.lineHeight, LIMITS.lineHeight[0], LIMITS.lineHeight[1],
      DEFAULTS.lineHeight)),
    textColor: normaliseColor(src.textColor, DEFAULTS.textColor),
    outline: src.outline === undefined ? DEFAULTS.outline : !!src.outline,
    bgAlpha: Math.round(clampNumber(src.bgAlpha, LIMITS.bgAlpha[0], LIMITS.bgAlpha[1],
      DEFAULTS.bgAlpha)),
    bgColor: normaliseColor(src.bgColor, DEFAULTS.bgColor),
    width,
    height,
    x,
    y,
    hotkey: normaliseAccelerator(src.hotkey),
  };
}

/**
 * 依次尝试注册，返回第一个成功的组合；全都失败返回空串。
 *
 * `tryRegister` 由调用方提供（真实环境是 globalShortcut.register），
 * 抛异常也按失败处理 —— 有些平台在参数不合法时是抛错而不是返回 false。
 */
function pickHotkey(candidates, tryRegister) {
  for (const combo of candidates || []) {
    if (!combo) continue;
    try {
      if (tryRegister(combo)) return combo;
    } catch (_) { /* 这个组合不可用，试下一个 */ }
  }
  return '';
}

module.exports = {
  DEFAULTS,
  LIMITS,
  HOTKEYS,
  normaliseSettings,
  normaliseAccelerator,
  normaliseFontStack,
  hotkeyCandidates,
  pickHotkey,
};
