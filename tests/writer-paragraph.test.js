'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const para = require('../src/renderer/writer-paragraph');

test('段间空行整理：紧凑 / 空一行 / 空两行', () => {
  const text = '　　第一段\n\n\n　　第二段\n　　还是第二段\n\n　　第三段';
  assert.equal(para.applyGap(text, 0), '　　第一段\n　　第二段\n　　还是第二段\n　　第三段');
  assert.equal(para.applyGap(text, 1), '　　第一段\n\n　　第二段\n\n　　还是第二段\n\n　　第三段');
  assert.equal(para.applyGap(text, 2),
    '　　第一段\n\n\n　　第二段\n\n\n　　还是第二段\n\n\n　　第三段');
});

test('整理是幂等的，且不会留下末尾空行', () => {
  // 码字台里一行就是一段（回车自带段首缩进），空行只是排版用的间隔
  const once = para.applyGap('一\n\n二\n\n\n三\n\n', 1);
  assert.equal(once, '一\n\n二\n\n三');
  assert.equal(para.applyGap(once, 1), once);
});

test('识别当前段间距档位', () => {
  assert.equal(para.detectGap('一\n二'), 0);
  assert.equal(para.detectGap('一\n\n二'), 1);
  assert.equal(para.detectGap('一\n\n\n二'), 2);
  assert.equal(para.detectGap('一\n\n\n\n二'), 2, '超过两行也按两档算');
  assert.equal(para.detectGap(''), 0);
});

test('空文本与只剩空行的文本不会产生多余内容', () => {
  assert.equal(para.applyGap('', 1), '');
  assert.equal(para.applyGap('\n\n\n', 2), '');
  assert.equal(para.applyGap('   \n　　\n', 1), '', '全角空格也算空白行');
  assert.equal(para.detectGap('\n\n'), 0, '首尾空行不算段间距');
  assert.equal(para.detectGap('\n\n一\n\n二\n\n\n'), 1, '只看正文之间的空行');
});
