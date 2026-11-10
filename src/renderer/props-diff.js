'use strict';

(function (root) {

/**
 * 道具获得的指标定义与差值计算
 *
 * **指标必须与作者后台「统计中心 → 道具获得」一一对应，顺序也照抄平台**：
 *   总推荐票 → 总月票 → 总打赏 → 总刀片
 *
 * 之前我按猜测写过五项（多一个「宝箱」、把打赏拆成「各类打赏」），
 * 实际后台只有这四项，多出来的那项永远读不到、只会显示「—」误导用户。
 * 以后再加指标，先去后台确认页面上真有这个数字。
 *
 * 差值规则没变：昨天没抓到 → diff 为 null（显示「—」），不能显示 ±0，
 * 否则用户会以为「今天一个都没收到」。
 */

/** 顺序即展示顺序，跟着平台走 */
const ITEMS = [
  { key: 'recommend', label: '总推荐票', short: '推荐票', hint: '读者投的推荐票' },
  { key: 'monthly', label: '总月票', short: '月票', hint: '当月月票' },
  { key: 'reward', label: '总打赏', short: '打赏', hint: '打赏折算的金额或笔数，以平台显示为准' },
  { key: 'blade', label: '总刀片', short: '刀片', hint: '催更刀片' },
];

function keys() {
  return ITEMS.map((x) => x.key);
}

/** 数值归一：非数字、负数、NaN 一律当「没有数据」 */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** 把任意输入清洗成只含已知指标的对象 */
function normalizeItems(raw) {
  const out = {};
  for (const key of keys()) {
    out[key] = num(raw && raw[key]);
  }
  return out;
}

/**
 * 与前一天对比。
 * @param {object|null} prev 前一天同作品快照的 items
 * @param {object|null} cur  当天快照的 items
 * @returns {Array<{key,label,short,hint,value,diff,tone}>}
 *   value 为 null 表示今天没抓到这项；diff 为 null 表示没有可比数据
 *   tone: up（比昨天多）| down（少）| flat（持平）| none（无数据）
 */
function diffAgainst(prev, cur) {
  const p = prev ? normalizeItems(prev) : null;
  const c = normalizeItems(cur);
  return ITEMS.map((item) => {
    const value = c[item.key];
    let diff = null;
    if (value !== null && p && p[item.key] !== null) diff = value - p[item.key];
    let tone = 'none';
    if (diff !== null) tone = diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat');
    return { ...item, value, diff, tone };
  });
}

/** 差值显示文案：带正负号，没有可比数据用破折号 */
function diffText(diff) {
  if (diff === null || diff === undefined) return '—';
  if (diff === 0) return '±0';
  return diff > 0 ? `+${diff}` : String(diff);
}

/** YYYY-MM-DD 减一天；输入不合法时返回空串 */
function previousDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() - 1);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 取某一天的快照。同一统计日抓了多次时取最后一次 */
function findDay(list, day, bookId) {
  const want = String(bookId || '');
  // 没有指定作品时不能退化成「任意一本」：道具数据是按书存的，
  // 随便挑一本会把别的书的数字显示到当前区块上。宁可没有数据。
  if (!want) return null;
  let found = null;
  for (const s of (Array.isArray(list) ? list : [])) {
    if (!s || s.day !== day) continue;
    if (String(s.bookId || '') !== want) continue;
    if (!found || String(s.capturedAt || '') >= String(found.capturedAt || '')) found = s;
  }
  return found;
}

/**
 * 找前一天的快照（同一本书）。
 */
function findPrevious(list, today, bookId) {
  const target = previousDay(today);
  if (!target) return null;
  return findDay(list, target, bookId);
}

/**
 * 把一次抓取结果并入快照列表。
 *
 * 一天一本只留最新一次：同一统计日抓十次不该攒出十条。
 */
function mergeSnapshot(list, snapshot) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const idx = arr.findIndex((s) => s && s.day === snapshot.day
    && String(s.bookId || '') === String(snapshot.bookId || ''));
  if (idx >= 0) arr[idx] = snapshot;
  else arr.push(snapshot);
  arr.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return arr;
}

/**
 * 取出某本书在最近 N 天的快照，按日期升序，用于画趋势。
 *
 * 只补「有数据的那几天」，不补零：平台在没收到道具的日子本来就不产生记录，
 * 硬补 0 会把折线拉出一条假的谷底。
 *
 * @param {Array} list 全部快照
 * @param {string} bookId
 * @param {{days:number, today:string}} opts  days=0 表示按月（取全部）
 */
function seriesFor(list, bookId, opts) {
  const want = String(bookId || '');
  // 没有指定作品时不能把几本书的快照混成一条趋势线
  if (!want) return [];
  const days = Number((opts && opts.days) || 0);
  const today = String((opts && opts.today) || '');
  const rows = (Array.isArray(list) ? list : [])
    .filter((s) => s && String(s.bookId || '') === want)
    .slice()
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));

  let picked = rows;
  if (days > 0 && today) {
    const from = shiftDay(today, -(days - 1));
    picked = rows.filter((s) => String(s.day) >= from && String(s.day) <= today);
  }
  return picked;
}

/** 日期加减天数 */
function shiftDay(day, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + Number(delta || 0));
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

  const api = {
    ITEMS,
    keys,
    normalizeItems,
    diffAgainst,
    diffText,
    previousDay,
    findDay,
    findPrevious,
    mergeSnapshot,
    seriesFor,
    shiftDay,
  };

  // 双模式导出：Node 里 require 得到对象，页面里挂到 window.PropsDiff。
  // 整个文件必须包在 IIFE 里 —— 页面里所有 <script> 共享同一个全局作用域，
  // 顶层的 `const api` 会和别的模块撞名，浏览器直接抛 SyntaxError 让整个文件不执行。
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PropsDiff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
