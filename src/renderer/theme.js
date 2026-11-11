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
  const Spec = root.ThemeSpec;
  let catalog = [];
  let catalogReady = false;
  let selectedPluginTheme = null;
  let activeRecipe = null;
  let savingSelection = Promise.resolve();
  try {
    const cached = JSON.parse(localStorage.getItem(Spec.CACHE_KEY) || 'null');
    selectedPluginTheme = Spec.selection(cached);
    if (selectedPluginTheme) {
      activeRecipe = Spec.theme(cached.recipe);
      if (activeRecipe.id !== selectedPluginTheme.themeId) throw new Error('主题缓存不一致');
    }
  } catch (_) {
    selectedPluginTheme = null;
    activeRecipe = null;
  }

  function variables() {
    return activeRecipe ? { ...activeRecipe.variables } : {};
  }

  function current() {
    return {
      mode: mode(), effective: effective(mode()), darkTone: darkTone(),
      pluginTheme: selectedPluginTheme ? { ...selectedPluginTheme } : null,
    };
  }

  function pluginThemes(pluginId) {
    return catalog.filter(item => !pluginId || item.pluginId === pluginId)
      .map(item => ({ ...item, variables: { ...item.variables } }));
  }

  function rememberPluginTheme() {
    try {
      if (selectedPluginTheme && activeRecipe) {
        // Keep large images in the data directory; cache only cheap first-frame colors and component styles.
        const recipe = { id: activeRecipe.id, name: activeRecipe.name, base: activeRecipe.base,
          variables: activeRecipe.variables, styles: activeRecipe.styles };
        localStorage.setItem(Spec.CACHE_KEY, JSON.stringify({ ...selectedPluginTheme, recipe }));
      } else {
        localStorage.removeItem(Spec.CACHE_KEY);
      }
    } catch (_) { /* 磁盘偏好仍会保留 */ }
    if (window.Prefs) {
      window.Prefs.set('pluginTheme', selectedPluginTheme ? { ...selectedPluginTheme } : null);
      savingSelection = window.Prefs.flushNow ? window.Prefs.flushNow() : Promise.resolve();
      savingSelection.catch(() => {
        document.dispatchEvent(new CustomEvent('theme-save-failed', {}));
      });
    }
  }

  function whenSaved() { return savingSelection; }

  function reconcilePluginTheme() {
    activeRecipe = selectedPluginTheme
      ? catalog.find(item => item.pluginId === selectedPluginTheme.pluginId && item.id === selectedPluginTheme.themeId) || null
      : null;
    if (!activeRecipe) selectedPluginTheme = null;
    rememberPluginTheme();
    paint(mode());
  }

  function registerPlugins(plugins) {
    catalog = [];
    for (const plugin of plugins) {
      if (!plugin.enabled || plugin.invalid) continue;
      try {
        for (const recipe of Spec.themes(plugin.contributes && plugin.contributes.themes)) {
          catalog.push({ ...recipe, pluginId: plugin.id, pluginName: plugin.name });
        }
      } catch (_) { /* 单个插件配置损坏时恢复可用的主题 */ }
    }
    catalogReady = true;
    reconcilePluginTheme();
  }

  function applyPlugin(pluginId, themeId) {
    const recipe = catalog.find(item => item.pluginId === pluginId && item.id === themeId);
    if (!recipe) throw new Error('主题未安装或插件已停用');
    activeRecipe = recipe;
    selectedPluginTheme = { pluginId, themeId };
    rememberPluginTheme();
    paint(mode());
    return current();
  }

  function resetPlugin() {
    selectedPluginTheme = null;
    activeRecipe = null;
    rememberPluginTheme();
    paint(mode());
    return current();
  }

  function mode() {
    const m = document.documentElement.dataset.themeMode;
    return MODES.indexOf(m) >= 0 ? m : 'light';
  }

  function effective(m) {
    if (activeRecipe) return activeRecipe.base;
    if (m === 'auto') return mq.matches ? 'dark' : 'light';
    if (m === 'dark') return 'dark';
    if (m === 'pink') return 'pink';
    return 'light';
  }

  /**
   * 主题切换瞬间压住过渡动画。
   *
   * 页面上有几十处 `transition: background/color .12s`。换主题时这些属性
   * 会各自淡变 120ms：侧栏、按钮、卡片会短暂停在旧颜色上，看起来就是
   * 「底色闪一下」。加一个只存在一两帧的类，让换色一步到位；
   * 之后恢复正常交互过渡（hover 等）不受影响。
   *
   * @returns {Function} 调用后在新样式绘制完成时移除该类
   */
  let switchToken = 0;
  function holdTransitions() {
    const el = document.documentElement;
    const token = ++switchToken;
    el.classList.add('is-theme-switching');
    return () => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (token === switchToken) el.classList.remove('is-theme-switching');
      }));
    };
  }

  /** 把窗口原生底色同步成当前主题，避免重绘空档露出上一套颜色 */
  function syncNativeBackground() {
    try {
      if (!window.api || !window.api.app || typeof window.api.app.setBackgroundColor !== 'function') return;
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (bg) window.api.app.setBackgroundColor(bg);
    } catch (_) { /* 同步失败不影响界面主题 */ }
  }

  function paint(m) {
    const eff = effective(m);
    const el = document.documentElement;
    const release = holdTransitions();
    el.dataset.theme = eff;
    el.dataset.themeMode = m;
    Spec.applyVariables(el, variables());
    if (selectedPluginTheme) {
      el.dataset.themePlugin = selectedPluginTheme.pluginId;
      el.dataset.themeId = selectedPluginTheme.themeId;
    } else {
      delete el.dataset.themePlugin;
      delete el.dataset.themeId;
    }
    if (root.ThemeSkin) root.ThemeSkin.apply(document, activeRecipe);
    // 深色两套配色：切明暗时把已选的配色重新打一次。
    // 只在 dark 下有意义，但一直挂着没有副作用（浅色块不读这个属性）。
    Tone.apply(darkTone());
    try { localStorage.setItem(KEY, m); } catch (_) { /* ignore */ }
    syncNativeBackground();
    document.dispatchEvent(new CustomEvent('theme-changed', {
      detail: { mode: m, effective: eff, darkTone: darkTone(), pluginTheme: current().pluginTheme },
    }));
    release();
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
    if (selectedPluginTheme) resetPlugin();
    const release = holdTransitions();
    const tone = Tone.apply(v);
    try { localStorage.setItem(Tone.KEY, tone); } catch (_) { /* ignore */ }
    if (window.Prefs) window.Prefs.set('darkTone', tone);
    syncNativeBackground();
    document.dispatchEvent(new CustomEvent('theme-changed', {
      detail: { mode: mode(), effective: effective(mode()), darkTone: tone },
    }));
    release();
    return tone;
  }

  function toggleDarkTone() {
    return setDarkTone(Tone.next(darkTone()));
  }

  function set(m) {
    const next = MODES.indexOf(m) >= 0 ? m : 'light';
    selectedPluginTheme = null;
    activeRecipe = null;
    paint(next);
    if (window.Prefs) window.Prefs.set('theme', next);
    rememberPluginTheme();
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
      btn.title = '当前：' + (activeRecipe ? activeRecipe.name : LABEL[m])
        + (m === 'auto' && !activeRecipe ? '（实际' + (eff === 'dark' ? '深色' : '浅色') + '）' : '')
        + '　点击切换';
    }

    const seg = document.getElementById('themeSeg');
    if (seg) {
      Array.prototype.forEach.call(seg.children, (b) => {
        b.classList.toggle('is-active', !selectedPluginTheme && b.dataset.themeMode === m);
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
        b.classList.toggle('is-active', !selectedPluginTheme && b.dataset.darkTone === darkTone());
      });
    }
    const select = document.getElementById('pluginThemeSelect');
    if (select) {
      select.replaceChildren();
      const builtin = document.createElement('option');
      builtin.value = '';
      builtin.textContent = '使用内置主题';
      select.appendChild(builtin);
      for (const item of catalog) {
        const option = document.createElement('option');
        option.value = item.pluginId + '/' + item.id;
        option.textContent = item.pluginName + ' · ' + item.name;
        select.appendChild(option);
      }
      select.value = selectedPluginTheme ? selectedPluginTheme.pluginId + '/' + selectedPluginTheme.themeId : '';
    }
    const reset = document.getElementById('btnPluginThemeReset');
    if (reset) reset.disabled = !selectedPluginTheme;
    const hint = document.getElementById('pluginThemeHint');
    if (hint) {
      hint.textContent = activeRecipe
        ? '当前使用 ' + activeRecipe.name + '，停用或删除对应插件后会恢复内置主题。'
        : '在功能中心导入主题插件后，可以在这里选择。';
    }
  }

  document.addEventListener('theme-changed', syncUi);

  /** 启动：把 localStorage 与 ui-prefs.json 对齐（换机器/清了缓存的场景） */
  async function boot() {
    syncUi();
    if (!window.Prefs) return;
    await window.Prefs.ready();
    const saved = window.Prefs.get('theme', null);
    const chosenMode = MODES.indexOf(saved) >= 0 ? saved : mode();
    if (MODES.indexOf(saved) < 0) window.Prefs.set('theme', chosenMode);

    // 配色的权威值在 ui-prefs.json；localStorage 只是为了首帧不闪
    const savedTone = window.Prefs.get('darkTone', null);
    if (Tone.TONES.indexOf(savedTone) >= 0) Tone.apply(savedTone);
    else window.Prefs.set('darkTone', darkTone());

    const savedSelection = Spec.selection(window.Prefs.get('pluginTheme', null));
    if (!savedSelection || !selectedPluginTheme
        || savedSelection.pluginId !== selectedPluginTheme.pluginId || savedSelection.themeId !== selectedPluginTheme.themeId) {
      activeRecipe = null;
    }
    selectedPluginTheme = savedSelection;
    document.documentElement.dataset.themeMode = chosenMode;
    if (catalogReady) reconcilePluginTheme();
    else paint(chosenMode);
    // LocalStorage only accelerates the first frame. The data directory is authoritative.
    if (!selectedPluginTheme) rememberPluginTheme();
  }

  const api = {
    set, toggle, mode, effective, boot, LABEL, MODES, darkTone, setDarkTone, toggleDarkTone,
    current, variables, pluginThemes, registerPlugins, applyPlugin, resetPlugin, whenSaved,
    skinCss: () => root.ThemeSkin ? root.ThemeSkin.css(activeRecipe, true) : '',
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Theme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
