'use strict';

/**
 * 主题切换。
 *
 * 四档：light / pink / dark / auto（跟随系统）。
 * pink 是浅色系的配色变体（粉白 + 大圆角），切明暗时按「浅色」对待。
 * 首帧由 theme-init.js 负责（同步、无闪烁），这里只管运行时切换与持久化。
 */
(function (root) {
  const KEY = 'ciweimao.theme';
  const MODES = ['light', 'pink', 'dark', 'auto'];
  const LABEL = { light: '浅色', pink: '粉白', dark: '深色', auto: '跟随系统' };

  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  // 深色配色模块（dark-tone.js 必须在本文件之前加载，见 index.html 的脚本顺序）
  const Tone = root.DarkTone;

  function mode() {
    const m = document.documentElement.dataset.themeMode;
    return MODES.indexOf(m) >= 0 ? m : 'light';
  }

  function effective(m) {
    if (m === 'auto') return mq.matches ? 'dark' : 'light';
    if (m === 'dark') return 'dark';
    if (m === 'pink') return 'pink';
    return 'light';
  }

  function paint(m) {
    const eff = effective(m);
    const el = document.documentElement;
    el.dataset.theme = eff;
    el.dataset.themeMode = m;
    // 深色两套配色：切明暗时把已选的配色重新打一次。
    // 只在 dark 下有意义，但一直挂着没有副作用（浅色块不读这个属性）。
    Tone.apply(darkTone());
    try { localStorage.setItem(KEY, m); } catch (_) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('theme-changed', {
      detail: { mode: m, effective: eff, darkTone: darkTone() },
    }));
  }

  /** 当前深色配色（amber / blue） */
  function darkTone() {
    return Tone.current();
  }

  /**
   * 切深色配色。
   * 这里故意**不**顺手切到深色模式：用户可能正在浅色下先挑好配色再切深色，
   * 突然变黑会让人以为点错了按钮。
   */
  function setDarkTone(v) {
    const tone = Tone.apply(v);
    try { localStorage.setItem(Tone.KEY, tone); } catch (_) { /* ignore */ }
    if (window.Prefs) window.Prefs.set('darkTone', tone);
    document.dispatchEvent(new CustomEvent('theme-changed', {
      detail: { mode: mode(), effective: effective(mode()), darkTone: tone },
    }));
    return tone;
  }

  function toggleDarkTone() {
    return setDarkTone(Tone.next(darkTone()));
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

    // 创作中心工具栏的「深色」一键开关
    const wb = document.getElementById('btnWriterDark');
    if (wb) {
      const on = eff === 'dark';
      wb.classList.toggle('is-active', on);
      wb.textContent = on ? '☀ 浅色' : '☾ 深色';
      wb.title = on ? '切回浅色' : '一键切到深色（夜间码字更省眼）';
    }

    // 旁边那枚配色切换：只有深色下才有意义
    const tb = document.getElementById('btnWriterDarkTone');
    if (tb) {
      const tone = darkTone();
      tb.textContent = Tone.label(tone);
      tb.dataset.tone = tone;
      // 不用 disabled：淡显但仍可点，点下去会自动切到深色（见 app.js），
      // 否则浅色下看到一枚灰按钮，会以为这功能坏了
      tb.classList.toggle('is-dim', eff !== 'dark');
      tb.title = eff === 'dark'
        ? `当前是${Tone.desc(tone)}，点击换成${Tone.desc(Tone.next(tone))}`
        : `当前是${Tone.desc(tone)}，点击会切到深色并换成另一套`;
    }

    const toneSeg = document.getElementById('darkToneSeg');
    if (toneSeg) {
      Array.prototype.forEach.call(toneSeg.children, (b) => {
        b.classList.toggle('is-active', b.dataset.darkTone === darkTone());
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

    // 配色的权威值在 ui-prefs.json；localStorage 只是为了首帧不闪
    const savedTone = window.Prefs.get('darkTone', null);
    if (Tone.TONES.indexOf(savedTone) >= 0) setDarkTone(savedTone);
    else window.Prefs.set('darkTone', darkTone());

    syncUi();
  }

  const api = { set, toggle, mode, effective, boot, LABEL, MODES, darkTone, setDarkTone, toggleDarkTone };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Theme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
