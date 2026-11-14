'use strict';

/**
 * 敏感词侧栏（独立悬浮窗）的渲染与交互。
 *
 * 这里**不做业务判断**：词表、命中位置、近义候选都是主窗口算好后推过来的
 * （业务逻辑只有一份，在 renderer/publish.js + badwords.js 里）。
 * 本窗口只负责：把状态画出来、收集作者的选择、把动作发回主窗口。
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const api = window.sideApi;

  const state = {
    mode: '',
    items: [],
    plan: [],
    /** 上次用过的处理方式：默认插点，删词破坏性大不擅自当默认 */
    lastMode: 'dot',
    ready: null,
    /** 当前列表的内容指纹：内容没变时不要重建 DOM，否则会把作者选好的方案重置 */
    badKey: '',
    busy: false,
    /** 本次打开期间用户是否手动关掉了收集提示条 */
    hintClosed: false,
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------- 渲染

  function renderReady(payload) {
    const r = payload.ready || {};
    state.ready = r;
    $('#psReady').hidden = false;
    $('#psBadword').hidden = true;
    $('#psActionsBad').hidden = true;
    $('#bwTitle').textContent = r.title || '已填入后台';
    $('#psSub').textContent = r.sub || '在左边页面上确认后再发布';
    $('#psBookName').textContent = r.bookName || '—';
    $('#psChapterTitle').textContent = r.chapterTitle || '—';
    $('#psVol').textContent = r.volName || '—';
    $('#psWords').textContent = `${r.words || 0} 字`;
    const row = $('#psScheduleRow');
    if (r.schedule) { row.hidden = false; $('#psSchedule').textContent = r.schedule; }
    else row.hidden = true;

    const note = $('#psReadyNote');
    if (r.note) { note.hidden = false; note.innerHTML = r.note; }
    else note.hidden = true;

    state.mode = 'ready';
  }

  function renderBad(payload) {
    const b = payload.bad || {};
    const items = b.items || [];
    state.items = items;
    // 命中词默认按上次用的方式处理；正文里找不到的（疑似误报）默认不改
    state.plan = items.map((it) => (it.hit ? state.lastMode : 'skip'));

    $('#psReady').hidden = true;
    $('#psBadword').hidden = false;
    $('#psActionsBad').hidden = false;
    $('#bwTitle').textContent = b.title || '站点报出来的词';
    $('#psSub').textContent = b.sub || '站点报出来的词';
    $('#bwLead').innerHTML = b.lead || '';

    $('#bwList').innerHTML = items.map((it, i) => {
      const ctx = it.ctx
        ? `${esc(it.ctx.before)}<mark>${esc(it.ctx.hit)}</mark>${esc(it.ctx.after)}`
        : '<span class="bw-none">正文里没有出现</span>';
      const tag = it.hit
        ? `<span class="bw-tag is-hit">出现 ${it.count || '（跨段）'} 次</span>`
        : '<span class="bw-tag is-miss">正文里没有</span>';
      const syn = it.syn || [];
      const dis = it.hit ? '' : 'disabled';
      const mode = state.plan[i];
      return `<div class="bw-item" data-i="${i}">
        <div class="bw-item-word">${esc(it.word)}</div>
        <div class="bw-item-main">
          <div class="bw-item-meta">${tag}</div>
          <div class="bw-ctx">${ctx}</div>
        </div>
        <div class="bw-item-choice">
          <label><input type="radio" name="bw${i}" value="dot" ${mode === 'dot' ? 'checked' : ''} ${dis}> 插「.」</label>
          <label><input type="radio" name="bw${i}" value="synonym" ${mode === 'synonym' ? 'checked' : ''} ${it.hit && !syn.length ? 'disabled' : dis}> 近义${syn.length ? `（${esc(syn[0])}）` : ''}</label>
          <label title="把这个词从正文里直接删掉"><input type="radio" name="bw${i}" value="del" ${mode === 'del' ? 'checked' : ''} ${dis}> 删</label>
          <label><input type="radio" name="bw${i}" value="skip" ${it.hit ? '' : 'checked'}> 不改</label>
        </div>
      </div>`;
    }).join('');

    $('#bwList').querySelectorAll('input[type=radio]').forEach((r) => {
      r.addEventListener('change', () => {
        const i = Number(r.closest('.bw-item').dataset.i);
        if (state.plan[i] !== undefined) state.plan[i] = r.value;
        if (r.value !== 'skip') {
          state.lastMode = r.value;
          syncModeButtons(r.value);
        }
        updateSummary();
      });
    });

    state.mode = 'bad';
    syncModeButtons(state.lastMode);
    state.busy = false;
    updateSummary();
  }

  function syncModeButtons(mode) {
    $('#bwMode').querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.mode === mode);
    });
  }

  /** 底部三个批量按钮：把「正文里出现过」的词全改成这一种方式 */
  function applyModeToAll(mode) {
    state.lastMode = mode;
    $('#bwList').querySelectorAll('.bw-item').forEach((row) => {
      const i = Number(row.dataset.i);
      const input = row.querySelector(`input[value="${mode}"]`);
      if (!input || input.disabled) return;
      input.checked = true;
      state.plan[i] = mode;
    });
    syncModeButtons(mode);
    updateSummary();
  }

  /**
   * 没有预览，这里只算「会改几处」标在按钮上。
   * 处数用主窗口给的 count（词在正文里出现的次数），跨段命中的 count 是 0 ——
   * 那种情况本来就替换不到，不计入是对的。
   */
  function updateSummary() {
    let spots = 0;
    state.items.forEach((it, i) => {
      if (!it.hit) return;
      const mode = state.plan[i];
      if (mode === 'skip') return;
      spots += Number(it.count || 0);
    });
    const btn = $('#btnBwApply');
    btn.disabled = spots === 0;
    btn.textContent = spots ? `一键处理（改 ${spots} 处）` : '没有可改的地方，直接去点「发布章节」';
    return spots;
  }

  // ---------------------------------------------------------------- 提示条

  function showNotice(n) {
    const box = $('#sideNotice');
    if (!box || !n) return;
    const text = String(n.text || '').trim();
    if (!text) { box.hidden = true; return; }
    $('#sideNotice').dataset.kind = n.kind === 'error' ? 'error' : 'info';
    $('#sideNoticeText').innerHTML = text;
    box.hidden = false;
    setBusy(false);
  }

  function hideNotice() {
    const box = $('#sideNotice');
    if (box) box.hidden = true;
  }

  /** 处理中：按钮压住，避免连点两次把正文改两遍 */
  function setBusy(on) {
    state.busy = !!on;
    const force = $('#btnBwForce');
    if (force) {
      force.disabled = !!on;
      force.textContent = on ? '正在提交…' : '这些词是误报，仍然发布 →';
    }
    const btn = $('#btnBwApply');
    if (!btn) return;
    if (on) {
      btn.disabled = true;
      btn.textContent = '正在处理…';
    } else if (state.mode === 'bad') {
      updateSummary();
    }
  }

  /** 列表内容指纹：只有词表真的变了才重建，提示条不会冲掉已选方案 */
  function itemsKey(items) {
    return (items || []).map((i) => `${i.word}|${i.hit ? 1 : 0}|${i.count || 0}`).join(',');
  }

  function render(payload) {
    if (!payload) return;
    if (payload.theme) document.documentElement.dataset.theme = payload.theme;
    if (payload.darkTone) document.documentElement.dataset.darkTone = payload.darkTone;
    if (window.ThemeSpec) {
      try { window.ThemeSpec.applyVariables(document.documentElement, payload.themeVariables); }
      catch (_) { window.ThemeSpec.applyVariables(document.documentElement, {}); }
    }
    if (payload.version) document.title = `敏感词侧栏 · v${payload.version}`;

    if (payload.mode === 'bad') {
      const key = itemsKey((payload.bad || {}).items);
      if (key !== state.badKey) {
        state.badKey = key;
        hideNotice();
        renderBad(payload);
      } else {
        // 词表没变：只刷新说明文字，别动列表与已选方案
        if (payload.bad && payload.bad.lead) $('#bwLead').innerHTML = payload.bad.lead;
        if (payload.bad && payload.bad.title) $('#bwTitle').textContent = payload.bad.title;
      }
    } else {
      state.badKey = '';
      hideNotice();
      renderReady(payload);
    }

    if (payload.notice) showNotice(payload.notice);
    syncCollect(payload);
  }

  // -------------------------------------------------------- 收集开关与提示

  /**
   * 收集开关与一次性提示。
   *
   * 开关的真实值存在主窗口的 ui-prefs 里，这边只负责画出来并回传点击；
   * 提示条由主窗口决定要不要给（它知道是不是第一次收集）。
   */
  function syncCollect(payload) {
    const box = $('#bwCollectOn');
    if (box) box.checked = !(payload && payload.wordCollectOn === false);

    const hint = payload && payload.bwHint;
    if (!hint || !hint.count) return;
    if (state.hintClosed) return;
    const bar = $('#bwCollectHint');
    if (!bar || !bar.hidden) return; // 已经显示过就不再重复推

    $('#bwCollectHintText').textContent =
      `已收集 ${hint.count} 个词，可在「设置 → 敏感词库」查看`;
    bar.hidden = false;
    // 回执：主窗口收到就把待展示的提示清掉，避免下次开侧栏又冒出来
    api.command({ type: 'wordhint-shown' });
  }

  // ---------------------------------------------------------------- 动作

  function sendPlan() {
    return state.items.map((it, i) => ({ word: it.word, mode: state.plan[i] }));
  }

  $('#btnBwApply').addEventListener('click', () => {
    if (state.busy || $('#btnBwApply').disabled) return;
    setBusy(true);
    api.command({ type: 'apply', plan: sendPlan(), lastMode: state.lastMode });
  });

  // 站点报的词在正文里根本找不到（误报），作者想直接发出去时走这条
  $('#btnBwForce').addEventListener('click', () => {
    if (state.busy) return;
    setBusy(true);
    api.command({ type: 'force-publish' });
  });

  $('#bwMode').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => applyModeToAll(b.dataset.mode));
  });

  $('#btnSideClose').addEventListener('click', () => api.hide());
  $('#btnNoticeClose').addEventListener('click', hideNotice);

  $('#bwCollectOn').addEventListener('change', (e) => {
    api.command({ type: 'wordcollect-toggle', on: !!e.target.checked });
  });

  $('#bwCollectClose').addEventListener('click', () => {
    state.hintClosed = true;
    $('#bwCollectHint').hidden = true;
  });

  $('#bwCollectGo').addEventListener('click', () => {
    api.command({ type: 'open-wordlib' });
    api.hide();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.hide();
  });

  if (api && api.onState) api.onState(render);
})();
