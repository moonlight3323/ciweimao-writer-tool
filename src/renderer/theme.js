'use strict';

/**
 * 主题切换。
 *
 * 三档：light / dark / auto（跟随系统）。
 * 首帧由 theme-init.js 负责（同步、无闪烁），这里只管运行时切换与持久化。
 */
(function (root) {
  const KEY = 'ciweimao.theme';
  const MODES = ['light', 'dark', 'auto'];
  const LABEL = { light: '浅色', dark: '深色', auto: '跟随系统' };

  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  function mode() {
    const m = document.documentElement.dataset.themeMode;
    return MODES.indexOf(m) >= 0 ? m : 'light';
  }

  function effective(m) {
    if (m === 'auto') return mq.matches ? 'dark' : 'light';
    return m === 'dark' ? 'dark' : 'light';
  }

  function paint(m) {
    const eff = effective(m);
    const el = document.documentElement;
    el.dataset.theme = eff;
    el.dataset.themeMode = m;
    try { localStorage.setItem(KEY, m); } catch (_) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('theme-changed', {
      detail: { mode: m, effective: eff },
    }));
  }

  function set(m) {
    const next = MODES.indexOf(m) >= 0 ? m : 'light';
    paint(next);
    if (window.Prefs) window.Prefs.set('theme', next);
  }

  /** 侧栏按钮：在明暗之间直接切，auto 时按当前实际显示切到反面 */
  function toggle() {
    set(effective(mode()) === 'dark' ? 'light' : 'dark');
  }

  // 跟随系统时，系统换了配色要跟着变
  const onSystemChange = () => {
    if (mode() === 'auto') paint('auto');
  };
  if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
  else if (mq.addListener) mq.addListener(onSystemChange);

  /** 同步侧栏按钮与设置页三档按钮的显示状态 */
  function syncUi() {
    const m = mode();
    const eff = effective(m);

    const btn = document.getElementById('btnTheme');
    if (btn) {
      const icon = btn.querySelector('.theme-switch-icon');
      const text = btn.querySelector('.theme-switch-text');
      if (icon) icon.textContent = eff === 'dark' ? '☀' : '☾';
      if (text) text.textContent = eff === 'dark' ? '浅色模式' : '深色模式';
      btn.title = `当前：${LABEL[m]}${m === 'auto' ? `（实际${eff === 'dark' ? '深色' : '浅色'}）` : ''}　点击切换`;
    }

    const seg = document.getElementById('themeSeg');
    if (seg) {
      Array.prototype.forEach.call(seg.children, (b) => {
        b.classList.toggle('is-active', b.dataset.themeMode === m);
      });
    }
  }

  document.addEventListener('theme-changed', syncUi);

  /** 启动：把 localStorage 与 ui-prefs.json 对齐（换机器/清了缓存的场景） */
  async function boot() {
    syncUi();
    if (!window.Prefs) return;
    await window.Prefs.ready();
    const saved = window.Prefs.get('theme', null);
    let local = null;
    try { local = localStorage.getItem(KEY); } catch (_) { /* ignore */ }
    if (MODES.indexOf(saved) >= 0 && !local) set(saved);
    else if (MODES.indexOf(saved) >= 0 && saved !== local) paint(saved);
    else window.Prefs.set('theme', mode());
    syncUi();
  }

  const api = { set, toggle, mode, effective, boot, LABEL, MODES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Theme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
