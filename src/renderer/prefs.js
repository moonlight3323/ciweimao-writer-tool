'use strict';

/**
 * 界面偏好持久化。
 *
 * 单独一个文件而不是各模块各写一份，是因为 localStorage 之外只有这一个 JSON：
 * 主题、上次导出目录都写进去，谁先存谁后存都不会互相覆盖。
 */
(function (root) {
  const FILE = 'ui-prefs.json';

  let cache = {};
  let loading = null;
  let timer = null;

  function load() {
    if (!loading) {
      loading = Promise.resolve()
        .then(() => window.api.data.read(FILE))
        .then((data) => {
          if (data && typeof data === 'object') cache = data;
          return cache;
        })
        .catch(() => cache);
    }
    return loading;
  }

  /** 合并写，防抖 250ms：切主题这类连点操作不该打一串磁盘写 */
  function flush() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      window.api.data.write(FILE, cache).catch(() => {});
    }, 250);
  }

  const api = {
    ready: load,
    get(key, dflt) {
      return cache[key] === undefined ? dflt : cache[key];
    },
    set(key, value) {
      if (cache[key] === value) return;
      cache[key] = value;
      flush();
    },
    all() { return Object.assign({}, cache); },
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Prefs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
