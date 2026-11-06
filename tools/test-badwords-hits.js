'use strict';

/**
 * 敏感词命中区间（src/renderer/badwords.js 的 hitRanges / highlightHtml）。
 *
 * 码字台的实时高亮和右栏列表都吃这一份结果，合并规则错了会出现
 * 「正文高亮 3 处、右栏说 4 处」这种对不上的情况，所以单独盯住。
 */

const test = require('node:test');
const assert = require('node:assert');

const bw = require('../src/renderer/badwords.js');

test('基本命中：位置与词都对，且按位置升序', () => {
  const text = '他拿起刀，血一下就流出来了。';
  const hits = bw.hitRanges(text, ['刀', '血']);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.word), ['刀', '血']);
  assert.equal(text.slice(hits[0].start, hits[0].end), '刀');
  assert.equal(text.slice(hits[1].start, hits[1].end), '血');
});

test('同一个词多次出现，各算一处', () => {
  const text = '血腥，非常血腥，血腥得离谱';
  const hits = bw.hitRanges(text, ['血腥']);
  assert.equal(hits.length, 3);
  hits.forEach((h) => assert.equal(text.slice(h.start, h.end), '血腥'));
});

test('长短词重叠时保留长的那个，不嵌套', () => {
  const text = '血腥横飞的场面';
  const hits = bw.hitRanges(text, ['血腥', '血腥横飞']);
  assert.equal(hits.length, 1);
  assert.equal(text.slice(hits[0].start, hits[0].end), '血腥横飞');
});

test('短词在前长词在后，也能合并成一段', () => {
  const text = '血流成河';
  const hits = bw.hitRanges(text, ['血流', '血流成河']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].end - hits[0].start, 4);
});

test('相邻但不重叠的两个命中各自保留', () => {
  const text = '血腥暴力';
  const hits = bw.hitRanges(text, ['血腥', '暴力']);
  assert.equal(hits.length, 2);
  assert.equal(hits[1].start, hits[0].end);
});

test('没有命中 / 空词表 / 空正文都返回空数组', () => {
  assert.deepEqual(bw.hitRanges('今天天气不错', ['血腥']), []);
  assert.deepEqual(bw.hitRanges('血腥', []), []);
  assert.deepEqual(bw.hitRanges('', ['血腥']), []);
  assert.deepEqual(bw.hitRanges(null, null), []);
});

test('词表里的空白项与重复项不影响结果', () => {
  const text = '血腥';
  const hits = bw.hitRanges(text, ['血腥', '  ', '血腥', '']);
  assert.equal(hits.length, 1);
});

test('highlightHtml 与 hitRanges 数量一致（两处口径必须相同）', () => {
  const text = '血腥横飞，血流成河，血腥再次出现';
  const words = ['血腥', '血腥横飞', '血流', '不存在的词'];
  const hits = bw.hitRanges(text, words);
  const html = bw.highlightHtml(text, words);
  const marks = (html.match(/<mark/g) || []).length;
  assert.equal(marks, hits.length);
  assert.equal(marks, 3, '两段血腥命中 + 一处血流');
});

test('highlightHtml 会转义 HTML，不能把正文当标签渲染', () => {
  const html = bw.highlightHtml('<b>血腥</b>', ['血腥']);
  assert.ok(html.includes('&lt;b&gt;'), '尖括号必须转义');
  assert.ok(html.includes('<mark>血腥</mark>'));
});
