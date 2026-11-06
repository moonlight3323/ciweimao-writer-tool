'use strict';

/**
 * 章节目录排序（src/renderer/chapter-order.js）。
 *
 * 这块逻辑纯函数、不碰 DOM，所以直接在 Node 里 require 真模块来测 ——
 * 测的是 app.js 实际调用的那份实现，不是抄一份。
 */

const test = require('node:test');
const assert = require('node:assert');

const { numberFromText, chapterSeq, displayChapters } = require('../src/renderer/chapter-order.js');

const titles = (list) => list.map((c) => c.title);

test('倒序进来的目录按章节号正序排（最新在最下面）', () => {
  const book = {
    chapters: [
      { title: '第101章 与星星相拥', volume: '第一卷' },
      { title: '第100章 龙王吐息', volume: '第一卷' },
      { title: '第99章 龙王来了', volume: '第一卷' },
      { title: '第2章 能用泥头车', volume: '第一卷' },
      { title: '第1章 逆风逆运', volume: '第一卷' },
    ],
  };
  assert.deepEqual(titles(displayChapters(book)), [
    '第1章 逆风逆运', '第2章 能用泥头车', '第99章 龙王来了',
    '第100章 龙王吐息', '第101章 与星星相拥',
  ]);
});

test('两段来源混在一起（前段正序、后段倒序）也能排顺', () => {
  // 截图里的真实形态：几条没编号的公告在最前，后面是倒序的编号章
  const book = {
    chapters: [
      { title: '新书发布：《在方舟当挂件的那些年》', volume: '第一卷' },
      { title: '挣脱了女巫的魔爪', volume: '第一卷' },
      { title: '第101章 与星星相拥', volume: '第一卷' },
      { title: '第100章 龙王吐息', volume: '第一卷' },
      { title: '第89章 前星小姐', volume: '第一卷' },
    ],
  };
  assert.deepEqual(titles(displayChapters(book)), [
    '新书发布：《在方舟当挂件的那些年》',
    '挣脱了女巫的魔爪',
    '第89章 前星小姐',
    '第100章 龙王吐息',
    '第101章 与星星相拥',
  ]);
});

test('无编号的特殊章节留在本卷最前，且保持原有相对顺序', () => {
  const book = {
    chapters: [
      { title: '第1章 开始', volume: '正文' },
      { title: '上架感言', volume: '正文' },
      { title: '第2章 继续', volume: '正文' },
      { title: '假如我年少有为（番外）', volume: '正文' },
    ],
  };
  assert.deepEqual(titles(displayChapters(book)), [
    '上架感言', '假如我年少有为（番外）', '第1章 开始', '第2章 继续',
  ]);
});

test('中文数字与全角数字都认', () => {
  const book = {
    chapters: [
      { title: '第十回 收尾', volume: '正文' },
      { title: '第二回 起', volume: '正文' },
      { title: '第一百零一回 终', volume: '正文' },
    ],
  };
  assert.deepEqual(titles(displayChapters(book)), ['第二回 起', '第十回 收尾', '第一百零一回 终']);
  assert.equal(chapterSeq('第１２章 全角'), 12);
  assert.equal(chapterSeq('101 大结局'), 101);
  assert.equal(chapterSeq('新书发布'), null);
});

test('多卷：卷也按最小章节号排，倒序的书不会卷序颠倒', () => {
  const book = {
    chapters: [
      { title: '第60章 第二卷开始', volume: '第二卷' },
      { title: '第61章 第二卷', volume: '第二卷' },
      { title: '第1章 第一卷开始', volume: '第一卷' },
      { title: '第2章 第一卷', volume: '第一卷' },
    ],
  };
  const out = displayChapters(book);
  assert.deepEqual(titles(out), ['第1章 第一卷开始', '第2章 第一卷', '第60章 第二卷开始', '第61章 第二卷']);
});

test('章节号重复时保持原有先后（稳定排序）', () => {
  const book = {
    chapters: [
      { title: '第5章 甲', volume: '正文' },
      { title: '第5章 乙', volume: '正文' },
      { title: '第4章 丙', volume: '正文' },
    ],
  };
  assert.deepEqual(titles(displayChapters(book)), ['第4章 丙', '第5章 甲', '第5章 乙']);
});

test('不改动入参数组，也不会丢章节', () => {
  const chapters = [
    { title: '第2章 b', volume: '正文' },
    { title: '第1章 a', volume: '正文' },
  ];
  const before = chapters.slice();
  const out = displayChapters({ chapters });
  assert.deepEqual(chapters, before, '原数组顺序不能被就地改掉');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.title), ['第1章 a', '第2章 b']);
});

test('脏数据不崩：空书、非数组、缺标题', () => {
  assert.deepEqual(displayChapters(null), []);
  assert.deepEqual(displayChapters({}), []);
  assert.deepEqual(displayChapters({ chapters: 'x' }), []);
  const out = displayChapters({ chapters: [{ volume: '正文' }, { title: '第1章', volume: '正文' }] });
  assert.equal(out.length, 2, '缺标题的章节不能被丢掉');
  assert.equal(out[1].title, '第1章', '没有标题的当作特殊章节排在本卷最前');
});

test('numberFromText 认不出来时返回 NaN，供调用方判断', () => {
  assert.ok(Number.isNaN(numberFromText('上架感言')));
  assert.equal(numberFromText('100'), 100);
  assert.equal(numberFromText('二千零一'), 2001);
  // 空串按旧实现是 0（不是 NaN）；chapterSeq 里的正则先挡掉了空串，走不到这一步
  assert.equal(numberFromText(''), 0);
  assert.equal(chapterSeq(''), null);
});
