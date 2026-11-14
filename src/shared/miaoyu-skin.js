'use strict';

/**
 * 喵语数据站的暗色皮肤。
 *
 * 喵语是第三方站点，全站只有浅色。深色主题下按主界面的配色（例如达妮娅那套）
 * 覆盖一层；浅色主题时把这份样式移除，恢复站点原样。
 *
 * 放在 shared 而不是 main/miaoyu.js 里，是为了能在 CI 的纯 Node 环境直接测：
 * miaoyu.js 顶部要 require('electron')，而 check 任务不安装依赖。
 *
 * 颜色全部来自渲染层传来的 CSS 变量，换主题/换皮肤时自动跟着变。
 * 站点用 Naive UI，运行时注入的 `n-*` 类优先级不低，所以统一用 `#app` 前缀 + !important。
 */
(function (root) {
  /**
   * @param {{dark:boolean, colors?:Object}} theme
   * @returns {string} 可直接 executeJavaScript 的代码
   */
  function themeSource(theme) {
    const t = theme || {};
    if (!t.dark) {
      return `(function () {
      var st = document.getElementById('wb-dark-style');
      if (st && st.parentNode) st.parentNode.removeChild(st);
      return 'light';
    })()`;
    }
    const c = t.colors || {};
    const pick = (value, fallback) => String(value || fallback);
    const css = [
      ':root{',
      `--wb-bg:${pick(c.bg, '#171326')};`,
      `--wb-card:${pick(c.card, '#211a33')};`,
      `--wb-card-2:${pick(c.card2, '#2b2242')};`,
      `--wb-text:${pick(c.text, '#e9e3f4')};`,
      `--wb-muted:${pick(c.muted, '#a091bb')};`,
      `--wb-line:${pick(c.line, 'rgba(186,155,234,.22)')};`,
      `--wb-accent:${pick(c.accent, '#c3a6f0')};`,
      '}',
      'html,body{background:var(--wb-bg)!important;color:var(--wb-text)!important}',
      '#app,#app .main-page,#app .main-content,#app .main-content>div{background:transparent!important}',
      '#app .rank-card,#app .n-card,#app .n-input,#app .n-input__wrapper,#app .n-base-selection,'
        + '#app .n-base-selection-label,#app .n-button,#app .n-collapse,#app .n-collapse-item__header,'
        + '#app .n-collapse-item__content-inner,#app .n-menu,#app .n-thing,#app .n-empty{'
        + 'background-color:var(--wb-card)!important;border-color:var(--wb-line)!important;'
        + 'color:var(--wb-text)!important}',
      '#app .rank-badge{background-color:var(--wb-card-2)!important;color:var(--wb-muted)!important}',
      '#app .stat-label,#app .book-author,#app .n-base-clear__placeholder,'
        + '#app .n-input__placeholder,#app .n-menu-item-content-header{color:var(--wb-muted)!important}',
      '#app .book-name,#app .stat-value,#app .page-head,#app .rank-title{color:var(--wb-text)!important}',
      '#app .stat-active,#app .stat-active .stat-value{color:var(--wb-accent)!important}',
      '#app .n-button:hover{background-color:var(--wb-card-2)!important}',
      '#app input,#app textarea{color:var(--wb-text)!important;background-color:transparent!important}',
      '::-webkit-scrollbar{width:10px;height:10px}',
      '::-webkit-scrollbar-track{background:var(--wb-bg)}',
      '::-webkit-scrollbar-thumb{background:#3a2f52;border-radius:5px}',
    ].join('');
    return `(function () {
    var st = document.getElementById('wb-dark-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'wb-dark-style';
      (document.head || document.documentElement).appendChild(st);
    }
    st.textContent = ${JSON.stringify(css)};
    return 'dark';
  })()`;
  }

  const api = { themeSource };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaoyuSkin = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
