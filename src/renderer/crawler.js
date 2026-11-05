'use strict';

/**
 * 抓取器：通过内嵌浏览器的同源上下文，逐页读取作者后台的间贴（段评）。
 *
 * 所有请求都发生在平台页面自身，天然携带登录态；
 * 本模块只做 GET 式页面访问与 DOM 提取，不提交任何表单。
 */
(function (root) {
  const ORIGIN = 'https://author.ciweimao.com';
  const PAGE_DELAY = 520;
  const NAV_TIMEOUT = 20000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 在平台页面上下文执行适配层的某个方法 */
  async function callAdapter(fnName, args) {
    // 用适配层打包好的源码，别自己拼 toString：辅助函数会丢
    const code = window.CiweimaoAdapter.pageSource(fnName, args);
    return await window.api.browser.evalInPage(code);
  }

  async function goto(url) {
    await window.api.browser.goto(url);
    await window.api.browser.waitIdle(NAV_TIMEOUT);
    await sleep(600);
    const where = await window.api.browser.evalInPage('location.href');
    if (/\/login/i.test(where || '')) {
      throw new Error('登录态已失效，请重新登录作者后台');
    }
    return where;
  }

  function tsukkomiUrl(bookId, page) {
    if (!page || page === 1) {
      return `${ORIGIN}/review_manage/manage_tsukkomi?book_id=${bookId}`;
    }
    return `${ORIGIN}/review_manage/manage_tsukkomi?&page=${page}&book_id=${bookId}&chapter_id=0&search_type=1&content=`;
  }

  /**
   * 抓取指定书籍的全部间贴。
   * @param {Object} opts { bookIds:[], maxPages:number, onProgress:fn, shouldStop:fn }
   */
  async function crawlTsukkomi(opts) {
    const o = opts || {};
    const bookIds = o.bookIds || [];
    const maxPages = o.maxPages || 999;
    const emit = o.onProgress || function () {};
    const stopped = o.shouldStop || function () { return false; };

    const collected = [];
    const seen = new Set();
    const bookMeta = [];

    for (let bi = 0; bi < bookIds.length; bi += 1) {
      const bookId = bookIds[bi];
      if (stopped()) break;

      emit({ phase: 'book-start', bookIndex: bi + 1, bookTotal: bookIds.length, bookId });

      await goto(tsukkomiUrl(bookId, 1));
      const opts2 = await callAdapter('extractBookOptions');
      const meta = (opts2 || []).find((x) => x.bookId === bookId) || { bookId, name: bookId };
      const pager = await callAdapter('extractPager');
      const totalPages = Math.min(pager.total || 1, maxPages);

      emit({ phase: 'book-info', bookIndex: bi + 1, bookTotal: bookIds.length, bookName: meta.name, pages: totalPages });

      let count = 0;
      for (let p = 1; p <= totalPages; p += 1) {
        if (stopped()) break;
        if (p > 1) {
          await goto(tsukkomiUrl(bookId, p));
        }
        const rows = await callAdapter('extractTsukkomi');
        for (const r of rows) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          r.bookId = r.bookId || bookId;
          r.bookName = r.bookName || meta.name;
          collected.push(r);
          count += 1;
        }
        emit({
          phase: 'page',
          bookIndex: bi + 1,
          bookTotal: bookIds.length,
          bookName: meta.name,
          page: p,
          pages: totalPages,
          bookCount: count,
          total: collected.length,
        });
        if (p < totalPages) await sleep(PAGE_DELAY);
      }

      bookMeta.push({ bookId, name: meta.name, pages: totalPages, count });
    }

    return {
      syncedAt: new Date().toISOString(),
      books: bookMeta,
      items: collected,
    };
  }

  /** 只读取书籍清单（快） */
  async function listBooks() {
    await goto(`${ORIGIN}/review_manage/manage_tsukkomi`);
    const opts = await callAdapter('extractBookOptions');
    return opts || [];
  }

  const api = { crawlTsukkomi, listBooks, callAdapter, goto };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Crawler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
