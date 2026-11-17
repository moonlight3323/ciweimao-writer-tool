'use strict';

/**
 * 敏感词侧栏窗口的「打不开」兜底。
 *
 * 这些断言读的是源码文本，不 require 主进程模块（CI 的 check 任务不装依赖，
 * 而 pubside.js 顶部要 require('electron')）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('侧栏窗口置顶：压在应用窗口右缘时不会躲到主窗口下面', () => {
  const src = read('src/main/pubside.js');
  assert.match(src, /setAlwaysOnTop\(true, 'floating'\)/);
});

test('打开侧栏会回读真实可见性，而不是一律返回成功', () => {
  const src = read('src/main/pubside.js');
  assert.match(src, /let visible = false;[\s\S]{0,500}w\.isVisible\(\)/, '要回读 isVisible');
  assert.match(src, /return \{ ok: true, visible, error: loadError \}/, '返回值要带真实可见性与加载错误');
});

test('侧栏页面没加载起来时把原因报给主窗口', () => {
  const main = read('src/main/pubside.js');
  assert.match(main, /did-fail-load/, '要监听页面加载失败');
  assert.match(main, /pubside:fault/, '故障要转给主窗口顶栏');

  const pre = read('src/preload/preload.js');
  assert.match(pre, /pubside:fault/, 'preload 要暴露故障事件');

  const pub = read('src/renderer/publish.js');
  assert.match(pub, /api\.onFault/, '渲染层要订阅并在顶栏报错');
});

test('能判断侧栏与主窗口是否同屏，副屏时移回来而不是收起', () => {
  const main = read('src/main/pubside.js');
  assert.match(main, /function locate\(\)/);
  assert.match(main, /sameDisplay/);
  assert.match(main, /pubside:locate/);
  assert.match(main, /pubside:reflow/);

  const pub = read('src/renderer/publish.js');
  assert.match(pub, /api\.locate\(\)/, '按钮要先问窗口在哪块屏幕');
  assert.match(pub, /sameDisplay === false/, '副屏时移回来');
  assert.match(pub, /api\.reflow\(\)/);
});

test('打不开时给出可见反馈，而不是静默失败', () => {
  const pub = read('src/renderer/publish.js');
  assert.match(pub, /侧栏窗口没能显示/);
  assert.match(pub, /侧栏打开失败/);
});

test('preload 暴露 locate / reflow', () => {
  const pre = read('src/preload/preload.js');
  assert.match(pre, /locate: \(\) => ipcRenderer\.invoke\('pubside:locate'\)/);
  assert.match(pre, /reflow: \(\) => ipcRenderer\.invoke\('pubside:reflow'\)/);
});
