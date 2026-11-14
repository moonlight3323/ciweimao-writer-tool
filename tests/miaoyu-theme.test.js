'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// 只依赖 shared：miaoyu.js 顶部要 require('electron')，而 CI 的 check 任务不装依赖
const { themeSource } = require('../src/shared/miaoyu-skin');

test('深色主题生成暗色覆盖样式，颜色取自传入的主题变量', () => {
  const src = themeSource({
    dark: true,
    colors: { bg: '#171326', card: '#211a33', text: '#e9e3f4', muted: '#a091bb', accent: '#c3a6f0' },
  });
  assert.match(src, /wb-dark-style/, '要落到固定 id，切主题时才能原地替换');
  assert.match(src, /--wb-bg:#171326/);
  assert.match(src, /--wb-text:#e9e3f4/);
  assert.match(src, /--wb-accent:#c3a6f0/);
  assert.match(src, /#app \.rank-card/);
  assert.match(src, /!important/, '站点样式是运行时注入的，必须加 important 才盖得住');
});

test('浅色主题只移除暗色样式，不改站点原样', () => {
  const src = themeSource({ dark: false });
  assert.match(src, /removeChild/);
  assert.equal(/--wb-bg/.test(src), false);
  assert.equal(/#app/.test(src), false);
});

test('颜色缺失时用兜底值，不会把 undefined 写进样式', () => {
  const src = themeSource({ dark: true });
  assert.equal(/undefined/.test(src), false);
  assert.match(src, /--wb-bg:#171326/);
});

test('传入颜色里带引号也不会破坏脚本', () => {
  const src = themeSource({ dark: true, colors: { bg: '#171326', text: 'rgb(1, 2, 3)' } });
  assert.equal(/undefined/.test(src), false);
  assert.match(src, /--wb-text:rgb\(1, 2, 3\)/);
});
