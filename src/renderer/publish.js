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
    fromPage: false,
    /** 「已填入」状态的信息，处理完敏感词要拿它还原侧栏 */
    readyInfo: null,
    /** 最近一次推给侧栏的内容，点顶栏按钮重开时直接复用 */
    lastPayload: null,
    /** 待侧栏展示的一次性收集提示 { count }，展示过就清空 */
    pendingWordHint: null,
    sideOpen: false,
    /** 因为切页面被收起来的（回来时自动放出来） */
    sideParked: false,
    /** 第一次看到页面处于 pending 的时刻，用于宿主侧的超时兜底 */
    pendingSince: 0,
    /** 页面上一个发布按钮都没接管到（站点改版）—— 侧栏要据此换提示 */
    hookMissing: false,
  };

  function A() { return window.CiweimaoAdapter; }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------- 小工具

  /** 右下角发布提示的自动收起定时器 */
  let toastTimer = null;

  function toast(title, html) {
    const box = $('#publishToast');
    if (!box) return;
    box.hidden = false;
    $('#publishToastTitle').textContent = title;
    $('#publishToastBody').innerHTML = html || '';
    // 以前这个提示不会自己消失，切回创作中心还挂在右下角。
    // 现在给个上限，并且离开码字台时立刻收掉（见 view-changed）。
    clearTimeout(toastTimer);
    toastTimer = setTimeout(toastHide, 8000);
  }

  function toastHide() {
    clearTimeout(toastTimer);
    toastTimer = null;
    const box = $('#publishToast');
    if (box) box.hidden = true;
  }

  /* ---------------------------------------------------------- 顶栏状态条
   *
   * 为什么需要第二条反馈通道：后台页面是原生 WebContentsView，盖在 #content 之上，
   * 而上面那个 #publishToast 就住在 #content 里。页面一开，提示**确实弹了**，
   * 只是被整个盖住 —— 作者看到的就是「点了发布章节没反应」，可章节其实已经发出去了。
   * 顶栏在视图矩形之外，是唯一稳定可见的地方。
   *
   * 两条通道各管一段：页面开着时靠这里；退出后台之后 toast 照旧。
   */
  let statusTimer = null;

  /** 把带标签的提示文字压成一行纯文本，给顶栏用（那里只能显示单行） */
  function plain(s) {
    return String(s == null ? '' : s)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * @param {string} text 空串表示收起
   * @param {'busy'|'ok'|'error'|'info'} [kind]
   */
  function setStatus(text, kind) {
    const box = $('#pubStatus');
    const label = $('#pubStatusText');
    if (!box || !label) return;
    clearTimeout(statusTimer);
    statusTimer = null;
    if (!text) { box.hidden = true; return; }
    box.hidden = false;
    box.className = 'pub-status is-' + (kind || 'info');
    label.textContent = plain(text).slice(0, 60);
    // 完整内容放 title：顶栏只有一行，长原因要能悬停看全
    box.title = plain(text);
    // 出错和「进行中」都不自动收：分别是必须看到的结果、还没结束的过程
    if (kind === 'error' || kind === 'busy') return;
    statusTimer = setTimeout(() => { box.hidden = true; }, 15000);
  }

  async function evalPage(fnName, args, timeoutMs) {
    const code = A().pageSource(fnName, args);
    // 一定要给超时：页面跳转时这道 IPC 可能永远不回来（见 main.js 的注释），
    // 而轮询有 pollBusy 闸门，一次挂住就再也不查了。
    return window.api.browser.evalInPage(code, timeoutMs || 8000);
  }

  /**
   * 主窗口当前生效的主题，原样传给侧栏。
   *
   * 以前这里把非 dark 的一律折成 'light'，结果粉色主题传过去变浅色，
   * 侧栏怎么加变量都不会变——侧栏那边是按 data-theme 精确取值的。
   */
  function currentTheme() {
    return document.documentElement.dataset.theme || 'light';
  }

  /** 深色配色也一起传，否则主界面切成深蓝黑、侧栏还停在深黄黑 */
  function currentDarkTone() {
    return document.documentElement.dataset.darkTone || 'amber';
  }

  function versionText() {
    const el = document.querySelector('.version');
    const m = el ? String(el.textContent || '').match(/v([\d.]+)/) : null;
    return m ? m[1] : '';
  }

  // ---------------------------------------------------------------- 侧栏窗口

  function sideApi() { return window.api && window.api.pubside; }

  /** 收集开关：偏好里没表过态就按开处理（只存词本身，风险很低） */
  function collectEnabled() {
    try {
      if (window.Prefs) return window.Prefs.get('wordCollectOn', true) !== false;
    } catch (_) { /* 偏好读不到就按默认开 */ }
    return true;
  }

  /**
   * 把站点报出来的词记一份到本地库。
   *
   * 刻意**不**挂在任何按钮的回调里：收集与「怎么处理这些词」是两件事。
   * 用户点「一键处理」，或者索性关掉侧栏，都不该改变是否记录 ——
   * 所以调用点只有 checkNow() 一处，拿到响应就写。
   *
   * 任何失败都静默：写盘问题绝不能打断作者正在做的发布。
   */
  async function collectHintWords(res) {
    try {
      const raw = res && res.hintWords;
      if (!raw) return;
      if (!collectEnabled()) return;
      const words = window.BadWords ? window.BadWords.parseHint(raw) : [];
      if (!words || !words.length) return;

      const r = await window.api.badword.add(words);
      if (!r || !r.added) return; // 全是已有词，不用提示

      const shown = window.Prefs ? window.Prefs.get('wordCollectHintShown', false) : false;
      if (shown) return;

      state.pendingWordHint = { count: r.added };
      if (window.Prefs) window.Prefs.set('wordCollectHintShown', true);
      // 侧栏正开着就立刻推一次，让它把提示条画出来
      if (state.sideOpen && state.lastPayload) pushSide(state.lastPayload);
    } catch (e) {
      console.warn('[badword] 收集失败，已跳过：', e && e.message);
    }
  }

  /** 推给侧栏窗口；没开就打开它 */
  async function pushSide(payload, opts) {
    const o = opts || {};
    const api = sideApi();
    if (!api) return false;
    const full = Object.assign(
      {
        theme: currentTheme(),
        darkTone: currentDarkTone(),
        version: versionText(),
        // 收集开关与一次性提示统一在这里补，避免每个 pushSide 调用点各写一遍
        wordCollectOn: collectEnabled(),
        bwHint: state.pendingWordHint || null,
      },
      payload,
    );
    // transient = 只显示这一下，不进 lastPayload（否则关掉再打开还会看到旧错误）
    if (!o.transient) state.lastPayload = full;
    try {
      const btn = $('#btnPubSide');
      if (btn) btn.hidden = false;
      // 侧栏窗口可能被作者自己点 × 收掉了，而本地 sideOpen 还停在 true。
      // 只凭本地状态判断就会「给一个看不见的窗口推内容」——表现为点了
      // 「跳转后台并发布」侧栏不出现在，顶栏按钮也要点两下才有反应。
      // 所以每次推之前问一次真实可见性。
      let visible = state.sideOpen;
      try {
        const st = await api.isOpen();
        if (st) visible = !!st.visible;
      } catch (_) { /* 拿不到就按本地状态 */ }
      if (o.open || !visible) {
        await api.open(full);
        state.sideOpen = true;
        state.sideParked = false;
      } else {
        await api.setState(full);
        state.sideOpen = true;
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

  /** 这一章已经结束（发出去或已放弃），侧栏内容作废 */
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
    // 顶栏先给一句：侧栏和右下角提示都可能不在视线里（见 setStatus 注释）
    setStatus(text || '', kind === 'error' ? 'error' : 'info');
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
      const hooked = await ensureHook();
      startPoll();
      // 一个按钮都没接管上：说明站点改版了，页面上那个按钮点下去走的是站点原生流程，
      // 我们收不到任何结果。这种情况必须当场说出来，否则又变成「点了没反应」。
      state.hookMissing = !!(hooked && hooked.buttons === 0);

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
        // 没接管到按钮就换一句提示，别让人以为点页面上的按钮我们会接住
        note: state.hookMissing
          ? '<b>注意：</b>没认出页面上的发布按钮（站点可能改版了），'
            + '直接点它我们收不到结果，也就没法提示敏感词。请刷新一次后台页面再试。'
          : '',
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
        // 后台整个关掉了：停掉轮询，别一直对着空视图问下去。
        // 注意不能「一离开新建章节页就停」—— 发布成功时站点会自己跳走，
        // 结果正好靠 sessionStorage 跨页面留给宿主读，抢在前面停就丢掉了。
        if (!/^https:\/\/author\.ciweimao\.com\//i.test(ev.url || '')) {
          stopPoll();
          return;
        }
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

  function stopPoll() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
    state.pendingSince = 0;
  }

  async function pollOnce() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      // 轮询本身只做一次极短的读取，给它最紧的超时：卡住也要在一个周期内回来，
      // 否则 1.2 秒一次的轮询会被一次挂起的调用拖死。
      const r = await evalPage('pageReadCheck', undefined, 3000);

      // 页面侧虽然给 doCheck 加了 25 秒超时，但那是页面里的 timer：
      // 用户在等待期间自己点走（换页、点顶部导航、回列表），页面一卸载 timer 就没了，
      // 宿主这边永远等不到 done/error。所以宿主自己也记一笔开始时间。
      if (r && r.phase === 'pending') {
        if (!state.pendingSince) {
          state.pendingSince = Date.now();
          // 给一个看得见的回应：不然后台页面本身没有任何变化，
          // 用户完全无法判断「是不是点到了」
          noticeBusy();
        } else if (Date.now() - state.pendingSince > 30000) {
          state.pendingSince = 0;
          await evalPage('pageClearCheck').catch(() => {});
          await notice('error', '提交校验一直没有响应（30 秒），可能后台掉线了<br>'
            + '重新登录后再发一次；这期间如果页面已经跳走，说明其实已经发出去了，'
            + '先去「章节管理」看一眼，别重复提交。');
        }
        return;
      }
      state.pendingSince = 0;

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

  /**
   * 「正在提交校验」的临时提示：只在首次看到 pending 时推一次。
   *
   * 复用 ready 版式而不是新加一种 mode：侧栏只需要把标题换成「正在提交」，
   * 结构完全一样，多一个模式就多一处要跟着改的渲染分支。
   * transient 表示不进 lastPayload —— 这是过渡态，关掉再开不该还看到它。
   */
  function noticeBusy() {
    setStatus('正在提交校验…', 'busy');
    const info = state.readyInfo || {};
    pushSide({
      mode: 'ready',
      ready: {
        title: '正在提交校验',
        sub: '站点正在检查这一章，通常两秒内出结果',
        bookName: info.bookName || '—',
        chapterTitle: info.chapterTitle || '—',
        volName: info.volName || '—',
        words: info.words || 0,
        schedule: info.schedule || '',
        note: '',
      },
    }, { transient: true }).catch(() => { /* 侧栏没开就靠 toast */ });
    toast('正在提交校验', '站点正在检查这一章，稍等一下。');
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
    // 不管这次结果怎么处理，先把站点报出来的词记一份。
    // 以前这步挂在 checkNow()（侧栏「发布这一章」）里，现在那条路去掉了，
    // 页面按钮成了唯一入口，所以挪进来 —— 否则生词本从此收不到新词。
    await collectHintWords(res);
    dumpCheckDebug(res);
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
    setStatus('有敏感词，章节没发出去 · 看右侧侧栏', 'info');
    await openBadwordPanel(res, { fromPage: !!o.fromPage });
  }

  // ---------------------------------------------------------------- 校验

  /**
   * 站点返回的 hint_words 格式没有公开约定，留一份原文在 data/publish-debug.json，
   * 万一某天解析不出来，照这份改规则就行，不用再猜。
   * 任何失败都静默：写盘问题绝不能打断作者正在做的发布。
   */
  function dumpCheckDebug(res) {
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
  }

  async function onPublished(res) {
    await hideSide();
    resetSide();
    // 顶栏这条是作者唯一一定能看到的结果提示，失败过就换成明确结论
    setStatus('已发布成功 ✓', 'ok');
    toast('已提交成功', `<span class="is-ok">${escapeHtml(res.msg || '站点已接收这一章')}</span>`
      + '<br>如果开了审核，会先进入审核队列。');
    try {
      const cid = (String(res.url || '').match(/chapter_id=(\d+)/) || [])[1] || '';
      await root.Writer.markPublished({ chapterId: cid });
    } catch (_) { /* 标记失败不影响已发布的事实 */ }

    // 页面还停在新建章节页，说明站点没自己跳走（返回的 url 为空，或我们没接住）。
    // 这时候界面看起来和点之前一模一样 —— 作者会以为没发出去，再点一次就成了重复提交。
    // 主动把视图带到章节管理页，让「已经发布」这件事在页面本身也看得见。
    try {
      // 等一拍：页面侧在拿到 pass 后会自己跳（60ms 后），别和它抢
      await sleep(900);
      const st = await window.api.browser.state();
      const url = String((st && st.url) || '');
      const moving = !!(st && st.isLoading);
      if (!moving && /\/book_manage\/draft/i.test(url)) {
        const target = res.navTo
          || (state.bookId ? `/book_manage/view_chapter_info?book_id=${state.bookId}` : '');
        if (target) await window.api.browser.goto(target);
      }
    } catch (_) { /* 跳不过去也不影响顶栏那条结果 */ }

    // 这一章已经结束，轮询到此为止；下次回到新建章节页会重新接上
    stopPoll();
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
        sub: '确认无误后，点左边网页上的「发布章节」',
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
          lead: '站点提示有敏感内容，但没说是哪个词。这种只能自己判断：在后台页面里手动看一遍正文，改完再点「发布章节」。'
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
         这种情况不用改正文，直接去点「发布章节」即可。`) + fromPageTip;

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
   * 作者自己点页面上的「发布章节」，站点会重新校验一次，有没有词一目了然。
   * 预览那一层是多余的——页面本身就是所见即所得的预览。
   */
  async function applyToEditor(planArg) {
    const plan = planFromSide(planArg);
    if (!plan.length) return;
    const res = window.BadWords.applyPlan(state.baseText, plan);
    if (!res.changes.length) {
      await notice('info', '这一版方案不改动正文。在页面里手动改，或者直接去点「发布章节」。');
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
      + '<br>再点网页上的「发布章节」，站点会重新校验一次。');
    toastHide();
  }

  // ---------------------------------------------------------------- 绑定

  function handleCommand(cmd) {
    const c = cmd || {};
    if (c.type === 'apply') {
      if (state.busy) return;
      state.busy = true;
      applyToEditor(c.plan).finally(() => { state.busy = false; });
      return;
    }

    if (c.type === 'wordcollect-toggle') {
      if (window.Prefs) window.Prefs.set('wordCollectOn', !!c.on);
      // 回推一次，让侧栏复选框与真实偏好对齐（比如偏好写入被拒的情况）
      if (state.lastPayload) pushSide(state.lastPayload);
      return;
    }

    if (c.type === 'wordhint-shown') {
      state.pendingWordHint = null;
      return;
    }

    if (c.type === 'open-wordlib') {
      const nav = document.querySelector('.nav-item[data-view="settings"]');
      if (nav) nav.click();
      // 等视图切过去再滚，否则面板还是 hidden、滚动无效
      setTimeout(() => {
        const panel = document.querySelector('#panelWordlib');
        if (panel) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
        document.dispatchEvent(new CustomEvent('wordlib:refresh'));
      }, 80);
    }
  }

  function bind() {
    // 页面停在新建章节页就自动接管发布按钮，之后即使你直接点页面上的按钮，也走这一套
    watchPageLoad();

    const btnPublish = $('#btnWriterPublish');
    if (btnPublish) btnPublish.addEventListener('click', publishCurrent);

    const close = $('#btnPublishToastClose');
    if (close) close.addEventListener('click', toastHide);

    const statusClose = $('#btnPubStatusClose');
    if (statusClose) statusClose.addEventListener('click', () => setStatus(''));

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
    document.addEventListener('view-changed', async (e) => {
      const name = (e && e.detail && e.detail.name) || '';
      if (name === 'writer') {
        if (state.sideParked && state.lastPayload) {
          state.sideParked = false;
          pushSide(state.lastPayload, { open: true });
        }
        return;
      }
      // 离开码字台：右下角的发布提示也跟着收掉，别留在别的界面上
      toastHide();
      // 真去问一次窗口在不在——作者可能已经自己点 × 收掉了，
      // 这时不该记成「停放」，否则回到码字台会把它又弹出来
      let visible = state.sideOpen;
      try {
        const st = sideApi() && sideApi().isOpen ? await sideApi().isOpen() : null;
        if (st) visible = !!st.visible;
      } catch (_) { /* 拿不到就按本地状态 */ }
      if (visible) {
        state.sideParked = true;
        await hideSide();
      } else {
        state.sideOpen = false;
      }
    });

    // 侧栏是独立窗口，主界面换主题时把主题推过去，别一半深一半浅
    document.addEventListener('theme-changed', () => {
      if (!state.lastPayload) return;
      pushSide(Object.assign({}, state.lastPayload, {
        theme: currentTheme(),
        darkTone: currentDarkTone(),
      }));
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
