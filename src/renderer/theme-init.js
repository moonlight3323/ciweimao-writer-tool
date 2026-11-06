'use strict';

/**
 * 主题预置：在样式表生效前就把 data-theme 打到 <html> 上。
 *
 * 必须独立成一个文件并在 <head> 里同步加载——若等 app.js 异步读完偏好再上色，
 * 深色模式下会先闪一下白底。这里只用 localStorage，读不到就按系统配色兜底。
 *
 * 默认给浅色而不是跟随系统：这套界面一直是浅色，突然跟着系统变黑会让人以为出错。
 * 想要跟随系统，在「设置 → 外观」里选一次即可。
 */
(function () {
  var KEY = 'ciweimao.theme';
  var MODES = ['light', 'pink', 'dark', 'auto'];
  var mode = 'light';
  try {
    var saved = localStorage.getItem(KEY);
    if (MODES.indexOf(saved) >= 0) mode = saved;
  } catch (_) { /* 隐私模式等异常，按 light 处理 */ }

  // pink 是浅色系的配色变体，直接落到 data-theme 上，不参与明暗推导
  var theme = mode;
  if (mode === 'auto') {
    var dark = false;
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (_) { dark = false; }
    theme = dark ? 'dark' : 'light';
  }

  // 深色的两套配色同理：必须在首帧就定下来，否则深蓝黑会先闪一下深黄黑
  var tone = 'amber';
  try {
    var savedTone = localStorage.getItem('ciweimao.darkTone');
    if (savedTone === 'blue' || savedTone === 'amber') tone = savedTone;
  } catch (_) { /* ignore */ }

  var el = document.documentElement;
  el.dataset.theme = theme;
  el.dataset.themeMode = mode;
  el.dataset.darkTone = tone;
})();
