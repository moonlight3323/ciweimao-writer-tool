'use strict';

/**
 * 作品优先级（封面上的星标）
 *
 * 一个星标同时驱动两处：创作中心排第一、数据看板默认显示这一本。
 * 规则集中在这里，改的时候只改一处，两边不会各算各的。
 *
 * 三条规则：
 * 1. 只有本地书能点亮。远程书没有本地归档，数据看板里也没有它的统计，
 *    点亮了反而会跳到一个空页面。
 * 2. 多本同时点亮时，**最近点亮的优先**（pinnedAt 倒序）。
 * 3. 「创作中心排第一」不要求有 platformBookId；但「数据看板默认显示它」要求有，
 *    否则快照里对不上号。所以两个用途分开取。
 */

/** 能否点亮（界面据此决定要不要画星标） */
function canPin(book) {
  return !!book && book.source !== 'remote';
}

/**
 * 按优先级排好的列表：点亮在前，组内最近点亮的在前。
 * 不修改入参。
 */
function sortByPriority(books) {
  const list = Array.isArray(books) ? books.slice() : [];
  return list.sort((a, b) => {
    const pa = !!(a && a.pinned) && canPin(a);
    const pb = !!(b && b.pinned) && canPin(b);
    if (pa !== pb) return pa ? -1 : 1;
    if (pa && pb) {
      const ta = Number(a.pinnedAt) || 0;
      const tb = Number(b.pinnedAt) || 0;
      if (ta !== tb) return tb - ta;
    }
    return 0;
  });
}

/**
 * 优先级最高的那一本。
 * @param {Array} books
 * @param {{requirePlatform?:boolean}} opts requirePlatform=true 时只考虑
 *        带 platformBookId 的书（数据看板要用）
 * @returns {object|null}
 */
function pickPriority(books, opts) {
  const requirePlatform = !!(opts && opts.requirePlatform);
  const list = (Array.isArray(books) ? books : []).filter((b) => {
    if (!b || !b.pinned || !canPin(b)) return false;
    if (requirePlatform && !String(b.platformBookId || '').trim()) return false;
    return true;
  });
  if (!list.length) return null;
  return list.sort((a, b) => (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0))[0];
}

/** 数据看板要定位到的平台书号；没有就返回空串 */
function boardBookIdOf(books) {
  const book = pickPriority(books, { requirePlatform: true });
  return book ? String(book.platformBookId) : '';
}

/**
 * 数据看板的书籍列表排序：优先级作品提到第一位，其余保持原顺序。
 *
 * 为什么不复用 sortByPriority：看板里没有「点亮」这个概念，它只是展示列表；
 * 用户看到的顺序应当稳定 —— 除优先级那一本被提到最前，其他不该因为
 * 有无 pinnedAt 而抖动。
 */
function sortForBoard(books, priorityId) {
  const list = Array.isArray(books) ? books.slice() : [];
  const want = String(priorityId || '').trim();
  if (!want) return list;
  const idx = list.findIndex((b) => String(b && b.bookId) === want);
  if (idx <= 0) return list;
  const [hit] = list.splice(idx, 1);
  list.unshift(hit);
  return list;
}

/**
 * 数据看板「查看范围」最终该选哪一本。
 *
 * 三种情况要考虑清楚，否则就会出现「设置了优先级，看板却维持原样」：
 *   1. 当前选中的书在这一天的快照里不存在（换了日期 / 那本书还没数据）→ 退回全部作品
 *   2. 用户亲手选过（touched）→ 尊重用户，不再被星标抢回去
 *   3. 用户没选过 → 用优先级作品；优先级不在当天列表里就保持全部作品
 *
 * @returns {{id:string, fellBack:boolean}}
 */
function resolveBoardBookId(o) {
  const opt = o || {};
  const list = (Array.isArray(opt.available) ? opt.available : []).map(String);
  const current = String(opt.current || '');
  const fellBack = !!current && !list.includes(current);

  if (current && !fellBack) return { id: current, fellBack: false };

  if (!opt.touched) {
    const priority = String(opt.priority || '');
    if (priority && list.includes(priority)) return { id: priority, fellBack: false };
  }
  return { id: '', fellBack };
}

/**
 * 把书目分成「优先级作品」与「其他作品」两组。
 *
 * 抽出来的原因很实际：这段筛选一旦写错，界面就会显示「优先级作品 0」——
 * 用户在界面上点了星标、磁盘上也确实写进去了，但列表还是一片「其他作品」。
 * 命令行环境起不了 GUI 时，只能靠这条纯函数盯着。
 *
 * 注意：远程书即使被标了 pinned 也只能留在「其他作品」里——
 * 它没有本地归档，放进优先级栏点进去是空的。
 */
function partition(books) {
  const list = Array.isArray(books) ? books : [];
  const priority = sortByPriority(list.filter((b) => !!b && !!b.pinned && canPin(b)));
  const picked = new Set(priority.map((b) => b && b.bookId));
  const other = list.filter((b) => !picked.has(b && b.bookId));
  return { priority, other };
}

const api = {
  canPin,
  sortByPriority,
  pickPriority,
  boardBookIdOf,
  sortForBoard,
  resolveBoardBookId,
  partition,
};

if (typeof module === 'object' && module.exports) module.exports = api;
else globalThis.BookPriority = api;
