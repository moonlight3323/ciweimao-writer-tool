'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const typos = require('../src/renderer/typos');

test('识别固定词组错写并返回替换建议', () => {
  const [hit] = typos.find('他挥手说：在见。');
  assert.equal(hit.word, '在见');
  assert.equal(hit.suggestion, '再见');
  assert.equal(hit.kind, 'word');
  assert.match(hit.reason, /再见/);
});

test('识别成语、重复字和重复标点', () => {
  const hits = typos.find('他迫不急待地跑来。的的！！');
  assert.deepEqual(hits.map((hit) => hit.suggestion), ['迫不及待', '的', '！']);
});

test('忽略词只影响对应的错写词，不会关闭其他规则', () => {
  const hits = typos.find('在见，按装。', { ignoredWords: ['在见'] });
  assert.deepEqual(hits.map((hit) => hit.suggestion), ['安装']);
});

test('重叠候选只保留较长的词', () => {
  const hits = typos.find('在一次见面');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].word, '在一次');
  assert.equal(hits[0].suggestion, '再一次');
});
