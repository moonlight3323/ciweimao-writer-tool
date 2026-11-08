/* 健康提醒 · 页面逻辑
 *
 * 只做两件事：喝水提醒、睡觉提醒。
 * 专注计时在「番茄钟」（pomodoro）插件里，两者独立开关。
 *
 * 时间一律用时间戳现算（存 lastAt / 比较当前时刻），不做累加，
 * 这样页面与常驻后台的 background.js 用同一套算法，天然同步。
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const APP = $('#app');

  const DEFAULTS = {
    waterMin: 45,
    sleep: '23:30',
    water: { lastAt: 0 },
  };

  let S = null;
  let tickTimer = null;
  let sleepFiredDay = '';

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  };

  /* ---------------- 数据 ---------------- */
  async function load() {
    const saved = await PluginAPI.storage.get('state').catch(() => null);
    const raw = saved || {};
    // 兼容旧版（番茄钟时代）遗留字段：那时 water 可能是个数字（更早的字段名）
    const legacyWaterMin = typeof raw.water === 'number' ? raw.water : null;

    // 只留本插件自己的三个键。
    // 1.0.7 及以前 state 里还有 work / rest / rounds / presets / timer / mode / ball，
    // 那些现在归「番茄钟」插件了，留在这里是死数据 —— 每次 save 还会把它们重新写回去。
    S = {
      waterMin: Number(raw.waterMin || legacyWaterMin) || DEFAULTS.waterMin,
      sleep: String(raw.sleep || DEFAULTS.sleep),
      water: Object.assign({}, DEFAULTS.water, (raw.water && typeof raw.water === 'object') ? raw.water : {}),
    };

    // 旧数据里带着番茄钟字段就顺手清掉一次，之后不再重复写
    if (Object.keys(raw).some((k) => !(k in S))) {
      await save();
    }
  }

  async function save() {
    await PluginAPI.storage.set('state', S).catch(() => {});
  }

  /* ---------------- 计算 ---------------- */
  function waterTotal() {
    return (Number(S.waterMin) || 45) * 60;
  }

  function waterRemain() {
    const total = waterTotal();
    if (!S.water.lastAt) return total;
    const elapsed = (Date.now() - Number(S.water.lastAt)) / 1000;
    return Math.max(0, total - elapsed);
  }

  function sleepText() {
    return String(S.sleep || DEFAULTS.sleep);
  }

  /** 距离睡觉时间还有多久；今天已过则算到明天 */
  function sleepHintText() {
    const now = new Date();
    const [h, m] = sleepText().split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return '—';
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    let diff = (target - now) / 1000;
    if (diff < 0) {
      target.setDate(target.getDate() + 1);
      diff = (target - now) / 1000;
    }
    const hours = Math.floor(diff / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    if (hours > 0) return `还有 ${hours} 小时 ${mins} 分`;
    return `还有 ${mins} 分`;
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    const wr = waterRemain();
    const total = waterTotal();
    const due = wr <= 0;

    const timeEl = $('#waterTime');
    timeEl.textContent = due ? '该喝水了' : fmt(wr);
    timeEl.classList.toggle('due', due);
    $('#waterState').textContent = due ? '已到点' : '还有';
    $('#waterBar').style.width = `${Math.min(100, Math.round((1 - wr / total) * 100))}%`;

    $('#sleepTime').textContent = sleepText();
    $('#sleepHint').textContent = sleepHintText();

    document.title = due ? '该喝水了 💧' : '健康提醒';
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

  /* ---------------- 主循环 ---------------- */
  function tick() {
    // 喝水到点：提示一次并重新计时（否则会一直弹）
    if (S.water.lastAt && waterRemain() <= 0) {
      S.water.lastAt = Date.now();
      save().catch(() => {});
      notify('该喝水了 💧');
    }
    checkSleep();
    render();
  }

  function checkSleep() {
    if (!S.sleep) return;
    const now = new Date();
    const [h, m] = sleepText().split(':').map(Number);
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (now.getHours() === h && now.getMinutes() === m && sleepFiredDay !== today) {
      sleepFiredDay = today;
      notify('该睡觉了 🌙');
    }
  }

  /* ---------------- 操作 ---------------- */
  async function drink() {
    S.water.lastAt = Date.now();
    await save();
    render();
    notify('已记下，重新计时 💧');
  }

  function fillSettings() {
    $('#inWater').value = S.waterMin;
    $('#inSleep').value = sleepText();
  }

  async function readSettings() {
    S.waterMin = clamp(+$('#inWater').value, 10, 240, 45);
    S.sleep = $('#inSleep').value || DEFAULTS.sleep;
    await save();
    render();
  }

  function clamp(v, min, max, dft) {
    if (!Number.isFinite(v)) return dft;
    return Math.min(max, Math.max(min, Math.round(v)));
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    $('#btnDrink').addEventListener('click', drink);
    $('#openSettings').addEventListener('click', openSettings);
    $('#openSettings2').addEventListener('click', openSettings);
    $('#closeSettings').addEventListener('click', closeSettings);

    ['#inWater', '#inSleep'].forEach((sel) => {
      $(sel).addEventListener('change', readSettings);
    });
  }

  function openSettings() {
    $('#settings').classList.remove('hidden');
    fillSettings();
  }

  function closeSettings() {
    $('#settings').classList.add('hidden');
  }

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    await load();
    if (PluginAPI.ready) await PluginAPI.ready;

    // 跟随宿主主题
    try {
      const info = await PluginAPI.app.info();
      document.documentElement.dataset.theme = info.theme === 'dark' ? 'dark' : 'light';
    } catch (_) {
      document.documentElement.dataset.theme = 'light';
    }

    bind();
    fillSettings();
    render();

    tickTimer = setInterval(tick, 1000);
    if (PluginAPI.on) {
      PluginAPI.on('dispose', () => clearInterval(tickTimer));
      PluginAPI.on('open', openSettings);
    }
  })();
})();
