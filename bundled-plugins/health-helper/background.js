/* 健康提醒 · 常驻后台
 *
 * 与页面共用同一份 storage 状态，靠时间戳各自计算，天然同步。
 * 这里只负责把「下次喝水」推到码字台右侧的指标面板。
 *
 * 不再挂悬浮球：悬浮球归「番茄钟」独占 —— 专注进度需要一直看得见，
 * 而喝水/睡觉本质是到点提醒，两个插件各挂一颗球会叠在一起。
 */
(() => {
  'use strict';

  const REFRESH_MS = 1000;   // 指标刷新
  const STORAGE_MS = 5000;   // 重新读设置的间隔

  let S = null;
  let lastRead = 0;

  const DEFAULT_STATE = {
    waterMin: 45,
    sleep: '23:30',
    water: { lastAt: 0 },
  };

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  };

  async function readState() {
    const saved = await PluginAPI.storage.get('state').catch(() => null);
    S = Object.assign({}, DEFAULT_STATE, saved || {});
    if (typeof S.water === 'number') { S.waterMin = S.water; S.water = { lastAt: 0 }; }
    S.water = Object.assign({}, DEFAULT_STATE.water, S.water || {});
    S.waterMin = Number(S.waterMin) || 45;
    if (!saved) await PluginAPI.storage.set('state', S).catch(() => {});
    lastRead = Date.now();
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

    const wr = waterRemain();
    const due = wr <= 0;
    const value = due ? '该喝水' : fmt(wr);
    const detail = due
      ? '点开插件点「我喝了」重新计时'
      : `每 ${S.waterMin || 45} 分钟提醒 · 睡觉 ${S.sleep || '23:30'}`;

    await PluginAPI.ui.setEditorStat({
      label: due ? '💧 该喝水' : '💧 下次喝水',
      value,
      detail,
    }).catch(() => {});
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
