'use strict';

/**
 * 目录顺序：卷内按章号，卷间按该卷最小章号；打平时按「先开的那一卷」。
 *
 * 最后一条是这次修的 bug：多卷本每卷都从「第1章」重新编号时，卷间章号全部相同，
 * 以前会退化成「谁先出现在数组里谁在前」，而后台目录是「最新一卷在前」，
 * 整本书就翻过来了（卷三、卷二、卷一）。chapterId 随创作递增，用它定先后。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const order = require('../src/renderer/chapter-order');

test('单卷按章号正序，与传入顺序无关', () => {
  const chapters = [
    { chapterId: '9003', title: '第3章 丙', volume: '正文' },
    { chapterId: '9001', title: '第1章 甲', volume: '正文' },
    { chapterId: '9002', title: '第2章 乙', volume: '正文' },
  ];
  assert.deepEqual(
    order.displayChapters({ chapters }).map((c) => c.title),
    ['第1章 甲', '第2章 乙', '第3章 丙']
  );
});

test('多卷跨卷编号：按各卷最小章号升序', () => {
  const chapters = [
    { chapterId: '9010', title: '第11章 尾', volume: '卷二' },
    { chapterId: '9003', title: '第2章 乙', volume: '卷一' },
    { chapterId: '9002', title: '第1章 甲', volume: '卷一' },
    { chapterId: '9009', title: '第10章 丁', volume: '卷二' },
  ];
  assert.deepEqual(
    order.displayChapters({ chapters }).map((c) => c.volume + ':' + c.title),
    ['卷一:第1章 甲', '卷一:第2章 乙', '卷二:第10章 丁', '卷二:第11章 尾']
  );
});

test('多卷各自从第 1 章编号时，先开的那一卷排在前面（不再翻转）', () => {
  // 后台目录的真实形态：最新一卷在最前，卷内倒序
  const chapters = [
    { chapterId: '9006', title: '第2章 丙', volume: '卷三' },
    { chapterId: '9005', title: '第1章 丙', volume: '卷三' },
    { chapterId: '9004', title: '第2章 乙', volume: '卷二' },
    { chapterId: '9003', title: '第1章 乙', volume: '卷二' },
    { chapterId: '9002', title: '第2章 甲', volume: '卷一' },
    { chapterId: '9001', title: '第1章 甲', volume: '卷一' },
  ];
  assert.deepEqual(
    order.displayChapters({ chapters }).map((c) => c.volume + ':' + c.title),
    [
      '卷一:第1章 甲', '卷一:第2章 甲',
      '卷二:第1章 乙', '卷二:第2章 乙',
      '卷三:第1章 丙', '卷三:第2章 丙',
    ]
  );
});

test('顺序是稳定的：重复调用不改变结果', () => {
  const chapters = [
    { chapterId: '9002', title: '第2章 乙', volume: '正文' },
    { chapterId: '9001', title: '第1章 甲', volume: '正文' },
  ];
  const once = order.displayChapters({ chapters }).map((c) => c.chapterId);
  const twice = order.displayChapters({ chapters: order.displayChapters({ chapters }) }).map((c) => c.chapterId);
  assert.deepEqual(twice, once);
});
