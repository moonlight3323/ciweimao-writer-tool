'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Reviewer = require('../src/renderer/reviewer');
const Rank = require('../src/renderer/rank');
const Executor = require('../src/renderer/executor');

test('自定义风险词和阈值会影响评论分级', () => {
  const result = Reviewer.review([
    { id: 'review:1', kind: 'review', content: '这里有自定义测试词', readerId: '10', nickname: '读者' },
  ], { high: 80, mid: 35, customWords: ['自定义测试词'], protectedReaders: [] });
  assert.equal(result.items[0].level, 'mid');
  assert.equal(result.items[0].hits.some((x) => x.ruleId === 'custom'), true);
});

test('保护名单可以把读者风险压到低风险', () => {
  const result = Reviewer.review([
    { id: 'tsukkomi:1', content: '你就是个傻逼', readerId: '42', nickname: '熟读者' },
  ], { protectedReaders: ['42'] });
  assert.equal(result.items[0].level, 'none');
  assert.equal(result.items[0].hits.some((x) => x.ruleId === 'protected'), true);
});

test('间贴本地前缀不会被带入平台处置请求', () => {
  const slip = Executor.buildSlip({
    id: 'tsukkomi:123456', platformId: '123456', readerId: '99', bookId: '88', chapterId: '77',
  });
  assert.equal(slip.localId, 'tsukkomi:123456');
  assert.equal(slip.commentId, '123456');
});

test('榜单模块包含九类榜单并能计算排名变化', () => {
  assert.deepEqual(Rank.RANK_KEYS, [
    'click', 'collect', 'recommend', 'subscribe', 'monthly', 'tsukkomi', 'newbook', 'blade', 'update',
  ]);
  const current = {};
  const previous = {};
  Rank.RANK_KEYS.forEach((key) => {
    current[key] = { week: [], month: [] };
    previous[key] = { week: [], month: [] };
  });
  current.blade.week = [{ title: '测试书', rank: 2, num: 120 }];
  previous.blade.week = [{ title: '测试书', rank: 5, num: 100 }];
  const out = Rank.annotate(current, previous);
  assert.equal(out.blade.week[0].rankDiff, 3);
  assert.equal(out.blade.week[0].numDiff, 20);
});
