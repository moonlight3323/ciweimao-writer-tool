'use strict';

/**
 * 作者信箱「一键清除小红点」
 *
 * 不逆向已读接口，而是复刻人的动作：把每条消息的「展开」都点一遍，
 * 由站点自己的脚本把它标成已读。这样即使站点改过实现，行为也仍然正确。
 *
 * 认不出红点结构时退化为「整页逐行展开」，并整页存进诊断目录，
 * 方便按真实 DOM 补判据。
 */
(function (root) {
  const ORIGIN = 'https://author.ciweimao.com';
  const MAILBOX = ORIGIN + '/homepage/sys_mailbox';
  const MAX_PAGES = 20;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function callAdapter(name, args) {
    // 必须走 pageSource：单个函数的 toString 里没有它依赖的辅助函数
    const src = window.CiweimaoAdapter.pageSource(name, args);
    return await window.api.browser.evalInPage(src);
  }

  async function ensureMailbox() {
    const state = await window.api.browser.state();
    const cur = (state && state.url) || '';
    if (!/\/homepage\/sys_mailbox/i.test(cur)) {
      await window.api.browser.goto(MAILBOX);
      await window.api.browser.waitIdle(20000);
      await sleep(700);
    }
    const where = await window.api.browser.evalInPage('location.href');
    if (/\/login/i.test(where || '')) {
      throw new Error('登录态已失效，请先在「作者后台」里重新登录');
    }
    return where;
  }

  /** 把当前页面存一份快照，结构对不上时有据可查 */
  async function saveSnapshot(tag) {
    try {
      const html = await window.api.browser.evalInPage(
        '"<!DOCTYPE html>" + document.documentElement.outerHTML'
      );
      await window.api.diag.save(`inbox-${tag}.html`, html);
    } catch (_) { /* 存不下来不影响主流程 */ }
  }

  /**
   * 清空当前页的红点。
   * @returns {Object} { before, after, clicked, mode, failed }
   */
  async function clearPage() {
    const scan = await callAdapter('inboxScan');

    if (!scan || (!scan.dots && !scan.expands)) {
      await saveSnapshot('empty');
      throw new Error('这个页面里没找到消息列表，可能没登录，或者刺猬猫改了版');
    }

    // 先按「只点带红点的行」来；一个红点都认不出来，就整页逐行展开（点展开本身就会标已读）
    let mode = scan.dots > 0 ? 'auto' : 'all';
    let res = await callAdapter('inboxClear', { mode, maxRows: 80 });

    if (mode === 'auto' && res && res.after >= res.before && scan.expands > 0) {
      // 点了却没减少：红点可能是背景图，认不出来，退回逐行展开
      mode = 'all';
      res = await callAdapter('inboxClear', { mode, maxRows: 80 });
    }

    return Object.assign({ mode, scan }, res || {});
  }

  /**
   * 主入口：清当前页，必要时继续翻后续分页。
   * @param {Object} opts { allPages, onProgress, shouldStop }
   *   shouldStop 每次翻页前问一次，返回 true 就停在当前页；页面内逐行点击的
   *   中断由 __wbInboxStop 旗标负责（见 requestStop）。
   */
  async function clearAll(opts) {
    const o = opts || {};
    const emit = o.onProgress || function () {};
    const allPages = o.allPages !== false;
    const shouldStop = typeof o.shouldStop === 'function' ? o.shouldStop : function () { return false; };

    // 开跑前把上一次残留的中断旗标清掉，否则这次一开工就被判成「已停止」
    await setPageStopFlag(false);

    emit({ phase: 'open', text: '正在打开作者信箱…' });
    if (shouldStop()) return { pages: [], before: 0, after: 0, clicked: 0, stopped: true, allPages };
    const url0 = await ensureMailbox();
    await saveSnapshot('before');

    const pages = [];
    let total = { before: 0, after: 0, clicked: 0 };
    let guard = 0;
    let next = '';
    let stopped = false;

    do {
      if (shouldStop()) { stopped = true; break; }
      guard += 1;
      emit({ phase: 'page', text: `正在处理第 ${pages.length + 1} 页…`, page: pages.length + 1 });

      const r = await clearPage();
      pages.push({
        url: r.url || url0,
        before: r.before || 0,
        after: r.after || 0,
        clicked: r.clicked || 0,
        mode: r.mode || '',
        dots: (r.scan && r.scan.dots) || 0,
      });
      total.before += r.before || 0;
      total.after += r.after || 0;
      total.clicked += r.clicked || 0;

      if (r.stopped || shouldStop()) { stopped = true; break; }

      if (!allPages) break;
      next = (r.scan && r.scan.nextUrl) || '';
      if (!next) break;
      if (guard >= MAX_PAGES) break;

      emit({ phase: 'turn', text: `本页完成，翻到下一页…` });
      await window.api.browser.goto(next);
      await window.api.browser.waitIdle(20000);
      await sleep(700);

      const where = await window.api.browser.evalInPage('location.href');
      if (/\/login/i.test(where || '')) throw new Error('翻页后跳到了登录页，登录态可能已失效');
      // 防止站点对 page 参数不敏感导致原地打转
      if (pages.some((p) => p.url === where)) break;
    } while (guard < MAX_PAGES);

    emit(stopped
      ? { phase: 'stopped', text: '已停止' }
      : { phase: 'done', text: '完成' });
    return Object.assign({ pages, allPages, stopped }, total);
  }

  /** 页面内的中断旗标：清页逻辑每一行点击前都会看它 */
  async function setPageStopFlag(on) {
    try {
      await window.api.browser.evalInPage(`window.__wbInboxStop = ${on ? 'true' : 'false'}`);
    } catch (_) { /* 页面没挂上就算了，翻页处还有一层 shouldStop 兜底 */ }
  }

  /** 点「停止」时调用：让当前页正在跑的逐行点击在下一条停下 */
  function requestStop() {
    return setPageStopFlag(true);
  }

  const api = { MAILBOX, clearPage, clearAll, ensureMailbox, requestStop };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Inbox = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
