'use strict';

/**
 * 投递到后台：把码字台里的这一章送进刺猬猫的新建章节页。
 *
 * 做法上刻意「借页面」而不是「自己发请求」：
 * 标题、正文、分卷、定时发布都填进站点自己的表单，图片上传、@ 提及、
 * 活动推荐这些原页面功能照旧可用；站点自己的字数统计与日期控件也不会失效。
 *
 * 发布校验走站点同一个接口（add_chapter），但由我们发、我们收，
 * 所以能拿回 hint_words 在本地做高亮与替换 —— 站点原流程是弹个框就完事。
 *
 * ★ 侧栏在独立悬浮窗里（src/main/pubside.js + renderer/side.html）：
 *   后台页面是原生 WebContentsView，压过一切 DOM；侧栏若留在主窗口，只能靠
 *   「让页面视图让出宽度」来避免遮挡，而刺猬猫后台是固定宽度布局，一挤就变形。
 *   所以本文件只当**控制器**：把状态推给侧栏窗口，把侧栏发回来的动作执行掉。
 *   词的解析、命中判定、方案计算仍在这里（badwords.js 是纯函数），逻辑只有一份。
 */
(function (root) {
  const ORIGIN = 'https://author.ciweimao.com';
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const state = {
    busy: false,
    chapterId: '',
    bookId: '',
    baseText: '',
    rawHint: '',
    analysis: null,
    schedule: '',
    round: 0,
    lastResult: null,
    fromPage: false,
    /** 「已填入」状态的信息，处理完敏感词要拿它还原侧栏 */
    readyInfo: null,
    /** 最近一次推给侧栏的内容，点顶栏按钮重开时直接复用 */
    lastPayload: null,
    sideOpen: false,
    /** 因为切页面被收起来的（回来时自动放出来） */
    sideParked: false,
  };

  function A() { return window.CiweimaoAdapter; }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------- 小工具

  function toast(title, html) {
    const box = $('#publishToast');
    if (!box) return;
    box.hidden = false;
    $('#publishToastTitle').textContent = title;
    $('#publishToastBody').innerHTML = html || '';
  }

  function toastHide() {
    const box = $('#publishToast');
    if (box) box.hidden = true;
  }

  async function evalPage(fnName, args) {
    const code = A().pageSource(fnName, args);
    return window.api.browser.evalInPage(code);
  }

  function currentTheme() {
    return (document.documentElement.dataset.theme || 'light') === 'dark' ? 'dark' : 'light';
  }

  function versionText() {
    const el = document.querySelector('.version');
    const m = el ? String(el.textContent || '').match(/v([\d.]+)/) : null;
    return m ? m[1] : '';
  }

  // ---------------------------------------------------------------- 侧栏窗口

  function sideApi() { return window.api && window.api.pubside; }

  /** 推给侧栏窗口；没开就打开它 */
  async function pushSide(payload, opts) {
    const o = opts || {};
    const api = sideApi();
    if (!api) return false;
    const full = Object.assign({ theme: currentTheme(), version: versionText() }, payload);
    // transient = 只显示这一下，不进 lastPayload（否则关掉再打开还会看到旧错误）
    if (!o.transient) state.lastPayload = full;
    try {
      const btn = $('#btnPubSide');
      if (btn) btn.hidden = false;
      if (o.open || !state.sideOpen) {
        await api.open(full);
        state.sideOpen = true;
      } else {
        await api.setState(full);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function hideSide() {
    const api = sideApi();
    if (!api) return;
    try { await api.close(); } catch (_) { /* ignore */ }
    state.sideOpen = false;
    // 注意：不清 lastPayload —— 顶栏「敏感词侧栏」按钮要靠它把窗口重新打开
  }

  /** 这一章已经结束（发出去或直接提交），侧栏内容作废 */
  function resetSide() {
    state.lastPayload = null;
    state.sideOpen = false;
    state.analysis = null;
    const btn = $('#btnPubSide');
    if (btn) btn.hidden = true;
  }

  /** 顶栏「敏感词侧栏」按钮：有内容就开/关，没有就提示 */
  async function toggleSide() {
    const api = sideApi();
    if (!api) return;
    if (!state.lastPayload) {
      toast('还没有要显示的内容', '先把一章投到后台，或者让站点校验一次，侧栏才有东西可看。');
      return;
    }
    let open = state.sideOpen;
    try {
      const st = await api.isOpen();
      open = !!(st && st.visible);
    } catch (_) { /* 拿不到就按本地状态 */ }
    if (open) {
      await hideSide();
      toast('侧栏已收起', '后台页面宽度没有任何变化。点顶栏「敏感词侧栏」可以再打开。');
    } else {
      await pushSide(state.lastPayload, { open: true });
    }
  }

  /** 在小窗里给一条提示（错误基本都发生在侧栏可见的时候，弹 toast 会被原生视图盖住） */
  async function notice(kind, text) {
    const base = state.lastPayload;
    if (state.sideOpen && base) {
      await pushSide(Object.assign({}, base, {
        notice: { kind: kind || 'info', text: text || '' },
      }), { transient: true });
      return;
    }
    toast(kind === 'error' ? '出错了' : '提示', text || '');
  }

  // ---------------------------------------------------------------- 主流程

  async function publishCurrent() {
    if (state.busy) return;
    const W = root.Writer;
    if (!W) return;

    const book = W.currentBook();
    const chapter = W.currentChapter();
    if (!book) { toast('没有选中作品', '先建一本书再投递。'); return; }
    if (!chapter) { toast('没有选中章节', '左侧点一章，或者先新建一章。'); return; }
    if (!book.platformBookId) {
      // 正常情况下进码字台时已经自动对齐了；这里是兜底：
      // 后台只有一本书或书名能对上就自动绑，有歧义才让人点一下
      toast('正在确认这本书对应后台的哪一本…', '只需要确认一次，之后会记住。');
      const bind = await root.Writer.autoBindPlatform(book);
      if (!bind.ok) {
        if (!bind.canceled) {
          toast('这本书还没对上后台的书',
            escapeHtml(bind.error || '')
            + (bind.needLogin ? '<br>先点右上角「打开作者后台」登录一次。' : '')
            + '<br>也可以点左侧「同步后台」重新读一次。');
        } else {
          toastHide();
        }
        return;
      }
    }

    const text = W.getText();
    if (!String(text || '').trim()) {
      toast('这一章还没有正文', '先在码字台里写点内容。');
      return;
    }

    state.busy = true;
    state.chapterId = chapter.id;
    state.bookId = book.id;
    state.baseText = text;
    state.round = 0;
    try {
      await W.saveNow();

      toast('正在打开后台…', `作品：<b>${escapeHtml(book.name)}</b>　平台作品号 ${escapeHtml(book.platformBookId)}`);
      await gotoDraft(book.platformBookId);

      toast('等待新建章节页就绪…', '第一次打开会慢一点，页面初始化完就会自动填表。');
      const ready = await waitForm(32000);
      if (!ready.ok) {
        toast('页面没准备好', escapeHtml(ready.error) + '<br>可以点「回到后台页面」看一眼是不是被弹回登录页了。');
        state.busy = false;
        return;
      }

      // 顺手把站点的发布按钮接管掉：之后就算你在页面上直接点「发布章节」，
      // 也会走我们这一套（能拿到 hint_words），而不是站点那个「执意提交就隐藏敏感词」的确认框
      await ensureHook();
      startPoll();

      // 页面上如果还留着上次没发完的内容，直接覆盖 —— 点「投到后台」本身就是
      // 「把这章送过去」的意思，再弹一个输入框确认只会添乱。
      const ps = ready.state;

      const div = pickDivision(ps, chapter.vol);
      const filled = await doFill(chapter, state.baseText, div);
      if (!filled.ok) {
        toast('填充失败', escapeHtml(filled.error || '未知原因'));
        state.busy = false;
        return;
      }

      // 投递完就停在这一页，让作者自己确认、插图、改字；侧栏待命
      toastHide();
      await showReadySide({
        bookName: book.name,
        chapterTitle: chapter.title,
        volName: div.matched ? div.name : (div.name || chapter.vol),
        words: filled.wordCount || 0,
        schedule: state.schedule || '',
      });
    } catch (err) {
      toast('投递中断', escapeHtml(String((err && err.message) || err)));
    } finally {
      state.busy = false;
    }
  }

  async function doFill(chapter, text, div) {
    const html = window.BadWords.textToHtml(text);
    const res = await evalPage('pageFillChapter', {
      title: chapter.title,
      html,
      divisionId: div && div.id ? div.id : undefined,
      schedule: state.schedule === '' ? '' : state.schedule,
    });
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || '页面没有响应填充' };
    return { ok: true, wordCount: res.wordCount, htmlLen: res.htmlLen };
  }

  /** 等页面出现章节表单与 KindEditor 实例 */
  async function waitForm(maxMs) {
    const limit = maxMs || 30000;
    const step = 500;
    for (let waited = 0; waited < limit; waited += step) {
      let st = null;
      try { st = await evalPage('pageChapterState'); } catch (_) { st = null; }
      if (st && st.hasForm && st.hasEditor) return { ok: true, state: st };
      await sleep(step);
    }
    const st = await window.api.browser.state().catch(() => null);
    return {
      ok: false,
      error: '后台页面 30 秒内没准备好'
        + (st && st.url ? '（现在停在 ' + st.url + '）' : '')
        + '，可能是登录失效或站点很慢',
    };
  }

  /** 打开指定作品的新建章节页 */
  async function gotoDraft(platformBookId) {
    const url = `${ORIGIN}/book_manage/draft?book_id=${encodeURIComponent(platformBookId)}`;
    const want = `book_id=${platformBookId}`;

    // 不能直接用 openBrowser(url)：主进程的 browser:open 在「当前停在后台首页」时
    // 视为「用户只是要回后台」，不会 loadURL，于是会停在首页不动（v0.9.2 的坑）。
    // 所以先把它挂上来，再自己导航过去。
    if (typeof root.showBrowserKeepPage === 'function') await root.showBrowserKeepPage();
    else await window.api.browser.open({ x: 0, y: 0, width: 900, height: 700 }, url);

    const cur = await window.api.browser.state().catch(() => null);
    const already = cur && cur.ready && String(cur.url || '').indexOf(want) >= 0
      && /\/book_manage\/draft/.test(cur.url || '');
    if (!already) {
      await window.api.browser.navigate(url);
      await window.api.browser.waitIdle(25000);
      await sleep(500);
    }
    return { url, reused: !!already };
  }

  /** 卷名对齐：本地卷名 → 页面上的 division_id */
  function pickDivision(pageState, volName) {
    const vols = (pageState && pageState.volumes) || [];
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const want = norm(volName);
    if (want) {
      const hit = vols.find((v) => norm(v.name) === want)
        || vols.find((v) => norm(v.name).indexOf(want) >= 0 || want.indexOf(norm(v.name)) >= 0);
      if (hit) return { id: hit.id, name: hit.name, matched: true };
    }
    const first = vols[0];
    return {
      id: (pageState && pageState.divisionId) || (first && first.id) || '',
      name: first ? first.name : '',
      matched: false,
    };
  }

  // ---------------------------------------------------------------- 接管页面上的发布按钮

  let pollTimer = null;
  let pollBusy = false;
  let lastHandledAt = 0;

  async function ensureHook() {
    try { return await evalPage('pageHookPublish'); } catch (_) { return null; }
  }

  /** 只要后台页面停在新建章节页，就把站点的发布按钮接管掉 */
  function watchPageLoad() {
    try {
      window.api.browser.onEvent(async (ev) => {
        if (!ev || ev.type !== 'browser-state') return;
        if (!/\/book_manage\/draft/i.test(ev.url || '')) return;
        const r = await ensureHook();
        if (r && r.ok) startPoll();
      });
    } catch (_) { /* 订阅失败就只靠投递时注入 */ }
  }

  /**
   * 每 1.2 秒问一次页面有没有新的校验结果。
   * 为什么要轮询：页面上按钮是站点自己触发的，渲染进程收不到回调，
   * 只能由我们主动把结果取回来（页面侧存在 window.__wbCheckResult）。
   */
  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(pollOnce, 1200);
  }

  async function pollOnce() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const r = await evalPage('pageReadCheck');
      if (!r || (r.phase !== 'done' && r.phase !== 'error')) return;
      if (r.at && r.at <= lastHandledAt) return;
      lastHandledAt = r.at || Date.now();
      try { await evalPage('pageClearCheck'); } catch (_) { /* ignore */ }
      await handleCheckResult(normalize(r), { fromPage: true });
    } catch (_) {
      /* 页面没开或已销毁，安静跳过 */
    } finally {
      pollBusy = false;
    }
  }

  /** 两种来源（页面 hook / 我们主动校验）的结果统一成一种形状 */
  function normalize(res) {
    if (!res) return { phase: 'error', error: '页面没有响应' };
    if (res.phase) return res;
    return {
      phase: res.ok ? 'done' : 'error',
      suggestion: res.suggestion || '',
      msg: res.msg || '',
      url: res.url || '',
      hintWords: res.hintWords || '',
      error: res.error || '',
      needLogin: !!res.needLogin,
    };
  }

  async function handleCheckResult(res, opts) {
    const o = opts || {};
    if (res.phase === 'error') {
      await notice('error', escapeHtml(res.error || '未知错误')
        + (res.needLogin ? '<br>请先点右上角「打开作者后台」重新登录。' : ''));
      return;
    }
    if (res.suggestion === 'pass') {
      await onPublished(res);
      return;
    }
    if (res.suggestion === 'error') {
      await notice('error', escapeHtml(res.msg || '没有给出原因')
        + '<br>常见原因：标题为空、正文不足 100 字、同一章重复提交。');
      return;
    }
    // 有疑似敏感词：开侧栏窗口，处理的就是页面本身
    await openBadwordPanel(res, { fromPage: !!o.fromPage });
  }

  // ---------------------------------------------------------------- 校验

  async function checkNow() {
    state.round += 1;
    toast(`正在提交校验${state.round > 1 ? `（第 ${state.round} 次）` : ''}…`,
      '等站点返回结果。这一步只是校验，没通过的话章节不会发出去。');

    const res = await evalPage('pageCheckChapter', { buttonValue: 'dosubmit' });
    state.lastResult = res;

    // 站点返回的 hint_words 格式没有公开约定，留一份原文在 data/publish-debug.json，
    // 万一某天解析不出来，照这份改规则就行，不用再猜。
    try {
      window.api.data.write('publish-debug.json', {
        at: new Date().toISOString(),
        chapter: state.chapterId,
        suggestion: res && res.suggestion,
        msg: res && res.msg,
        url: res && res.url,
        hintWordsRaw: res && res.hintWords,
        parsed: res && res.hintWords ? window.BadWords.parseHint(res.hintWords) : [],
        raw: (res && res.raw) || null,
      });
    } catch (_) { /* 调试记录失败不影响发布 */ }

    await handleCheckResult(normalize(res), {});
  }

  async function onPublished(res) {
    await hideSide();
    resetSide();
    toast('已提交成功', `<span class="is-ok">${escapeHtml(res.msg || '站点已接收这一章')}</span>`
      + '<br>如果开了审核，会先进入审核队列。');
    try {
      const cid = (String(res.url || '').match(/chapter_id=(\d+)/) || [])[1] || '';
      await root.Writer.markPublished({ chapterId: cid });
    } catch (_) { /* 标记失败不影响已发布的事实 */ }
  }

  // ---------------------------------------------------------------- 侧栏内容

  /** 状态一：内容已填好，侧栏待命，等作者确认 */
  async function showReadySide(info, note) {
    const i = info || {};
    state.readyInfo = i;
    await pushSide({
      mode: 'ready',
      ready: {
        title: '已填入后台',
        sub: '在左边页面上确认后再发布',
        bookName: i.bookName || '—',
        chapterTitle: i.chapterTitle || '—',
        volName: i.volName || '—',
        words: i.words || 0,
        schedule: i.schedule || '',
        note: note || '',
      },
    }, { open: true });
  }

  async function openBadwordPanel(res, opts) {
    const o = opts || {};
    state.fromPage = !!o.fromPage;
    const raw = (res && res.hintWords) || '';
    state.rawHint = raw;
    const words = window.BadWords.parseHint(raw);

    // 以页面里的正文为准：用户可能直接在网页上改过，本地那份未必同步。
    // 取不到才退回本地正文。
    let text = '';
    try {
      const pt = await evalPage('pageEditorText');
      if (pt && pt.ok && String(pt.text || '').trim()) text = pt.text;
    } catch (_) { /* 页面取不到就退回本地 */ }
    if (!text) {
      if (root.Writer) text = root.Writer.getText() || '';
      if (!text) {
        const ta = document.querySelector('#writerText');
        if (ta) text = ta.value || '';
      }
    }
    state.baseText = text;

    if (!words.length) {
      // 站点说有问题，却给不出能用的词表 —— 这种情况只能让作者自己决定
      await pushSide({
        mode: 'bad',
        bad: {
          title: '站点没给出具体词',
          sub: '多半是标题或作者有话说触发的',
          lead: '站点提示有敏感内容，但没说是哪个词。这种只能自己判断：要么点「直接提交」，要么先在后台页面里手动看一遍。'
            + (raw ? `<br><br><span style="color:var(--danger-ink)">站点原文：${escapeHtml(String(raw).slice(0, 200))}</span>` : ''),
          items: [],
        },
      }, { open: true });
      return;
    }

    const analysis = window.BadWords.analyze(text, words);
    state.analysis = analysis;

    const hit = analysis.hits.length;
    const miss = analysis.misses.length;
    const fromPageTip = state.fromPage
      ? '<br><b>你刚才在后台页面点了「发布章节」，这次提交已经被拦下来了——正文没有发出去。</b>'
      : '';

    const lead = (hit
      ? (miss
        ? `正文里找到 <b>${hit}</b> 个，另有 <b>${miss}</b> 个在正文里找不到（多半是站点按分词联想的误报，不用改）。`
        : `正文里找到 <b>${hit}</b> 个。选好处理方式后点「一键处理」，改的是页面正文本身。`)
      : `站点报的 ${miss} 个词，在正文里一个都没找到 —— 通常是误报（站点按标题、作者有话说或词组联想出来的）。
         这种情况不用改正文，直接提交即可。`) + fromPageTip;

    await pushSide({
      mode: 'bad',
      bad: {
        title: miss && !hit ? '这些词在正文里根本找不到' : `站点提示 ${hit} 处敏感内容`,
        sub: '站点报出来的词',
        lead,
        items: analysis.items.map((it) => ({
          word: it.word,
          hit: it.hit,
          count: it.count,
          viaSquash: it.viaSquash,
          ctx: it.ctx,
          syn: window.BadWords.synonyms(it.word),
        })),
      },
    }, { open: true });
  }

  // ---------------------------------------------------------------- 处理与提交

  /** 侧栏传来的方案：数组下标与最后一次分析的 items 一一对应 */
  function planFromSide(plan) {
    if (!Array.isArray(plan) || !plan.length) return [];
    return plan.map((p, i) => {
      const it = state.analysis && state.analysis.items[i];
      return {
        word: (p && p.word) || (it && it.word) || '',
        mode: (p && p.mode) || 'skip',
      };
    });
  }

  /**
   * 一键处理：把选好的方案直接写进**页面正文**（读者看到的、站点提交的就是它），
   * 本地稿跟着同步。
   *
   * 这里刻意不再自动重投、也不做预览：
   * 作者自己点「发布这一章」，站点会重新校验一次，有没有词一目了然。
   * 预览那一层是多余的——页面本身就是所见即所得的预览。
   */
  async function applyToEditor(planArg) {
    const plan = planFromSide(planArg);
    if (!plan.length) return;
    const res = window.BadWords.applyPlan(state.baseText, plan);
    if (!res.changes.length) {
      await notice('info', '这一版方案不改动正文。可以点「直接提交」，或者在页面里手动改。');
      return;
    }

    const pairs = res.changes.map((c) => ({ from: c.from, to: c.to }));
    const list = res.changes
      .map((c) => (c.to === '' ? `删掉「${escapeHtml(c.from)}」` : `${escapeHtml(c.from)} → ${escapeHtml(c.to)}`))
      .join('、');

    // 1) 直接改页面里的正文：走编辑器替换，图片、分段这些格式原样保留
    let pageChanged = 0;
    let pageError = '';
    try {
      const r = await evalPage('pageReplaceInEditor', { pairs });
      if (r && r.ok) pageChanged = r.changed || 0;
      else pageError = (r && r.error) || '页面没有响应';
    } catch (err) {
      pageError = String((err && err.message) || err);
    }
    if (pageError) {
      await notice('error', '改页面正文失败：' + escapeHtml(pageError));
      return;
    }
    if (!pageChanged) {
      await notice('error', '页面正文里没找到这些词。'
        + '多半是这个词被换行或格式拆开了（例如「血」和「腥」在两个段落里），只能在页面上手动改一下。');
      return;
    }

    // 2) 本地那份跟着改，别出现「页面改了、码字台还是旧的」
    let localOk = true;
    try {
      await root.Writer.replaceText(res.text);
    } catch (_) { localOk = false; }
    state.baseText = res.text;
    state.analysis = null;

    // 3) 回到「已填入」状态：让作者自己再点发布，站点会重新校验
    let info = state.readyInfo;
    if (!info) {
      // 从页面上直接触发审核时没走过投递流程，用码字台的当前书/章兜一个
      const W = root.Writer;
      const b = W && W.currentBook ? W.currentBook() : null;
      const c = W && W.currentChapter ? W.currentChapter() : null;
      info = { bookName: (b && b.name) || '', chapterTitle: (c && c.title) || '', volName: (c && c.vol) || '', words: 0 };
    }
    let words = info.words || 0;
    try {
      const st = await evalPage('pageChapterState');
      if (st && st.ok && st.wordCount) words = st.wordCount;
    } catch (_) { /* 取不到就沿用原字数 */ }

    await showReadySide(Object.assign({}, info, { words }),
      `已经改好 <b>${pageChanged} 处</b>：${list}。`
      + (localOk ? '页面正文和本地稿都改了。' : '页面正文改了，本地稿没写成（不影响发布）。')
      + '<br>再点下面「发布这一章」，站点会重新校验一次。');
    toastHide();
  }

  async function forceSubmit() {
    toast('正在直接提交…', '不做任何修改，让站点按原样接收。');
    await hideSide();
    resetSide();
    const res = await evalPage('pageForceSubmit');
    if (!res || !res.ok) {
      toast('直接提交失败', escapeHtml((res && res.error) || '页面没有响应'));
      return;
    }
    // 提交是整页 POST，页面会跳走；这里只把状态记下来
    toast('已提交', '站点正在处理这一章。可以在「回到后台页面」里看到结果。');
    try { await root.Writer.markPublished({ chapterId: '' }); } catch (_) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 绑定

  function handleCommand(cmd) {
    const c = cmd || {};
    if (c.type === 'publish') {
      if (state.busy) return;
      state.busy = true;
      checkNow().finally(() => { state.busy = false; });
      return;
    }
    if (c.type === 'apply') {
      if (state.busy) return;
      state.busy = true;
      applyToEditor(c.plan).finally(() => { state.busy = false; });
      return;
    }
    if (c.type === 'force') { forceSubmit(); }
  }

  function bind() {
    // 页面停在新建章节页就自动接管发布按钮，之后即使你直接点页面上的按钮，也走这一套
    watchPageLoad();

    const btnPublish = $('#btnWriterPublish');
    if (btnPublish) btnPublish.addEventListener('click', publishCurrent);

    const close = $('#btnPublishToastClose');
    if (close) close.addEventListener('click', toastHide);

    const reopen = $('#btnPublishReopen');
    if (reopen) {
      reopen.addEventListener('click', async () => {
        if (typeof root.showBrowserKeepPage === 'function') await root.showBrowserKeepPage();
        else await window.api.browser.open({ x: 0, y: 0, width: 900, height: 700 });
      });
    }

    const toggle = $('#btnPubSide');
    if (toggle) toggle.addEventListener('click', toggleSide);

    // 侧栏只服务于码字台投递：切到别的页面就收起，回到码字台再放出来
    // （不然一个小窗一直浮在「概览/设置」上面挡视线）
    document.addEventListener('view-changed', (e) => {
      const name = (e && e.detail && e.detail.name) || '';
      if (name === 'writer') {
        if (state.sideParked && state.lastPayload && !state.sideOpen) {
          state.sideParked = false;
          pushSide(state.lastPayload, { open: true });
        }
        return;
      }
      if (state.sideOpen) {
        state.sideParked = true;
        hideSide();
      }
    });

    // 侧栏是独立窗口，主界面换主题时把主题推过去，别一半深一半浅
    document.addEventListener('theme-changed', () => {
      if (!state.lastPayload) return;
      pushSide(Object.assign({}, state.lastPayload, { theme: currentTheme() }));
    });

    const api = sideApi();
    if (api && api.onCommand) api.onCommand(handleCommand);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  root.Publish = {
    publishCurrent,
    showReadySide,
    openBadwordPanel,
    hideSide,
    toggleSide,
    applyToEditor,
    /** 供设置/调试用：设置定时发布时间（格式 Y-m-d H:i，空串为立即发布） */
    setSchedule(v) { state.schedule = String(v || ''); return state.schedule; },
    getSchedule() { return state.schedule; },
    state,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
