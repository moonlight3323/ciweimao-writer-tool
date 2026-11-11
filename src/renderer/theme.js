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
  // 扩展被停用（但主题还声明着）时，用户的选择先存在这里：界面回到内置配色，
  // 偏好里却仍记着「我想要哪套」，重新启用后自动恢复。删除扩展才会真的清掉。
  let pendingSelection = null;
  // 当前清单里所有扩展声明过的主题（含已停用的），用来区分「暂时不可用」和「已被删除」
  let knownThemes = new Set();
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
    // 写回偏好的是「用户想要哪套」：正在生效的选择优先，其次是扩展停用期间暂存的。
    // 只写当前生效的会在停用那一刻把选择抹掉，重新启用就恢复不回来了。
    const desired = selectedPluginTheme || pendingSelection;
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
      window.Prefs.set('pluginTheme', desired ? { ...desired } : null);
      savingSelection = window.Prefs.flushNow ? window.Prefs.flushNow() : Promise.resolve();
      savingSelection.catch(() => {
        document.dispatchEvent(new CustomEvent('theme-save-failed', {}));
      });
    }
  }

  function whenSaved() { return savingSelection; }

  /**
   * 把「用户想要的主题」与「当前可用的主题」对齐。
   *
   * 三种结局：
   * 1. 插件启用了、主题还在 → 生效；
   * 2. 插件被停用（主题仍在清单里声明）→ 先回退内置配色，但把选择暂存到
   *    pendingSelection，偏好照旧保留，重新启用时自动恢复；
   * 3. 插件或主题已被删除 → 选择是真失效了，清干净。
   *
   * 之前少了第 2 种，停用插件会把选择写成 null，再打开就什么都没了。
   */
  function reconcilePluginTheme() {
    const wanted = pendingSelection || selectedPluginTheme;
    pendingSelection = null;
    const key = wanted ? wanted.pluginId + '/' + wanted.themeId : '';
    const found = key
      ? catalog.find(item => item.pluginId === wanted.pluginId && item.id === wanted.themeId) || null
      : null;
    activeRecipe = found;
    selectedPluginTheme = found ? { pluginId: wanted.pluginId, themeId: wanted.themeId } : null;
    if (!found && key && knownThemes.has(key)) {
      pendingSelection = { pluginId: wanted.pluginId, themeId: wanted.themeId };
    }
    rememberPluginTheme();
    paint(mode());
  }

  function registerPlugins(plugins) {
    catalog = [];
    const known = new Set();
    for (const plugin of plugins) {
      if (plugin.invalid) continue;
      let themes;
      // 单个插件配置损坏时跳过它，既不注册也不登记，免得拿坏配方去恢复
      try { themes = Spec.themes(plugin.contributes && plugin.contributes.themes); }
      catch (_) { continue; }
      for (const recipe of themes) {
        known.add(plugin.id + '/' + recipe.id);
        if (plugin.enabled) catalog.push({ ...recipe, pluginId: plugin.id, pluginName: plugin.name });
      }
    }
    knownThemes = known;
    catalogReady = true;
    reconcilePluginTheme();
  }

  function applyPlugin(pluginId, themeId) {
    const recipe = catalog.find(item => item.pluginId === pluginId && item.id === themeId);
    if (!recipe) throw new Error('主题未安装或插件已停用');
    activeRecipe = recipe;
    selectedPluginTheme = { pluginId, themeId };
    pendingSelection = null;
    rememberPluginTheme();
    paint(mode());
    return current();
  }

  function resetPlugin() {
    selectedPluginTheme = null;
    pendingSelection = null;
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
   * 扩展主题（美化包）是否正在接管配色。
   *
   * 美化包的整套颜色写在主题配方里，切内置明暗会走 set()/setDarkTone()，
   * 那两条路径本来就会把 selectedPluginTheme 清空——表现出来就是「点了
   * 一下深浅，美化包直接没了」。所以只要有扩展主题在生效，内置的明暗与
   * 配色入口一律锁住：按钮置灰不可点，API 层也不生效，双保险。
   */
  function builtinLocked() {
    return !!selectedPluginTheme;
  }

  /** 锁定时给按钮和提示文案用的说明 */
  function builtinLockTip() {
    return '已启用扩展主题「' + (activeRecipe ? activeRecipe.name : '未知主题')
      + '」，深浅切换已锁定；在设置 → 外观里选「使用内置主题」后恢复';
  }

  /**
   * 切深色配色。
   * 这里故意**不**顺手切到深色模式：用户可能正在浅色下先挑好配色再切深色，
   * 突然变黑会让人以为点错了按钮。
   */
  function setDarkTone(v) {
    if (builtinLocked()) return darkTone();
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

  /** 切内置主题档位；扩展主题生效时直接忽略（否则会把美化包整体撤掉） */
  function set(m) {
    if (builtinLocked()) return false;
    const next = MODES.indexOf(m) >= 0 ? m : 'light';
    selectedPluginTheme = null;
    activeRecipe = null;
    paint(next);
    if (window.Prefs) window.Prefs.set('theme', next);
    rememberPluginTheme();
    return true;
  }

  /** 侧栏按钮：在明暗之间直接切，auto 时按当前实际显示切到反面 */
  function toggle() {
    return set(effective(mode()) === 'dark' ? 'light' : 'dark');
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
    const locked = builtinLocked();
    const lockTip = locked ? builtinLockTip() : '';

    const btn = document.getElementById('btnTheme');
    if (btn) {
      const icon = btn.querySelector('.theme-switch-icon');
      const text = btn.querySelector('.theme-switch-text');
      if (icon) icon.textContent = eff === 'dark' ? '☀' : '☾';
      if (text) text.textContent = eff === 'dark' ? '浅色模式' : '深色模式';
      btn.disabled = locked;
      btn.classList.toggle('is-locked', locked);
      btn.title = locked ? lockTip
        : '当前：' + (activeRecipe ? activeRecipe.name : LABEL[m])
          + (m === 'auto' && !activeRecipe ? '（实际' + (eff === 'dark' ? '深色' : '浅色') + '）' : '')
          + '　点击切换';
    }

    const seg = document.getElementById('themeSeg');
    if (seg) {
      Array.prototype.forEach.call(seg.children, (b) => {
        b.disabled = locked;
        b.classList.toggle('is-active', !locked && b.dataset.themeMode === m);
      });
      seg.title = lockTip;
    }

    // 创作中心工具栏的「深色」一键开关
    const wb = document.getElementById('btnWriterDark');
    if (wb) {
      const on = eff === 'dark';
      wb.disabled = locked;
      wb.classList.toggle('is-locked', locked);
      wb.classList.toggle('is-active', on && !locked);
      wb.textContent = on ? '☀ 浅色' : '☾ 深色';
      wb.title = locked ? lockTip
        : (on ? '切回浅色' : '一键切到深色（夜间码字更省眼）');
    }

    // 旁边那枚配色切换：只有深色下才有意义
    const tb = document.getElementById('btnWriterDarkTone');
    if (tb) {
      const tone = darkTone();
      tb.textContent = Tone.label(tone);
      tb.dataset.tone = tone;
      tb.disabled = locked;
      tb.classList.toggle('is-locked', locked);
      // 不用 disabled 表达「当前不是深色」：淡显但仍可点，点下去会自动切到深色（见 app.js），
      // 否则浅色下看到一枚灰按钮，会以为这功能坏了。扩展主题生效时才是真的禁用。
      tb.classList.toggle('is-dim', eff !== 'dark');
      tb.title = locked ? lockTip
        : eff === 'dark'
          ? `当前是${Tone.desc(tone)}，点击换成${Tone.desc(Tone.next(tone))}`
          : `当前是${Tone.desc(tone)}，点击会切到深色并换成另一套`;
    }

    const toneSeg = document.getElementById('darkToneSeg');
    if (toneSeg) {
      Array.prototype.forEach.call(toneSeg.children, (b) => {
        b.disabled = locked;
        b.classList.toggle('is-active', !locked && b.dataset.darkTone === darkTone());
      });
      toneSeg.title = lockTip;
    }
    const modeHint = document.getElementById('themeModeHint');
    if (modeHint) {
      modeHint.textContent = locked
        ? '扩展主题正在接管配色，这一栏暂时锁定。想换回内置配色，选下面的「使用内置主题」即可。'
        : '「粉白」是樱粉配色，按钮与卡片圆角更大、观感更柔和；深色适合夜间使用；选「跟随系统」会随 Windows 的浅色 / 深色设置自动切换。';
    }
    const toneHint = document.getElementById('darkToneHint');
    if (toneHint) {
      toneHint.textContent = locked
        ? '扩展主题自带一套明暗配色，深色配色在美化包生效期间不可用。'
        : '只影响深色模式。深黄黑保留原来的暖夜观感；深蓝黑整体偏冷蓝，主色从品牌金换成青蓝。切换时不用退出设置，直接生效。';
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
      if (activeRecipe) {
        hint.textContent = '当前使用 ' + activeRecipe.name + '。扩展主题自带一套明暗配色，所以上方「主题」与「深色配色」已暂时锁定；'
          + '要换回内置配色，选「使用内置主题」即可，切换按钮会立刻恢复。';
      } else if (pendingSelection) {
        hint.textContent = '之前选的扩展主题来自已停用的扩展，现在暂时按内置主题显示；'
          + '在功能中心重新启用该扩展后会自动恢复，不用重新挑一次。';
      } else {
        hint.textContent = '在功能中心导入主题插件后，可以在这里选择。启用扩展主题期间，内置的深浅切换会自动锁定。';
      }
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
    const cachedMatches = savedSelection && selectedPluginTheme
      && savedSelection.pluginId === selectedPluginTheme.pluginId
      && savedSelection.themeId === selectedPluginTheme.themeId;
    // localStorage 只负责首帧不闪；权威是数据目录里的选择。缓存对不上就先撤下配色，
    // 能不能生效交给 reconcile 按当前启用的扩展判定（停用的扩展只暂存选择）。
    if (!cachedMatches) {
      activeRecipe = null;
      selectedPluginTheme = null;
    }
    pendingSelection = savedSelection;
    document.documentElement.dataset.themeMode = chosenMode;
    if (catalogReady) reconcilePluginTheme();
    else paint(chosenMode);
    // LocalStorage only accelerates the first frame. The data directory is authoritative.
    if (!selectedPluginTheme) rememberPluginTheme();
  }

  const api = {
    set, toggle, mode, effective, boot, LABEL, MODES, darkTone, setDarkTone, toggleDarkTone,
    current, variables, pluginThemes, registerPlugins, applyPlugin, resetPlugin, whenSaved,
    builtinLocked, builtinLockTip,
    skinCss: () => root.ThemeSkin ? root.ThemeSkin.css(activeRecipe, true) : '',
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Theme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
