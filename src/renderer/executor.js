'use strict';

/**
 * 执行台逻辑（纯函数 + 一次动作的编排）
 *
 * 这里刻意不做任何「猜」的事：
 * - 编号全部来自本地已抓取的间贴数据（真实页面解析出来的）；
 * - 每个动作只发一条最小请求，失败立即停；
 * - 拉黑不是平台独立接口，它是「删除这条 + 禁言这个人」的组合，
 *   站点自己的确认文案也说明禁言是跨作品生效的。
 */
(function (root) {
  const ORIGIN = 'https://author.ciweimao.com';

  function pickRandom(items, opts) {
    const o = opts || {};
    const pool = o.highOnly
      ? items.filter((x) => x.level === 'high' || x.level === 'mid')
      : items;
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** 章节页地址：把用户送到「这一章的间贴」而不是全书第一页 */
  function pageUrl(slip) {
    const c = String(slip.chapterId || '0') || '0';
    return `${ORIGIN}/review_manage/manage_tsukkomi?book_id=${slip.bookId}&chapter_id=${c}`;
  }

  function buildSlip(item) {
    if (!item) return null;
    const hits = (item.hits || []).map((h) => `${h.name}（${h.matched}）`);
    return {
      localId: String(item.id || ''),
      commentId: String(item.platformId || item.id || '').replace(/^tsukkomi:/, ''),
      readerId: String(item.readerId || ''),
      bookId: String(item.bookId || ''),
      chapterId: String(item.chapterId || '0') || '0',
      bookName: item.bookName || '',
      chapterName: item.chapterName || '',
      paraPos: item.paraPos || '',
      nickname: item.nickname || '未知读者',
      content: item.content || '',
      time: item.time || '',
      score: item.score || 0,
      level: item.level || 'none',
      hits,
      pageUrl: '',
    };
  }

  /** 执行单的可读文本（手动处理时复制到记事本 / 粘给自己看） */
  function slipText(slip) {
    if (!slip) return '';
    return [
      `读者：${slip.nickname}（ID ${slip.readerId}）`,
      `间贴：${slip.commentId}`,
      `作品：${slip.bookName}（${slip.bookId}）`,
      `章节：${slip.chapterName}${slip.paraPos ? ' · ' + slip.paraPos : ''}（${slip.chapterId}）`,
      `时间：${slip.time || '—'}`,
      `审查：${slip.level === 'none' ? '无标记' : slip.level === 'high' ? '高风险' : '中风险'} · ${slip.score} 分`,
      slip.hits.length ? `命中：${slip.hits.join('；')}` : '命中：无',
      '',
      `原文：${slip.content}`,
      '',
      `页面：${slip.pageUrl || pageUrl(slip)}`,
    ].join('\n');
  }

  const ACTION_LABEL = {
    delete: '删除间贴',
    mute: '禁言读者',
    block: '拉黑（删除 + 禁言）',
  };

  function requestPreview(slip, action) {
    if (!slip) return '';
    const lines = [];
    if (action === 'delete' || action === 'block') {
      lines.push(`POST /review_manage/delete_tsukkomi?book_id=${slip.bookId}&page=1&chapter_id=${slip.chapterId}`);
      lines.push(`     tsukkomi_id[]=${slip.commentId}`);
    }
    if (action === 'mute' || action === 'block') {
      lines.push(`GET /review_manage/speak_tsukkomi?speak=${slip.readerId}&tsukkomi_id=${slip.commentId}`
        + `&book_id=${slip.bookId}&page=1&set_value=0&chapter_id=${slip.chapterId}`);
    }
    return lines.join('\n');
  }

  /** 结果文案：把「请求成功」和「确实生效」分开说，不糊弄 */
  function resultText(action, res, verify) {
    const label = ACTION_LABEL[action] || action;
    if (!res) return `${label}：没有返回结果`;
    if (res.dryRun) return `${label}：演练完成，请求没有发出。`;
    if (!res.ok) {
      const why = res.needLogin
        ? '登录态已失效，请先到「作者后台」重新登录（这次没有发出任何改动）'
        : (res.error || res.note || `HTTP ${res.status || '?'}`);
      return `${label}：失败 · ${why}`;
    }
    let tail = '';
    if (action === 'delete' || action === 'block') {
      if (res.stillThere) tail = '（请求已完成，但列表里仍能找到这条）';
    }
    let v = '';
    if (verify) {
      if (action === 'delete' && verify.present === false) v = ' · 复核：已不存在';
      else if (action === 'delete' && verify.present === true) v = ' · 复核：仍然存在，请刷新确认';
      else if (action === 'mute' && verify.muted === true) v = ' · 复核：已进禁言回收站';
      else if (action === 'mute' && verify.muted === false) v = ' · 复核：回收站首页没找到（可能在其他页，以平台显示为准）';
      else if (verify.error) v = ' · 复核失败';
    }
    return `${label}：已发出${tail}${v}`;
  }

  /**
   * 确保平台页面停在作者后台（否则 fetch 不带登录态，甚至跨源）。
   * 只读检查，不会改动任何东西。
   */
  async function ensurePlatform(slip) {
    let st = null;
    try { st = await window.api.browser.state(); } catch (_) { st = null; }
    const url = (st && st.url) || '';
    const onAuthor = /^https://////author//.ciweimao//.com////i.test(url);

    if (!st || !st.ready || !onAuthor) {
      await window.api.browser.goto(pageUrl(slip));
      await window.api.browser.waitIdle(20000);
    }
    const where = await window.api.browser.evalInPage('location.href');
    if (/\/login/i.test(where || '')) {
      throw new Error('登录态已失效，请先到「作者后台」登录后再执行');
    }
  }

  /** 单个动作（不含拉黑） */
  async function runOne(slip, action, opts) {
    const o = opts || {};
    const target = {
      tsukkomiId: slip.commentId,
      readerId: slip.readerId,
      bookId: slip.bookId,
      chapterId: slip.chapterId,
    };
    const res = await window.api.exec.run({
      action,
      target,
      dryRun: !!o.dryRun,
      title: `${slip.bookName} / ${slip.chapterName}`,
      content: slip.content,
    });
    if (o.dryRun || !res || !res.ok) return { action, res, verify: null };
    // 立刻复核一次，别让「请求 200」冒充「事情办成了」
    let verify = null;
    try {
      verify = await window.api.exec.verify({ action, target });
    } catch (_) { verify = { error: true }; }
    return { action, res, verify };
  }

  /**
   * 执行动作。
   * @param {Object} slip
   * @param {string} action delete | mute | block
   * @param {Object} opts { dryRun, onStep }
   */
  async function run(slip, action, opts) {
    const o = opts || {};
    const step = o.onStep || function () {};
    const out = [];

    // 演练不碰平台；真发请求前先确认页面在作者后台
    if (!o.dryRun) await ensurePlatform(slip);

    if (action === 'block') {
      step('删除间贴');
      out.push(await runOne(slip, 'delete', o));
      // 删除失败就别再禁言：用户选「拉黑」的意图是彻底处理，但半途失败要说清楚
      if (!o.dryRun && out[0].res && out[0].res.ok === false) {
        return { action, steps: out, ok: false, stopped: true };
      }
      await new Promise((r) => setTimeout(r, 900));
      step('禁言读者');
      out.push(await runOne(slip, 'mute', o));
    } else {
      out.push(await runOne(slip, action, o));
    }

    const ok = out.every((x) => x.res && (x.res.ok || x.res.dryRun));
    return { action, steps: out, ok, stopped: false };
  }

  const api = {
    ACTION_LABEL,
    ensurePlatform,
    pickRandom,
    buildSlip,
    pageUrl,
    slipText,
    requestPreview,
    resultText,
    run,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Executor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
