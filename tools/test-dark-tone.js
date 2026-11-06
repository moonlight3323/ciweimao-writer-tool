'use strict';

/**
 * 深色两套配色的取值逻辑。
 *
 * 这两块很容易错：data-dark-tone 写成驼峰、切完深色又退回默认、
 * localStorage 里存了脏值导致首帧没有配色。所以单独测一遍。
 */
const test = require('node:test');
const assert = require('node:assert');

const DarkTone = require('../src/renderer/dark-tone.js');

/**
 * 造一个最小可用的 root。结构必须照抄浏览器的 window：
 * 根元素在 window.document.documentElement —— window 本身没有 documentElement，
 * 桩里写成 { documentElement } 会把「写不进去」这个 bug 掩盖掉。
 */
function fakeRoot(saved) {
  const store = {};
  if (saved != null) store[DarkTone.KEY] = saved;
  return {
    document: { documentElement: { dataset: {} } },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
  };
}

test('normalize：只认 amber / blue，其余一律回默认', () => {
  assert.equal(DarkTone.normalize('amber'), 'amber');
  assert.equal(DarkTone.normalize('blue'), 'blue');
  assert.equal(DarkTone.normalize('Blue'), 'amber', '大小写不匹配要回默认，不能原样透传');
  assert.equal(DarkTone.normalize('dark'), 'amber');
  assert.equal(DarkTone.normalize(''), 'amber');
  assert.equal(DarkTone.normalize(null), 'amber');
  assert.equal(DarkTone.normalize(undefined), 'amber');
});

test('next：两套之间来回切，脏值也能切出去', () => {
  assert.equal(DarkTone.next('amber'), 'blue');
  assert.equal(DarkTone.next('blue'), 'amber');
  assert.equal(DarkTone.next('nonsense'), 'blue', '脏值当成 amber，切一次就到 blue');
  assert.equal(DarkTone.next(DarkTone.next('amber')), 'amber', '切两次要回到原样');
});

test('label / desc 对应到界面上显示的字', () => {
  assert.equal(DarkTone.label('amber'), '暗金');
  assert.equal(DarkTone.label('blue'), '暗蓝');
  assert.equal(DarkTone.desc('amber'), '深黄黑');
  assert.equal(DarkTone.desc('blue'), '深蓝黑');
});

test('apply：写到 data-dark-tone（不是驼峰的 data-darkTone）', () => {
  withGlobal((root) => {
    assert.equal(DarkTone.apply('blue'), 'blue');
    assert.equal(root.document.documentElement.dataset.darkTone, 'blue');

    // dataset.darkTone 对应 HTML 属性 data-dark-tone，CSS 按这个属性取值。
    // 这条断言防的是「CSS 写 data-dark-tone、JS 设 dark-tone」这类错配。
    assert.equal(DarkTone.ATTR, 'darkTone');
    const attr = `data-${DarkTone.ATTR.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`;
    assert.equal(attr, 'data-dark-tone');
  });
});

test('apply：脏值不会写进去，落的是默认值', () => {
  withGlobal((root) => {
    assert.equal(DarkTone.apply('purple'), 'amber');
    assert.equal(root.document.documentElement.dataset.darkTone, 'amber');
  });
});

/** 模块内部拿的是 globalThis，测 current 时临时挂上去，跑完一定要摘掉 */
function withGlobal(fn, saved) {
  const root = fakeRoot(saved);
  globalThis.document = root.document;
  globalThis.localStorage = root.localStorage;
  try {
    fn(root);
  } finally {
    delete globalThis.document;
    delete globalThis.localStorage;
  }
}

test('current：DOM 上的值优先于 localStorage', () => {
  withGlobal((root) => {
    root.document.documentElement.dataset.darkTone = 'blue';
    assert.equal(DarkTone.current(), 'blue', 'DOM 已经上色了，就该以它为准');
    root.document.documentElement.dataset.darkTone = 'amber';
    assert.equal(DarkTone.current(), 'amber');
  }, 'blue');
});

test('current：DOM 上没有时读 localStorage，脏值回默认', () => {
  withGlobal(() => {
    assert.equal(DarkTone.current(), 'blue');
    globalThis.localStorage.setItem(DarkTone.KEY, 'weird');
    assert.equal(DarkTone.current(), 'amber');
  }, 'blue');
});

test('current：DOM 与 localStorage 都没有时是 amber', () => {
  withGlobal(() => {
    assert.equal(DarkTone.current(), 'amber');
  }, null);
});

test('KEY 与首帧脚本里读的键是同一个', () => {
  // theme-init.js 是同步执行的普通脚本，不引用这个模块，键名只能靠约定；
  // 写死对比一次，改名时两边必须同时改，否则首帧会闪一下另一套配色。
  assert.equal(DarkTone.KEY, 'ciweimao.darkTone');
});

// ---------------------------------------------------------------- CSS 覆盖完整性

const fs = require('node:fs');
const path = require('node:path');

/** 取出某个选择器块里定义的变量名集合（按 `--name:` 匹配，够用，不必上解析器） */
function variablesOf(cssFile, selector) {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', cssFile), 'utf8');
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${cssFile} 里找不到选择器 ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  return new Set(Array.from(body.matchAll(/--([a-z0-9-]+)\s*:/g), (m) => m[1]));
}

test('主样式：深蓝黑必须覆盖深黄黑的每一个变量', () => {
  const amber = variablesOf('style.css', ':root[data-theme="dark"] {');
  const blue = variablesOf('style.css', ':root[data-theme="dark"][data-dark-tone="blue"]');
  assert.ok(amber.size > 20, `深黄黑块只解析出 ${amber.size} 个变量，正则可能没匹配上`);
  const missing = Array.from(amber).filter((v) => !blue.has(v));
  assert.deepEqual(missing, [],
    '这些变量没在深蓝黑里重定义，会从深黄黑继承过来，表现是整体变蓝了但某块还是金/棕');
});

test('侧栏样式：深蓝黑同样必须覆盖自己那份深黄黑', () => {
  const amber = variablesOf('side.css', ':root[data-theme="dark"] {');
  const blue = variablesOf('side.css', ':root[data-theme="dark"][data-dark-tone="blue"]');
  assert.ok(amber.size > 10, `侧栏深黄黑块只解析出 ${amber.size} 个变量`);
  const missing = Array.from(amber).filter((v) => !blue.has(v));
  assert.deepEqual(missing, [], '侧栏漏变量时，主界面是深蓝黑、悬浮窗还是深黄黑');
});
