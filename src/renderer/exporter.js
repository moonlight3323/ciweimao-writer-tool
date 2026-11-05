'use strict';

/**
 * 章节导出器
 *
 * 与抓取器同源同思路：所有请求都发生在内嵌浏览器的平台页面上下文里，
 * 天然携带登录态，只做 GET，不提交任何表单。
 *
 * 读取路径与抓取器不同：这里优先用页面内 fetch 直接取 HTML，再由适配层解析，
 * 不去真的翻页——一本几百章的书，逐页导航要十几分钟，fetch 只要两分钟，
 * 而且不会打断用户正在看的后台页面。只有在 fetch 拿不到正文（编辑器是前端渲染）时，
 * 才退回真实翻页，逐章读取 DOM。
 */
(function (root) {
  const ORIGIN = 'https://author.ciweimao.com';
  const CONCURRENCY = 3;
  const NAV_DELAY = 420;
  const PAGE_DELAY = 180;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function adapter() {
    return window.CiweimaoAdapter;
  }

  /** 确认平台页面已加载；没有任何页面时先打开首页 */
  async function ensurePlatform() {
    const st = await window.api.browser.state();
    if (st && st.ready && st.url) return st.url;
    await window.api.browser.goto(`${ORIGIN}/homepage`);
    await window.api.browser.waitIdle(20000);
    await sleep(600);
    const now = await window.api.browser.evalInPage('location.href');
    return now;
  }

  function assertNotLogin(url) {
    if (/\/login/i.test(String(url || ''))) {
      throw new Error('登录态已失效，请点右上角「打开作者后台」重新登录');
    }
  }

  /** 在平台页面上下文取回一份 HTML */
  async function fetchHtml(url) {
    const code = window.CiweimaoAdapter.pageSource('fetchHtml', { url });
    const raw = await window.api.browser.evalInPage(code);
    if (!raw) throw new Error('页面没有返回内容');
    assertNotLogin(raw.url);
    if (!raw.ok) throw new Error(`页面返回 ${raw.status}`);
    return raw;
  }

  /** 真实翻页后读取当前 DOM（fetch 拿不到正文时使用） */
  async function fetchByNavigation(url) {
    await window.api.browser.goto(url);
    await window.api.browser.waitIdle(20000);
    await sleep(NAV_DELAY);
    const here = await window.api.browser.evalInPage('location.href');
    assertNotLogin(here);
    const html = await window.api.browser.evalInPage(
      '"<!DOCTYPE html>" + document.documentElement.outerHTML'
    );
    return { ok: true, status: 200, url: here, html };
  }

  /** 章节详情片段：站点自身用来渲染 #chapter_detail 的只读接口 */
  async function fetchChapterDetail(bookId, chapterId) {
    const code = window.CiweimaoAdapter.pageSource('fetchChapterDetail', { bookId, chapterId });
    const raw = await window.api.browser.evalInPage(code);
    if (!raw) throw new Error('章节详情接口没有返回内容');
    if (!raw.ok) throw new Error(`章节详情接口返回 ${raw.status}`);
    return raw;
  }

  // ---------------------------------------------------------------- 作品与章节

  /** 读取作品清单。优先 fetch 解析，失败再退回导航式读取 */
  async function listBooks() {
    await ensurePlatform();
    const r = await fetchHtml(`${ORIGIN}/book_manage/view_list`);
    const books = adapter().parseBookList(r.html, r.url) || [];
    if (books.length) return books;

    // 兜底：作品列表页结构变了，就借间贴页左上角的下拉框
    const sel = await fetchHtml(`${ORIGIN}/review_manage/manage_tsukkomi`);
    const viaSelect = adapter().parseBookList(sel.html, sel.url) || [];
    if (viaSelect.length) return viaSelect;

    throw new Error('没有读到任何作品，页面结构可能已变更（详情见诊断目录）');
  }

  /**
   * 读取指定作品的章节列表。
   * @param {string} bookId
   * @param {Object} opts { onProgress }
   */
  async function listChapters(bookId, opts) {
    const o = opts || {};
    const emit = o.onProgress || function () {};

    await ensurePlatform();
    emit({ phase: 'list', page: 1, total: 1, count: 0 });

    const first = await fetchHtml(`${ORIGIN}/book_manage/view_chapter_info?book_id=${encodeURIComponent(bookId)}`);
    const parsed = adapter().parseChapterList(first.html, first.url);
    let chapters = parsed.chapters || [];
    const pageLinks = parsed.pageLinks || {};
    const maxPage = Math.min(Math.max(1, parsed.maxPage || 1), 200);

    if (!chapters.length) {
      return {
        chapters: [],
        hint: parsed.hint || '',
        pageBookId: parsed.pageBookId || '',
        raw: { url: first.url, htmlLen: (first.html || '').length },
        html: first.html,
      };
    }

    const seen = new Set(chapters.map((c) => String(c.chapterId)));
    for (let p = 2; p <= maxPage; p += 1) {
      const url = pageLinks[p]
        || `${ORIGIN}/book_manage/view_chapter_info?&page=${p}&book_id=${encodeURIComponent(bookId)}`;
      let page;
      try {
        page = await fetchHtml(url);
      } catch (err) {
        if (/登录态/.test(err.message || '')) throw err;
        break;
      }
      const pp = adapter().parseChapterList(page.html, page.url);
      const list = (pp && pp.chapters) || [];
      if (!list.length) break;
      let added = 0;
      list.forEach((c) => {
        if (seen.has(String(c.chapterId))) return;
        seen.add(String(c.chapterId));
        chapters.push(c);
        added += 1;
      });
      emit({ phase: 'list', page: p, total: maxPage, count: chapters.length });
      if (!added) break;
      await sleep(PAGE_DELAY);
    }

    chapters.forEach((c, i) => { c.index = i + 1; });
    return {
      chapters,
      hint: parsed.hint || '',
      pageBookId: parsed.pageBookId || '',
      raw: { url: first.url },
      html: '',
    };
  }

  function chapterUrl(book, ch) {
    if (ch.url && /^https:\/\/author\.ciweimao\.com\/book_manage\//i.test(ch.url)) return ch.url;
    return `${ORIGIN}/book_manage/draft?book_id=${encodeURIComponent(book.bookId)}&chapter_id=${encodeURIComponent(ch.chapterId)}`;
  }

  /**
   * 判定「取到的文本像不像这一章的正文」。
   *
   * 页面结构不明的时候，最危险的不是读不到，而是读到了别的块（列表页、章节信息卡）
   * 还当成正文静默导出。这里用列表里已经给出的字数做交叉校验：
   * 声明 2000 字的章节，取回来不足 600 字就一定不是正文。
   */
  function plausible(text, words) {
    const t = String(text || '');
    const len = t.replace(/\s/g, '').length;
    if (len < 8) return false;

    // 列表页特征：满屏「共2117字」和「第N章」
    if (/共\s*\d{1,6}\s*字/.test(t)) return false;
    const markers = (t.match(/第\s*\d{1,4}\s*章/g) || []).length;
    if (markers > 3) return false;

    // 与后台声明的字数对不上（允许 30% 偏差，正文里常有多余空白与标注）
    if (words && words > 200 && len < words * 0.3) return false;
    return true;
  }

  /**
   * 取一章正文。三种来源按可靠性排序，用哪种由 probeMode 决定。
   *   draft  —— 编辑页的 textarea，拿到的就是原始文本，质量最好
   *   detail —— 站点自己的章节详情接口（只读 POST），正文在普通 DOM 里
   *   nav    —— 真把平台视图翻到编辑页再读 DOM，最慢，只在前面都不行时用
   */
  async function readOne(book, ch, mode) {
    if (mode === 'detail') {
      const r = await fetchChapterDetail(book.bookId, ch.chapterId);
      const parsed = adapter().parseChapterContent(r.html, { fallbackTitle: ch.title });
      parsed.mode = 'detail';
      return parsed;
    }
    if (mode === 'nav') {
      const nav = await fetchByNavigation(chapterUrl(book, ch));
      const parsed = adapter().parseChapterContent(nav.html, { fallbackTitle: ch.title });
      parsed.mode = 'nav';
      return parsed;
    }
    const r = await fetchHtml(chapterUrl(book, ch));
    const parsed = adapter().parseChapterContent(r.html, { fallbackTitle: ch.title });
    parsed.mode = 'draft';
    return parsed;
  }

  /**
   * 探测用哪种方式取正文：拿第一章挨个试，第一个「像正文」的就定下来。
   * 试的过程中把原始响应留存，全都失败时写进诊断目录，便于按真实结构补规则。
   */
  async function probeMode(book, ch, samples) {
    const url = chapterUrl(book, ch);
    const tryOne = (p) => plausible(p && p.content, ch.words);

    // 1) 编辑页 GET
    try {
      const r = await fetchHtml(url);
      if (samples) samples.draft = r.html;
      const p = adapter().parseChapterContent(r.html, { fallbackTitle: ch.title });
      if (p.needLogin) throw new Error('登录态已失效，请重新登录作者后台');
      if (tryOne(p)) return { mode: 'draft' };
    } catch (err) {
      if (/登录态/.test(err.message || '')) throw err;
    }

    // 2) 站点自己的章节详情接口
    try {
      const r = await fetchChapterDetail(book.bookId, ch.chapterId);
      if (samples) samples.detail = r.html;
      const p = adapter().parseChapterContent(r.html, { fallbackTitle: ch.title });
      if (p.needLogin) throw new Error('登录态已失效，请重新登录作者后台');
      if (tryOne(p)) return { mode: 'detail' };
    } catch (err) {
      if (/登录态/.test(err.message || '')) throw err;
    }

    // 3) 真实翻页
    try {
      const nav = await fetchByNavigation(url);
      if (samples) samples.nav = nav.html;
      const p = adapter().parseChapterContent(nav.html, { fallbackTitle: ch.title });
      if (tryOne(p)) return { mode: 'nav' };
    } catch (err) {
      if (/登录态/.test(err.message || '')) throw err;
    }

    // 都没拿到：可能这一章本身就是空的，按 detail 继续，不因此中断整次导出
    return { mode: 'detail', empty: true };
  }

  /**
   * 批量读取正文。
   * @param {Object} book   { bookId, name }
   * @param {Array}  list   章节数组
   * @param {Object} opts   { onProgress, shouldStop }
   */
  async function readContents(book, list, opts) {
    const o = opts || {};
    const emit = o.onProgress || function () {};
    const stopped = o.shouldStop || function () { return false; };

    const total = list.length;
    let done = 0;
    let cursor = 0;
    const results = new Array(total).fill(null);
    const failed = [];
    let mode = 'detail';
    const samples = {};

    if (total) {
      emit({ phase: 'probe', done: 0, total, title: list[0].title });
      const probe = await probeMode(book, list[0], samples);
      mode = probe.mode;
    }

    const worker = async () => {
      while (true) {
        if (stopped()) return;
        const i = cursor;
        cursor += 1;
        if (i >= total) return;

        const ch = list[i];
        try {
          const parsed = await readOne(book, ch, mode);
          if (parsed.needLogin) throw new Error('登录态已失效');
          const text = parsed.content || '';
          if (text && !plausible(text, ch.words)) {
            throw new Error(`取到的内容不像正文（${text.replace(/\s/g, '').length} 字，后台标注 ${ch.words == null ? '未知' : ch.words} 字）`);
          }
          results[i] = {
            chapterId: ch.chapterId,
            title: parsed.title || ch.title,
            content: text,
            note: parsed.note || '',
          };
          if (!text) failed.push({ chapterId: ch.chapterId, title: ch.title, error: '正文为空' });
        } catch (err) {
          const msg = String((err && err.message) || err);
          if (/登录态/.test(msg)) throw err;
          failed.push({ chapterId: ch.chapterId, title: ch.title, error: msg });
        } finally {
          done += 1;
          emit({ phase: 'chapter', done, total, title: ch.title });
        }
      }
    };

    const workers = [];
    // 逐页模式只能串行：平台视图只有一个，并发 goto 会让相邻章节互相串内容
    const parallel = mode === 'nav' ? 1 : Math.min(CONCURRENCY, total);
    for (let w = 0; w < parallel; w += 1) workers.push(worker());
    await Promise.all(workers);

    // 整本一章都没读出来：把第一手的原始响应留给诊断，避免下次再靠猜
    if (total && results.every((x) => !x || !x.content) && samples) {
      try {
        if (samples.draft) await window.api.diag.save('export-sample-draft.html', samples.draft);
        if (samples.detail) await window.api.diag.save('export-sample-detail.html', samples.detail);
        if (samples.nav) await window.api.diag.save('export-sample-nav.html', samples.nav);
      } catch (_) { /* ignore */ }
    }

    const chapters = results.filter(Boolean);
    return { mode, chapters, failed, stopped: stopped(), sampled: !!samples.detail };
  }

  // ---------------------------------------------------------------- 文本组装

  function pad2(n) { return String(n).padStart(2, '0'); }

  function stamp(d) {
    const x = d || new Date();
    return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())} `
      + `${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
  }

  /** 文件名里不能出现的字符一律替换，避免保存失败 */
  function safeName(s) {
    return String(s || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || '未命名';
  }

  /**
   * 组装 TXT。用 CRLF 换行——Windows 记事本对 LF 的兼容性不稳定。
   * 正文里可能混着 \n（来自 textarea）与 \r\n，统一成 CRLF 后再拼，
   * 否则同一份文件里两种换行并存，某些编辑器里行距会不一致。
   */
  function buildTxt(book, chapters) {
    const crlf = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').split('\n').join('\r\n');
    const L = [];
    L.push(`《${book.name}》`);
    L.push(`导出时间：${stamp()}`);
    L.push(`章节数：${chapters.length}`);
    L.push('');
    L.push('说明：本文档由「刺猬猫作家助手」从作者后台只读导出，未改动平台任何内容。');
    L.push('');

    chapters.forEach((ch, i) => {
      L.push('');
      L.push('='.repeat(40));
      L.push(ch.title || `第 ${i + 1} 章`);
      L.push('='.repeat(40));
      L.push('');
      L.push(ch.content ? crlf(ch.content) : '（本章正文为空）');
      if (ch.note) {
        L.push('');
        L.push('【作者的话】');
        L.push(crlf(ch.note));
      }
      L.push('');
    });

    return L.join('\r\n');
  }

  const api = {
    ensurePlatform,
    plausible,
    listBooks,
    listChapters,
    readContents,
    buildTxt,
    safeName,
    stamp,
    chapterUrl,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Exporter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
