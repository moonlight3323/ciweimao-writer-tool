/* 番茄钟 · 常驻后台
 *
 * 页面可能被切走（iframe 挂起），但倒计时不能停，
 * 所以这里用自己的定时器基于时间戳重算，再把数字推到两处：
 *   1. 码字台右侧的编辑区指标
 *   2. 宿主的全局悬浮球（只有选择悬浮球形态时才显示）
 *
 * 和页面共用同一份 storage 状态，各自按时间戳计算，天然同步。
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
    timer: { phase: 'idle', startedAt: 0, round: 1, pausedRemain: 0 },
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
    if (t.phase === 'idle') {
      const paused = Number(t.pausedRemain) || 0;
      return paused > 0 ? paused : (S.work || 25) * 60;
    }
    const elapsed = (Date.now() - Number(t.startedAt || 0)) / 1000;
    return Math.max(0, phaseSeconds() - elapsed);
  }

  async function push() {
    if (!S) return;

    const t = S.timer || {};
    const isIdle = t.phase === 'idle';
    const isRest = t.phase === 'rest';
    const rem = remainSec();

    const label = isIdle ? '🍅 番茄钟' : isRest ? '☕ 休息中' : '🍅 专注中';
    const value = fmt(rem);
    const total = Math.max(1, phaseSeconds());
    const progress = Math.round(Math.min(1, Math.max(0, 1 - rem / total)) * 360);

    const detail = isIdle
      ? `点「开始专注」进入 ${S.work || 25}+${S.rest || 5} 节奏`
      : `第 ${t.round || 1}/${S.rounds || 4} 轮`;

    await PluginAPI.ui.setEditorStat({ label, value, detail }).catch(() => {});

    if (PluginAPI.ui && typeof PluginAPI.ui.setFloatingWidget === 'function') {
      await PluginAPI.ui.setFloatingWidget({
        visible: S.mode === 'ball',
        title: '番茄钟',
        icon: isRest ? '☕' : isIdle ? '⏸' : '🍅',
        label: value,
        progress,
        state: isRest ? 'rest' : isIdle ? 'idle' : 'work',
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
