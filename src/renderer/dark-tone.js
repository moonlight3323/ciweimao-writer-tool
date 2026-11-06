'use strict';

/**
 * 深色模式的两套配色：深黄黑（amber，默认）与深蓝黑（blue）。
 *
 * 只负责「选哪套」这一件纯逻辑：写 data-dark-tone、读回来、互相取反。
 * 具体色值全在 style.css / side.css 的
 * `:root[data-theme="dark"][data-dark-tone="..."]` 块里。
 *
 * 拆出来是为了能在 Node 里直接测（theme.js 依赖 window，测不了）。
 */
(function (root) {
  /** 存 localStorage 的键：首帧要同步上色，读 Prefs 来不及 */
  const KEY = 'ciweimao.darkTone';
  const ATTR = 'darkTone';
  const TONES = ['amber', 'blue'];
  const DEFAULT_TONE = 'amber';
  const LABEL = { amber: '暗金', blue: '暗蓝' };
  const DESC = { amber: '深黄黑', blue: '深蓝黑' };

  function normalize(value) {
    return TONES.indexOf(value) >= 0 ? value : DEFAULT_TONE;
  }

  /** 另一套：amber ↔ blue */
  function next(value) {
    return normalize(value) === 'amber' ? 'blue' : 'amber';
  }

  function label(value) {
    return LABEL[normalize(value)];
  }

  function desc(value) {
    return DESC[normalize(value)];
  }

  /** 拿 <html>：注意是 document.documentElement，window 上没有 documentElement 这个属性 */
  function htmlEl() {
    return root && root.document ? root.document.documentElement : null;
  }

  /** 打到 <html data-dark-tone> 上；返回实际采用的取值 */
  function apply(value) {
    const tone = normalize(value);
    const el = htmlEl();
    if (el) el.dataset[ATTR] = tone;
    return tone;
  }

  /** 当前生效的一套：优先读 DOM，读不到再看 localStorage */
  function current() {
    const el = htmlEl();
    if (el) {
      const v = el.dataset[ATTR];
      if (v) return normalize(v);
    }
    try {
      if (root && root.localStorage) return normalize(root.localStorage.getItem(KEY));
    } catch (_) { /* 隐私模式等 */ }
    return DEFAULT_TONE;
  }

  const api = { KEY, ATTR, TONES, DEFAULT_TONE, LABEL, DESC, normalize, next, label, desc, apply, current };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DarkTone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
