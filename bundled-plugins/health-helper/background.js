/* 健康小助手 · 常驻后台
 * 与页面共用同一份 storage 状态，靠时间戳各自计算，天然同步。
 * 这里负责把倒计时推到码字台右侧的指标面板，并在选择悬浮球模式时
 * 推送给宿主的全局悬浮组件。
 */
(() => {
  'use strict';

  const REFRESH_MS = 1000;   // 指标刷新
  const STORAGE_MS = 5000;   // 重新读设置的间隔

  let S = null;
  let lastRead = 0;

  const DEFAULT_STATE = {
    mode: 'ball',
    work: 25,
    rest: 5,
    rounds: 4,
    waterMin: 45,
    timer: { phase: 'idle', startedAt: 0, round: 1, pausedRemain: 0 },
    water: { lastAt: 0 },
    ball: { edge: 'br' },
  };

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  };

  async function readState() {
    const saved = await PluginAPI.storage.get('state').catch(() => null);
    S = Object.assign({}, DEFAULT_STATE, saved || {});
    S.timer = Object.assign({}, DEFAULT_STATE.timer, S.timer || {});
    S.water = Object.assign({}, DEFAULT_STATE.water, S.water || {});
    S.ball = Object.assign({}, DEFAULT_STATE.ball, S.ball || {});
    if (!saved) await PluginAPI.storage.set('state', S).catch(() => {});
    lastRead = Date.now();
  }

  function phaseSeconds() {
    if (!S) return 0;
    const t = S.timer || {};
    return (t.phase === 'rest' ? (S.rest || 5) : (S.work || 25)) * 60;
  }

  function remainSec() {
    if (!S) return 0;
    const t = S.timer || {};
    if (t.phase === 'idle') return (S.work || 25) * 60;
    const elapsed = (Date.now() - Number(t.startedAt || 0)) / 1000;
    return Math.max(0, phaseSeconds() - elapsed);
  }

  function waterRemain() {
    if (!S) return 0;
    const total = (Number(S.waterMin) || 45) * 60;
    const last = (S.water || {}).lastAt;
    if (!last) return total;
    const elapsed = (Date.now() - Number(last)) / 1000;
    return Math.max(0, total - elapsed);
  }

  async function push() {
    if (!S) return;

    const t = S.timer || {};
    const isIdle = t.phase === 'idle';
    const isRest = t.phase === 'rest';
    const rem = remainSec();
    const wr = waterRemain();

    const label = isIdle ? '🍅 健康助手' : isRest ? '☕ 休息中' : '🍅 专注中';
    const value = fmt(rem);
    const total = Math.max(1, phaseSeconds());
    const progress = Math.round(Math.min(1, Math.max(0, 1 - rem / total)) * 360);

    let detail;
    if (isIdle) {
      detail = `点「开始专注」进入 ${S.work || 25}+${S.rest || 5} 节奏`;
    } else {
      const round = `第 ${t.round || 1}/${S.rounds || 4} 轮`;
      detail = wr <= 0 ? `${round} · 💧 该喝水了` : `${round} · 下次喝水 ${fmt(wr)}`;
    }

    await PluginAPI.ui.setEditorStat({ label, value, detail }).catch(() => {});
    if (PluginAPI.ui && typeof PluginAPI.ui.setFloatingWidget === 'function') {
      const state = wr <= 0 ? 'due' : isRest ? 'rest' : isIdle ? 'idle' : 'work';
      await PluginAPI.ui.setFloatingWidget({
        visible: S.mode === 'ball',
        title: '健康小助手',
        icon: isRest ? '☕' : isIdle ? '⏸' : '🍅',
        label: value,
        progress,
        state,
        edge: S.ball && S.ball.edge,
      }).catch(() => {});
    }
  }

  async function loop() {
    if (!S || Date.now() - lastRead > STORAGE_MS) {
      await readState();
    }
    await push();
  }

  (async function boot() {
    await readState();
    await push();
    setInterval(loop, REFRESH_MS);
  })();
})();
