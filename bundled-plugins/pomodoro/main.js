/* 番茄钟 · 页面逻辑
 *
 * 从「健康小助手」里拆出来的独立功能：只负责专注计时（工作 / 休息循环 + 节奏预设）。
 * 喝水提醒、睡觉提醒留在 health-helper，两者互不依赖、可分别开关。
 *
 * 计时全部基于时间戳计算（存 startedAt，每次现场算剩余），
 * 这样页面和常驻后台的 background.js 用同一套算法，天然同步，不怕 iframe 被挂起。
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const APP = $('#app');

  function notifyHost(event, payload = {}) {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'ciweimao-plugin-host-event', event, ...payload }, '*');
  }

  function isFloatingEmbed() {
    return document.documentElement.dataset.ciweimaoEmbed === 'floating';
  }

  let floatingEdge = 'br';
  let floatingBallOffset = { x: 12, y: 12 };

  async function updateFloatingPanel() {
    if (!PluginAPI.floating || !isFloatingEmbed()) return;
    const settingsOpen = !$('#settings').classList.contains('hidden');
    const popoverOpen = !$('#popover').classList.contains('hidden');
    await PluginAPI.floating.configure({
      widget: { width: 72, height: 72 },
      panel: settingsOpen ? { width: 520, height: 620 } : { width: 360, height: 280 },
    });
    await PluginAPI.floating.setExpanded(settingsOpen || popoverOpen || S.mode === 'sidebar');
  }

  window.addEventListener('ciweimao-plugin-embed-mode', (event) => {
    const detail = event.detail || {};
    if (detail.mode !== 'floating') return;
    if (detail.edge) floatingEdge = String(detail.edge);
    if (Number.isFinite(detail.ballX) && Number.isFinite(detail.ballY)) {
      floatingBallOffset = { x: detail.ballX, y: detail.ballY };
    }
    requestAnimationFrame(() => {
      if (S && S.mode === 'ball') placeBall();
      if (S && !$('#popover').classList.contains('hidden')) positionPopover();
    });
  });

  const DEFAULTS = {
    mode: 'ball',
    work: 25,
    rest: 5,
    rounds: 4,
    presets: [
      { name: '标准 25+5', work: 25, rest: 5, rounds: 4 },
      { name: '深读 40+10', work: 40, rest: 10, rounds: 3 },
    ],
    timer: { phase: 'idle', startedAt: 0, round: 1, pausedRemain: 0, pausedPhase: '' },
    ball: { x: null, y: null, edge: 'br' },
  };

  let S = null;
  let tickTimer = null;

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  };

  /* ---------------- 数据 ---------------- */
  async function load() {
    const saved = await PluginAPI.storage.get('state').catch(() => null);
    S = Object.assign({}, DEFAULTS, saved || {});
    S.timer = Object.assign({}, DEFAULTS.timer, S.timer || {});
    S.ball = Object.assign({}, DEFAULTS.ball, S.ball || {});
    if (!Array.isArray(S.presets)) S.presets = DEFAULTS.presets.slice();
  }

  async function save() {
    await PluginAPI.storage.set('state', S).catch(() => {});
  }

  /* ---------------- 计时计算 ---------------- */
  function phaseSeconds() {
    return (S.timer.phase === 'rest' ? S.rest : S.work) * 60;
  }

  function remainSec() {
    if (S.timer.phase === 'idle') {
      // 暂停过就显示剩余，否则是满值
      return Number(S.timer.pausedRemain) > 0 ? Number(S.timer.pausedRemain) : S.work * 60;
    }
    const elapsed = (Date.now() - Number(S.timer.startedAt || 0)) / 1000;
    return Math.max(0, phaseSeconds() - elapsed);
  }

  function progress() {
    const total = phaseSeconds();
    if (!total) return 0;
    return Math.min(1, Math.max(0, 1 - remainSec() / total));
  }

  /* ---------------- 相位推进 ---------------- */
  async function advance() {
    if (S.timer.phase === 'work') {
      S.timer.phase = 'rest';
      S.timer.startedAt = Date.now();
      S.timer.pausedRemain = 0;
      S.timer.pausedPhase = '';
      await save();
      notify('工作完成，休息一下 ☕');
    } else if (S.timer.phase === 'rest') {
      const next = Number(S.timer.round || 1) + 1;
      if (next > S.rounds) {
        S.timer.phase = 'idle';
        S.timer.round = 1;
        S.timer.startedAt = 0;
        await save();
        notify('全部轮次完成，今天辛苦了 🎉');
      } else {
        S.timer.phase = 'work';
        S.timer.round = next;
        S.timer.startedAt = Date.now();
        await save();
        notify(`第 ${next} 轮开始，专注 💪`);
      }
    }
  }

  function notify(text) {
    // 页面内提示（沙箱里没有系统通知）
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    APP.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    const rem = remainSec();
    const prog = progress();
    const pct = Math.round(prog * 100);
    const isRest = S.timer.phase === 'rest';
    const isIdle = S.timer.phase === 'idle';
    const phaseText = isIdle ? '准备开始' : isRest ? '休息中' : '专注中';

    // 侧边栏
    $('#sbPhase').textContent = phaseText;
    $('#sbTime').textContent = fmt(rem);
    $('#sbTime').className = 'sb-time' + (isRest ? ' rest' : '');
    $('#sbBar').style.width = `${pct}%`;
    $('#sbBar').className = isRest ? 'rest' : isIdle ? '' : 'work';
    $('#sbRound').textContent = `第 ${S.timer.round} / ${S.rounds} 轮`;
    $('#sbState').textContent = isIdle ? '待机' : isRest ? '放松一下' : '保持专注';
    $('#btnStart').textContent = isIdle ? '开始专注' : '暂停';

    // 悬浮球
    const circle = 2 * Math.PI * 44;
    $('#ballRing').style.strokeDasharray = String(circle);
    $('#ballRing').style.strokeDashoffset = String(circle * (1 - prog));
    $('#ballPct').textContent = `${pct}%`;
    $('#ballIcon').textContent = isRest ? '☕' : isIdle ? '⏸' : '🍅';
    $('#ball').classList.toggle('rest', isRest);

    // 弹窗
    $('#poPhase').textContent = phaseText;
    $('#poTime').textContent = fmt(rem);
    $('#poBar').style.width = `${pct}%`;
    $('#poBar').className = isRest ? 'rest' : isIdle ? '' : 'work';
    $('#poRound').textContent = `第 ${S.timer.round} / ${S.rounds} 轮`;
    $('#poHint').textContent = isIdle ? `${S.work}+${S.rest} 节奏` : (isRest ? '放松一下' : '保持专注');
    $('#poStart').textContent = isIdle ? '开始' : '暂停';

    document.title = isIdle ? '番茄钟' : `${fmt(rem)} · ${phaseText}`;
  }

  /* ---------------- 主循环 ---------------- */
  function tick() {
    // 到点推进
    if (S.timer.phase !== 'idle' && remainSec() <= 0) {
      advance().catch(() => {});
    }
    render();
  }

  /* ---------------- 操作 ---------------- */
  async function start() {
    if (S.timer.phase === 'idle') {
      // 从未开始 → 全新一轮；暂停后继续 → 从剩余处接着走
      const paused = Number(S.timer.pausedRemain) || 0;
      const isResume = paused > 0;
      S.timer.phase = isResume ? (S.timer.pausedPhase || 'work') : 'work';
      if (!isResume) S.timer.round = 1;
      const total = (S.timer.phase === 'rest' ? S.rest : S.work) * 60;
      const consumed = isResume ? Math.max(0, total - paused) : 0;
      S.timer.startedAt = Date.now() - consumed * 1000;
      S.timer.pausedRemain = 0;
      S.timer.pausedPhase = '';
    } else {
      // 暂停：把当前剩余记下来
      S.timer.pausedRemain = remainSec();
      S.timer.pausedPhase = S.timer.phase;
      S.timer.phase = 'idle';
      S.timer.startedAt = 0;
    }
    await save();
    render();
  }

  async function reset() {
    S.timer.phase = 'idle';
    S.timer.round = 1;
    S.timer.startedAt = 0;
    S.timer.pausedRemain = 0;
    S.timer.pausedPhase = '';
    await save();
    render();
  }

  /* ---------------- 形态切换 ---------------- */
  function setMode(mode) {
    S.mode = mode;
    APP.dataset.mode = mode;
    const ballOn = mode === 'ball';

    $('#sidebar').classList.toggle('hidden', ballOn);
    $('#ball').classList.toggle('hidden', !ballOn);
    if (!ballOn) $('#popover').classList.add('hidden');

    $$seg().forEach((b) => b.classList.toggle('active', b.dataset.v === mode));

    save();
    if (ballOn) requestAnimationFrame(placeBall);
    updateFloatingPanel().catch(() => {});
  }

  function $$seg() {
    const seg = $('#modeSeg');
    return seg ? Array.from(seg.querySelectorAll('button')) : [];
  }

  /* ---------------- 悬浮球拖动 & 吸附 ---------------- */
  let drag = null;

  function placeBall() {
    const ball = $('#ball');
    if (!ball || ball.classList.contains('hidden')) return;
    const rect = ball.getBoundingClientRect();
    const host = APP.getBoundingClientRect();
    let x = S.ball.x;
    let y = S.ball.y;
    if (isFloatingEmbed()) {
      const edge = floatingEdge || 'br';
      x = floatingBallOffset.x;
      y = floatingBallOffset.y;
      x = Math.min(Math.max(8, x), Math.max(8, host.width - rect.width - 8));
      y = Math.min(Math.max(8, y), Math.max(8, host.height - rect.height - 8));
      ball.style.left = `${x}px`;
      ball.style.top = `${y}px`;
      S.ball.x = x;
      S.ball.y = y;
      S.ball.edge = edge;
      return;
    }
    if (x == null || y == null) {
      x = host.width - rect.width - 24;
      y = host.height - rect.height - 24;
    }
    x = Math.min(Math.max(8, x), host.width - rect.width - 8);
    y = Math.min(Math.max(8, y), host.height - rect.height - 8);
    ball.style.left = `${x}px`;
    ball.style.top = `${y}px`;
    S.ball.x = x;
    S.ball.y = y;
    S.ball.edge = nearestEdge(x, y, host, rect);
  }

  function nearestEdge(x, y, host, rect) {
    const cx = x + rect.width / 2;
    const cy = y + rect.height / 2;
    const dl = cx;
    const dr = host.width - cx;
    const dt = cy;
    const db = host.height - cy;
    const min = Math.min(dl, dr, dt, db);

    if (min === dl && dt < host.height * 0.35) return 'tl';
    if (min === dr && dt < host.height * 0.35) return 'tr';
    if (min === dl && db < host.height * 0.35) return 'bl';
    if (min === dr && db < host.height * 0.35) return 'br';
    if (min === dl) return 'left';
    if (min === dr) return 'right';
    if (min === dt) return 'top';
    return 'bottom';
  }

  function positionPopover() {
    const ball = $('#ball');
    const pop = $('#popover');
    const br = ball.getBoundingClientRect();
    const host = APP.getBoundingClientRect();
    const pw = pop.offsetWidth || 240;
    const ph = pop.offsetHeight || 190;
    const GAP = 10;

    const edge = isFloatingEmbed() ? (floatingEdge || 'br') : (S.ball.edge || 'br');
    let left;
    let top;
    if (edge === 'tl' || edge === 'bl' || edge === 'left') left = br.right + GAP;
    else if (edge === 'tr' || edge === 'br' || edge === 'right') left = br.left - pw - GAP;
    else left = br.left + br.width / 2 - pw / 2;
    if (edge === 'tl' || edge === 'tr' || edge === 'top') top = br.top;
    else if (edge === 'bl' || edge === 'br' || edge === 'bottom') top = br.bottom - ph;
    else top = br.top + br.height / 2 - ph / 2;

    left = Math.min(Math.max(8, left), Math.max(8, host.width - pw - 8));
    top = Math.min(Math.max(8, top), Math.max(8, host.height - ph - 8));

    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function initBallDrag() {
    const ball = $('#ball');
    if (isFloatingEmbed() && PluginAPI.floating) {
      PluginAPI.floating.bindDrag(ball, {
        onClick: () => {
          $('#popover').classList.toggle('hidden');
          updateFloatingPanel().catch(() => {});
        },
      });
      return;
    }

    ball.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = ball.getBoundingClientRect();
      drag = {
        startX: e.clientX,
        startY: e.clientY,
        originX: rect.left,
        originY: rect.top,
        moved: false,
      };
      ball.setPointerCapture(e.pointerId);
      ball.classList.add('dragging');
      notifyHost('drag-start');
    });

    ball.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (!drag.moved) return;

      const host = APP.getBoundingClientRect();
      const rect = ball.getBoundingClientRect();
      const x = Math.min(Math.max(4, drag.originX + dx), host.width - rect.width - 4);
      const y = Math.min(Math.max(4, drag.originY + dy), host.height - rect.height - 4);
      ball.style.left = `${x}px`;
      ball.style.top = `${y}px`;
      notifyHost('drag-move', { dx, dy });
    });

    ball.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      ball.classList.remove('dragging');
      try { ball.releasePointerCapture(e.pointerId); } catch (_) {}

      if (moved) {
        const host = APP.getBoundingClientRect();
        const rect = ball.getBoundingClientRect();
        S.ball.x = rect.left;
        S.ball.y = rect.top;
        S.ball.edge = nearestEdge(rect.left, rect.top, host, rect);
        save();
        if (!$('#popover').classList.contains('hidden')) positionPopover();
        notifyHost('drag-end');
      } else {
        const pop = $('#popover');
        if (pop.classList.contains('hidden')) {
          pop.classList.remove('hidden');
          requestAnimationFrame(() => positionPopover());
        } else {
          pop.classList.add('hidden');
        }
        notifyHost('popover', { open: !pop.classList.contains('hidden') });
      }
    });
  }

  /* ---------------- 设置 ---------------- */
  function fillSettings() {
    $('#inWork').value = S.work;
    $('#inRest').value = S.rest;
    $('#inRounds').value = S.rounds;
    renderPresets();
  }

  function renderPresets() {
    const html = (S.presets || []).map((p, i) => `
      <button class="preset" data-i="${i}">
        <b>${escapeHtml(p.name)}</b>
        <small>${p.work}+${p.rest} · ${p.rounds} 轮</small>
        <span class="preset-del" data-del="${i}" title="删除">×</span>
      </button>
    `).join('') || '<span class="empty">还没有保存的节奏</span>';

    const a = $('#presetList');
    const b = $('#presetListFull');
    if (a) a.innerHTML = html;
    if (b) b.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function applyPreset(i) {
    const p = S.presets[i];
    if (!p) return;
    S.work = p.work;
    S.rest = p.rest;
    S.rounds = p.rounds;
    S.timer.phase = 'idle';
    S.timer.round = 1;
    S.timer.startedAt = 0;
    await save();
    fillSettings();
    render();
    notify(`已切换：${p.name}`);
  }

  async function readSettings() {
    S.work = clamp(+$('#inWork').value, 1, 180, 25);
    S.rest = clamp(+$('#inRest').value, 1, 60, 5);
    S.rounds = clamp(+$('#inRounds').value, 1, 12, 4);
    await save();
    render();
  }

  function clamp(v, min, max, dft) {
    if (!Number.isFinite(v)) return dft;
    return Math.min(max, Math.max(min, Math.round(v)));
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    $('#btnStart').addEventListener('click', start);
    $('#btnReset').addEventListener('click', reset);
    $('#poStart').addEventListener('click', start);
    $('#poReset').addEventListener('click', reset);
    $('#toBall').addEventListener('click', () => setMode('ball'));

    $('#openSettings').addEventListener('click', openSettings);
    $('#poSettings').addEventListener('click', openSettings);
    $('#closeSettings').addEventListener('click', closeSettings);

    $$seg().forEach((b) => {
      b.addEventListener('click', () => {
        setMode(b.dataset.v);
        // 切到悬浮球时关掉设置，否则球被遮住
        if (b.dataset.v === 'ball') closeSettings();
      });
    });

    ['#inWork', '#inRest', '#inRounds'].forEach((sel) => {
      $(sel).addEventListener('change', readSettings);
    });

    $('#btnSavePreset').addEventListener('click', async () => {
      const name = ($('#inPresetName').value || '').trim();
      if (!name) return notify('先给这套节奏起个名字');
      S.presets = S.presets || [];
      S.presets.unshift({ name, work: S.work, rest: S.rest, rounds: S.rounds });
      S.presets = S.presets.slice(0, 8);
      $('#inPresetName').value = '';
      await save();
      renderPresets();
      notify('已保存');
    });

    document.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        const i = Number(del.dataset.del);
        S.presets.splice(i, 1);
        await save();
        renderPresets();
        return;
      }
      const p = e.target.closest('.preset[data-i]');
      if (p) applyPreset(Number(p.dataset.i));
    });

    window.addEventListener('resize', () => {
      if (S.mode === 'ball') {
        placeBall();
        if (!$('#popover').classList.contains('hidden')) positionPopover();
      }
    });
  }

  function openSettings() {
    $('#settings').classList.remove('hidden');
    fillSettings();
    updateFloatingPanel().catch(() => {});
  }

  function closeSettings() {
    $('#settings').classList.add('hidden');
    updateFloatingPanel().catch(() => {});
  }

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    await load();
    if (PluginAPI.ready) await PluginAPI.ready;
    if (isFloatingEmbed()) S.mode = 'ball';

    // 跟随宿主主题
    try {
      const info = await PluginAPI.app.info();
      document.documentElement.dataset.theme = info.theme === 'dark' ? 'dark' : 'light';
    } catch (_) {
      document.documentElement.dataset.theme = 'light';
    }

    bind();
    initBallDrag();
    setMode(S.mode || 'ball');
    fillSettings();
    render();

    tickTimer = setInterval(tick, 500);
    if (PluginAPI.on) {
      PluginAPI.on('dispose', () => clearInterval(tickTimer));
      PluginAPI.on('open', openSettings);
    }
    await updateFloatingPanel();
    if (S.mode === 'ball') setTimeout(placeBall, 60);
  })();
})();
