'use strict';

/**
 * 统计快照层
 *
 * 核心：刺猬猫以「每日 6:00 到次日 6:00」为一个结算日（后台统计中心有官方说明）。
 * 因此本工具的「统计日」也以 6 点为分界：6 点之前抓到的数据，归属于前一天。
 *
 * 指标来源：
 *   字数 / 收藏      ← /book_manage/view_list
 *   新增订阅 / 均订 / 总订阅 / 日均追订 ← /money_manage/view_buy_new
 *   本月更新 / 全勤  ← /homepage
 */
(function (root) {
  const ORIGIN = 'https://author.ciweimao.com';
  const STAT_HOUR = 6;
  const NAV_DELAY = 520;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const p2 = (n) => String(n).padStart(2, '0');

  /** 统计日：6 点前算前一天，返回 YYYY-MM-DD */
  function statDay(date) {
    const d = new Date(date || Date.now());
    if (d.getHours() < STAT_HOUR) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }

  /** 当前是否已过当日 6 点（用于判断今天的数据是否该更新） */
  function isAfterBoundary(date) {
    const d = new Date(date || Date.now());
    return d.getHours() >= STAT_HOUR;
  }

  /** 距离下一个 6 点边界的毫秒数 */
  function msUntilNextBoundary(date) {
    const d = new Date(date || Date.now());
    const next = new Date(d);
    next.setHours(STAT_HOUR, 0, 0, 0);
    if (next.getTime() <= d.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - d.getTime();
  }

  async function callAdapter(fnName, args) {
    const src = window.CiweimaoAdapter.pageSource(fnName, args);
    return await window.api.browser.evalInPage(src);
  }

  async function goto(url) {
    await window.api.browser.goto(url);
    await window.api.browser.waitIdle(20000);
    await sleep(700);
    const where = await window.api.browser.evalInPage('location.href');
    if (/\/login/i.test(where || '')) throw new Error('登录态已失效，请重新登录作者后台');
    return where;
  }

  /**
   * 采集一次全量快照。
   * @param {Object} opts { onProgress }
   */
  async function captureSnapshot(opts) {
    const o = opts || {};
    const emit = o.onProgress || function () {};

    // 1) 作品列表：字数 + 收藏
    emit({ phase: 'books', text: '读取作品字数与收藏…' });
    await goto(`${ORIGIN}/book_manage/view_list`);
    const bookStats = await callAdapter('extractBookStats') || [];

    // 2) 首页：本月更新 / 全勤
    emit({ phase: 'home', text: '读取更新与全勤…' });
    await goto(`${ORIGIN}/homepage`);
    const homeStats = await callAdapter('extractHomeStats') || [];
    const homeByName = new Map(homeStats.map((h) => [h.name, h]));

    // 3) 逐本读取订阅
    const books = [];
    for (let i = 0; i < bookStats.length; i += 1) {
      const b = bookStats[i];
      emit({ phase: 'subscribe', text: `读取订阅 ${i + 1}/${bookStats.length}：${b.name}`, index: i + 1, total: bookStats.length });
      let sub = {};
      try {
        await goto(`${ORIGIN}/money_manage/view_buy_new?book_id=${b.bookId}`);
        sub = (await callAdapter('extractSubscribeStats')) || {};
      } catch (err) {
        sub = { error: String(err.message || err) };
      }
      const home = homeByName.get(b.name) || {};
      books.push({
        bookId: b.bookId,
        name: b.name,
        status: b.status || '',
        words: b.words,
        collects: b.collects,
        newSubs: sub.newSubs ?? null,
        newSubsPct: sub.newSubsPct ?? null,
        avgSubs: sub.avgSubs ?? null,
        avgSubsPct: sub.avgSubsPct ?? null,
        totalSubs: sub.totalSubs ?? null,
        dailyChase: sub.dailyChase ?? null,
        dailyChasePct: sub.dailyChasePct ?? null,
        maxSub: sub.maxSub ?? null,
        maxSubChapter: sub.maxSubChapter || '',
        monthWords: home.monthWords || '',
        monthWordsNum: home.monthWordsNum ?? null,
        updateDays: home.updateDays ?? null,
        fullDays: home.fullDays || '',
        missDays: home.missDays ?? null,
      });
      await sleep(NAV_DELAY);
    }

    const totals = {
      words: books.reduce((s, x) => s + (x.words || 0), 0),
      collects: books.reduce((s, x) => s + (x.collects || 0), 0),
      totalSubs: books.reduce((s, x) => s + (x.totalSubs || 0), 0),
      newSubs: books.reduce((s, x) => s + (x.newSubs || 0), 0),
    };

    return {
      day: statDay(),
      capturedAt: new Date().toISOString(),
      books,
      totals,
    };
  }

  /** 找出某统计日之前最近的一条快照 */
  function previousSnapshot(snapshots, day) {
    const prior = (snapshots || []).filter((s) => s.day < day).sort((a, b) => (a.day < b.day ? 1 : -1));
    return prior[0] || null;
  }

  /** 用上一份快照给当前快照补上差值 */
  function annotateDiff(current, previous) {
    const prevMap = new Map(((previous && previous.books) || []).map((b) => [b.bookId, b]));
    const books = current.books.map((b) => {
      const p = prevMap.get(b.bookId);
      const d = { words: null, collects: null, totalSubs: null };
      if (p) {
        if (b.words != null && p.words != null) d.words = b.words - p.words;
        if (b.collects != null && p.collects != null) d.collects = b.collects - p.collects;
        if (b.totalSubs != null && p.totalSubs != null) d.totalSubs = b.totalSubs - p.totalSubs;
      }
      return Object.assign({}, b, { diff: d });
    });
    const totals = Object.assign({}, current.totals);
    if (previous && previous.totals) {
      totals.diffWords = current.totals.words - (previous.totals.words || 0);
      totals.diffCollects = current.totals.collects - (previous.totals.collects || 0);
      totals.diffTotalSubs = current.totals.totalSubs - (previous.totals.totalSubs || 0);
    }
    return Object.assign({}, current, { books, totals, comparedWith: previous ? previous.day : null });
  }

  /**
   * 按作品裁剪一份已完成差值标注的快照。
   * bookId 为空时返回原样（全部作品合计）。
   * 单书视图下 totals 必须按该书重算，否则汇总卡仍显示全书合计，会与卡片内容矛盾。
   */
  function scopeSnapshot(annotated, bookId) {
    if (!annotated || !bookId) return annotated;

    const books = (annotated.books || []).filter((b) => String(b.bookId) === String(bookId));
    const b = books[0];

    if (!b) {
      return Object.assign({}, annotated, {
        books: [],
        totals: { words: null, collects: null, totalSubs: null, newSubs: null, scopedMissing: true },
      });
    }

    const totals = {
      words: b.words ?? null,
      collects: b.collects ?? null,
      totalSubs: b.totalSubs ?? null,
      newSubs: b.newSubs ?? null,
      diffWords: b.diff ? b.diff.words : null,
      diffCollects: b.diff ? b.diff.collects : null,
      diffTotalSubs: b.diff ? b.diff.totalSubs : null,
      scoped: true,
      bookName: b.name,
    };

    return Object.assign({}, annotated, { books, totals, scopedBookId: b.bookId });
  }

  /** 把新快照并入历史（同日覆盖），返回新数组 */
  function mergeSnapshot(snapshots, snap) {
    const list = (snapshots || []).filter((s) => s.day !== snap.day);
    list.push(snap);
    list.sort((a, b) => (a.day < b.day ? -1 : 1));
    return list;
  }

  const api = {
    STAT_HOUR,
    statDay,
    isAfterBoundary,
    msUntilNextBoundary,
    captureSnapshot,
    previousSnapshot,
    annotateDiff,
    scopeSnapshot,
    mergeSnapshot,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Stats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
