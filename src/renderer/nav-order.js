'use strict';

/**
 * 侧边栏顺序的自定义逻辑
 *
 * 只做数据，不碰 DOM：排序/删除规则全在这里，界面只负责画。
 * 这么拆的原因很实际——侧边栏一旦排错，用户进不去「设置」就再也改不回来了，
 * 所以「哪些项绝对不能删」必须是一条能被测试卡住的硬规则。
 *
 * 硬规则：
 * 1. **固定项不能删**，但**可以随意上下移动**。锁定的是「删除」，不是「排序」。
 * 2. 顺序里出现未知 view 时丢弃（旧版本的残留不会让界面错乱）。
 * 3. 顺序里缺失的已知项不自动补到末尾——缺失就是被用户删掉了。
 * 4. 恢复默认时回到 DEFAULT_NAV 的完整列表。
 */
(function (root) {

/**
 * 固定项：不显示删除按钮，也不能被移除。
 *
 * 挑的都是「删掉之后软件就不完整」的入口：
 *   overview  概览    —— 首屏，删了打开软件是空白页
 *   books     数据看板 —— 核心功能之一
 *   sync      抓取与同步 —— 所有数据的来源，删了就再也抓不了
 *   plugins   功能中心 —— 唯一的功能开关入口
 *   settings  设置    —— 恢复侧边栏的唯一入口
 *
 * **它们仍然可以上下移动**：排序规则和别的项完全一样，
 * 只是 `remove()` 会拒绝。用户的要求就是「关掉删除按钮，但排序照旧生效」。
 */
const LOCKED = ['overview', 'books', 'sync', 'plugins', 'settings'];

/** 默认顺序与显示名（改名时只改这里，DOM 文案由它覆盖） */
const DEFAULT_NAV = [
  { view: 'overview', label: '概览' },
  { view: 'writer', label: '创作中心' },
  { view: 'writing-stats', label: '码字统计' },
  { view: 'reviews', label: '评论审查' },
  { view: 'books', label: '数据看板' },
  { view: 'export', label: '章节导出' },
  { view: 'rank', label: '平台榜单' },
  { view: 'miaoyu', label: '喵语数据' },
  { view: 'sync', label: '抓取与同步' },
  { view: 'plugins', label: '功能中心' },
  { view: 'settings', label: '设置' },
];

function knownViews() {
  return DEFAULT_NAV.map((x) => x.view);
}

function labelOf(view) {
  const found = DEFAULT_NAV.find((x) => x.view === view);
  return found ? found.label : String(view || '');
}

function isLocked(view) {
  return LOCKED.includes(view);
}

/**
 * 把任意输入清洗成合法顺序。
 * @param {unknown} input 存进 ui-prefs 的数组
 * @returns {string[]} view 名数组
 */
function normalize(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const view = typeof raw === 'string' ? raw : (raw && raw.view);
    if (!view || typeof view !== 'string') continue;
    if (!knownViews().includes(view)) continue;
    if (seen.has(view)) continue;
    seen.add(view);
    out.push(view);
  }
  // **固定项丢了就补回来。**
  // 它们本身不能被用户删除（remove 会拒绝），所以「不在顺序里」只可能是：
  // 老版本存下的数据、配置文件被手改过、或者某次写入出错。
  // 无论哪种，让它们永久消失都是错的 —— 尤其「设置」是唯一的恢复入口。
  // 补在末尾而不是原位：用户当前的排列不动，只是把丢的那几项找回来。
  for (const view of LOCKED) {
    if (!seen.has(view)) {
      out.push(view);
      seen.add(view);
    }
  }
  return out;
}

/** 默认顺序（返回新数组，调用方改它不会污染常量） */
function defaultOrder() {
  return DEFAULT_NAV.map((x) => x.view);
}

/**
 * 上移 / 下移。
 * @param {string[]} order 当前顺序
 * @param {string} view 目标
 * @param {number} delta -1 上移，1 下移
 */
function move(order, view, delta) {
  const list = normalize(order);
  const from = list.indexOf(view);
  if (from < 0) return list;
  const to = from + (delta < 0 ? -1 : 1);
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  next[from] = list[to];
  next[to] = list[from];
  return next;
}

/**
 * 删除一项。锁定的项删不掉——原样返回。
 * @returns {{order:string[], removed:boolean, reason?:string}}
 */
function remove(order, view) {
  const list = normalize(order);
  if (isLocked(view)) {
    return {
      order: list,
      removed: false,
      reason: '「' + labelOf(view) + '」是固定项，不能从侧边栏移除（但可以拖动顺序）',
    };
  }
  const next = list.filter((x) => x !== view);
  if (next.length === list.length) return { order: list, removed: false, reason: '这一项已经不在侧边栏里' };
  return { order: next, removed: true };
}

/** 加回被删掉的项：追加到末尾（设置之前），保证用户能找到它 */
function restore(order, view) {
  const list = normalize(order);
  if (list.includes(view)) return list;
  if (!knownViews().includes(view)) return list;
  const at = list.indexOf('settings');
  const next = list.slice();
  if (at >= 0) next.splice(at, 0, view);
  else next.push(view);
  return next;
}

/** 侧边栏里被删掉的项（用于界面上的「已隐藏」区） */
function hiddenOf(order) {
  const list = normalize(order);
  return knownViews().filter((v) => !list.includes(v));
}

const api = {
  LOCKED,
  DEFAULT_NAV,
  knownViews,
  labelOf,
  isLocked,
  normalize,
  defaultOrder,
  move,
  remove,
  restore,
  hiddenOf,
};

if (typeof module === 'object' && module.exports) module.exports = api;
else root.NavOrder = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);