'use strict';

/**
 * 弹窗遮挡守卫。
 *
 * 作者后台 / 喵语数据是原生 WebContentsView，画在渲染页面之上。任何
 * .notice-overlay 弹窗在页面还挂着时显示，卡片就会躲在页面底下 ——
 * 用户看到「网页浮在最前、其余部分变暗模糊、点什么都没反应」。
 *
 * 这些断言防的是「新加一个弹窗又忘了摘页面」：守卫必须覆盖所有 overlay，
 * 不能只靠每个调用点自己记得。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

test('关窗询问弹窗会先把内嵌页摘下来', () => {
  const block = APP.slice(APP.indexOf("window.api.app.onAskCloseBehavior(async"));
  assert.ok(block, '关窗询问的监听要保留');
  const head = block.slice(0, 900);
  assert.match(head, /prepareUpdateOverlay/, '不摘页面的话两个按钮都在页面底下，点不到');
  assert.match(head, /box\.hidden = false/, '摘完才显示弹窗');
});

test('选「最小化到托盘」会把页面挂回去，选退出不挂', () => {
  const block = APP.slice(APP.indexOf('function initCloseAskDialog'), APP.indexOf('initCloseAskDialog();'));
  assert.match(block, /value !== 'quit'[\s\S]{0,200}restoreUpdateOverlay/, '取消关闭后要回到原来的页面');
});

test('有任何遮罩显示就摘内嵌页，不依赖调用点自觉', () => {
  assert.match(APP, /function blockingOverlayVisible\(\)/, '要有统一的「有没有遮罩」判断');
  assert.match(APP, /new MutationObserver\(\(\) => syncNativeOverlayGuard\(\)\)/, '遮罩显隐要能被观察到');
  assert.match(APP, /attributeFilter: \['hidden'\]/, '监听 hidden 属性就够');
  assert.match(APP, /if \(!browserOpen && !miaoyuOpen\) return;/, '没挂页面时不该动手');
});

test('守卫覆盖 index.html 里所有 notice-overlay 弹窗', () => {
  const ids = [...HTML.matchAll(/class="notice-overlay[^"]*"\s+id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 6, `应该至少 6 个遮罩，实际 ${ids.length}：${ids.join(',')}`);
  // 守卫不是按 id 白名单实现的：新增弹窗只要用同一个 class 就自动被覆盖
  assert.match(APP, /\$\$\('\.notice-overlay'\)/, '守卫要按 class 收集，不能写死 id');
});

test('遮罩收干净后不残留 is-locked', () => {
  assert.match(
    APP,
    /if \(!blockingOverlayVisible\(\)\) \{[\s\S]{0,240}classList\.remove\('is-locked'\)/,
    '某个弹窗收尾漏了也不能把界面锁死'
  );
});
