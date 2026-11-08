'use strict';

/**
 * 侧边栏顺序的自定义逻辑
 *
 * 只做数据，不碰 DOM：排序/删除规则全在这里，界面只负责画。
 * 这么拆的原因很实际——侧边栏一旦排错，用户进不去「设置」就再也改不回来了，
 * 所以「哪些项绝对不能删」必须是一条能被测试卡住的硬规则。
 *
 * 硬规则：
 * 1. **设置项永远不能删**。它是唯一的恢复入口，删了就只能去改配置文件。
 * 2. 顺序里出现未知 view 时丢弃（旧版本的残留不会让界面错乱）。
 * 3. 顺序里缺失的已知项不自动补到末尾——缺失就是被用户删掉了。
 * 4. 恢复默认时回到 DEFAULT_NAV 的完整列表。
 */
(function (root) {

/** 设置项不能删：删了就再也进不去设置，无法恢复 */
const LOCKED = ['settings'];

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
  // 设置项丢了就补回来：这是用户唯一的恢复入口，不能因为一次错误写入就永久丢失
  if (!seen.has('settings')) out.push('settings');
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
    return { order: list, removed: false, reason: '设置项不能删除，它是恢复侧边栏的唯一入口' };
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