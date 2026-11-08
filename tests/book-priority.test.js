'use strict';

/**
 * 作品优先级（封面星标）的规则
 *
 * 一个星标要同时驱动「创作中心排第一」和「数据看板默认看这本」，
 * 最容易出错的是：点亮了远程书，数据看板跳过去是空白页。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const bp = require('../src/renderer/book-priority');

const local = (id, pinned, pinnedAt, platformBookId) => ({
  bookId: id,
  name: id,
  source: 'local',
  pinned,
  pinnedAt,
  platformBookId: platformBookId === undefined ? id : platformBookId,
});

test('远程作品不能点亮', () => {
  assert.equal(bp.canPin({ source: 'remote' }), false);
  assert.equal(bp.canPin({ source: 'local' }), true);
  assert.equal(bp.canPin(null), false);
});

test('没有点亮时返回 null，不会乱选一本', () => {
  assert.equal(bp.pickPriority([local('a', false, 0)]), null);
  assert.equal(bp.pickPriority([]), null);
  assert.equal(bp.pickPriority(null), null);
});

test('多本点亮时最近点亮的优先', () => {
  const books = [
    local('old', true, 1000),
    local('new', true, 2000),
    local('mid', true, 1500),
  ];
  assert.equal(bp.pickPriority(books).bookId, 'new');
});

test('远程书即使标了 pinned 也不算优先级', () => {
  const books = [
    { bookId: 'r', name: 'r', source: 'remote', pinned: true, pinnedAt: 9999 },
    local('a', true, 100),
  ];
  assert.equal(bp.pickPriority(books).bookId, 'a');
});

test('数据看板只认带平台书号的优先级作品', () => {
  const books = [
    local('noPlatform', true, 5000, ''),
    local('hasPlatform', true, 100),
  ];
  assert.equal(bp.boardBookIdOf(books), 'hasPlatform',
    '没有 platformBookId 的书在快照里对不上号，不能用它定位看板');
});

test('只有不带平台书号的优先级作品时，看板返回空串（退回全部作品）', () => {
  const books = [local('noPlatform', true, 5000, '')];
  assert.equal(bp.boardBookIdOf(books), '');
});

test('排序：点亮在前，组内最近点亮优先，其余保持原序', () => {
  const books = [
    local('x', false, 0),
    local('p1', true, 100),
    local('y', false, 0),
    local('p2', true, 900),
  ];
  const sorted = bp.sortByPriority(books);
  assert.deepEqual(sorted.map((b) => b.bookId), ['p2', 'p1', 'x', 'y']);
});

test('排序不修改入参', () => {
  const books = [local('a', false, 0), local('b', true, 1)];
  const copy = JSON.parse(JSON.stringify(books));
  bp.sortByPriority(books);
  assert.deepEqual(books, copy);
});

test('pinnedAt 缺失时不影响判断，不会变成 NaN 排序', () => {
  const books = [
    { bookId: 'a', source: 'local', pinned: true },
    { bookId: 'b', source: 'local', pinned: true, pinnedAt: 1 },
  ];
  const picked = bp.pickPriority(books);
  assert.ok(picked === null || ['a', 'b'].includes(picked.bookId));
  assert.equal(bp.pickPriority(books).bookId, 'b', '有时间的排在没有时间的前面');
});

test('看板列表把优先级作品提到第一位，其余顺序不变', () => {
  const books = [
    { bookId: '1', name: 'A' },
    { bookId: '2', name: 'B' },
    { bookId: '3', name: 'C' },
  ];
  const sorted = bp.sortForBoard(books, '3');
  assert.deepEqual(sorted.map((b) => b.bookId), ['3', '1', '2']);
});

test('看板列表：优先级本来就在第一位时不动，也不改入参', () => {
  const books = [{ bookId: '1' }, { bookId: '2' }];
  const copy = JSON.parse(JSON.stringify(books));
  const sorted = bp.sortForBoard(books, '1');
  assert.deepEqual(sorted.map((b) => b.bookId), ['1', '2']);
  assert.deepEqual(books, copy, '不能就地排序');
});

test('看板列表：没有优先级或对不上号时保持原样', () => {
  const books = [{ bookId: '1' }, { bookId: '2' }];
  assert.deepEqual(bp.sortForBoard(books, '').map((b) => b.bookId), ['1', '2']);
  assert.deepEqual(bp.sortForBoard(books, '999').map((b) => b.bookId), ['1', '2']);
  assert.deepEqual(bp.sortForBoard(null, '1'), []);
});

/* ---------- 看板「查看范围」该选哪本：这条修的是「设了优先级看板却不变」 ---------- */

test('用户没动过下拉时，自动定位到优先级作品', () => {
  const r = bp.resolveBoardBookId({
    current: '', touched: false, priority: '222', available: ['111', '222', '333'],
  });
  assert.equal(r.id, '222');
  assert.equal(r.fellBack, false);
});

test('用户手动选过就不抢回来', () => {
  const r = bp.resolveBoardBookId({
    current: '111', touched: true, priority: '222', available: ['111', '222'],
  });
  assert.equal(r.id, '111', '尊重用户的选择');
});

test('用户选了「全部作品」也不抢回来', () => {
  const r = bp.resolveBoardBookId({
    current: '', touched: true, priority: '222', available: ['111', '222'],
  });
  assert.equal(r.id, '', '手动选过全部作品，就该停在全部作品');
});

test('优先级作品当天没有数据时退回全部作品', () => {
  const r = bp.resolveBoardBookId({
    current: '', touched: false, priority: '999', available: ['111', '222'],
  });
  assert.equal(r.id, '');
});

test('选中的书换了日期后不存在，标 fellBack 并退回全部', () => {
  const r = bp.resolveBoardBookId({
    current: '111', touched: true, priority: '222', available: ['222', '333'],
  });
  assert.equal(r.id, '', '不存在的书要退回全部作品');
  assert.equal(r.fellBack, true, '要告诉用户发生了什么');
});

test('没有任何优先级时保持全部作品', () => {
  const r = bp.resolveBoardBookId({
    current: '', touched: false, priority: '', available: ['111'],
  });
  assert.equal(r.id, '');
  assert.equal(r.fellBack, false, '本来就没有选择，不算回退');
});

/* ---------- 分组：这条修的是「点了星标但优先级作品还是 0」 ---------- */

test('分组成两组：优先级作品一组，其余一组，不重不漏', () => {
  const books = [
    { bookId: '1', name: 'A', source: 'author', pinned: false },
    { bookId: '2', name: 'B', source: 'author', pinned: true, pinnedAt: 100 },
    { bookId: '3', name: 'C', source: 'author', pinned: true, pinnedAt: 200 },
  ];
  const g = bp.partition(books);
  assert.deepEqual(g.priority.map((b) => b.bookId), ['3', '2'], '最近点亮的在前');
  assert.deepEqual(g.other.map((b) => b.bookId), ['1']);
  assert.equal(g.priority.length + g.other.length, books.length, '不能重也不能漏');
});

test('只有真正是 true 的 pinned 才算优先级（老数据里是 null / 缺字段）', () => {
  // 真实索引里老书是 pinned: null 或缺字段，绝不能算成优先级
  const books = [
    { bookId: '1', name: 'A', source: 'author', pinned: null },
    { bookId: '2', name: 'B', source: 'author' },
    { bookId: '3', name: 'C', source: 'author', pinned: 0 },
    { bookId: '4', name: 'D', source: 'author', pinned: true },
  ];
  const g = bp.partition(books);
  assert.deepEqual(g.priority.map((b) => b.bookId), ['4']);
  assert.equal(g.other.length, 3, '其余三本都该在「其他作品」里');
});

test('远程书即使 pinned 也只留在其他作品里，并且不重复出现', () => {
  const books = [
    { bookId: '1', name: 'A', source: 'remote', pinned: true },
    { bookId: '2', name: 'B', source: 'author', pinned: true },
  ];
  const g = bp.partition(books);
  assert.deepEqual(g.priority.map((b) => b.bookId), ['2']);
  assert.deepEqual(g.other.map((b) => b.bookId), ['1'], '远程书只能在其他里出现一次');
});

test('partition 不修改入参', () => {
  const books = [{ bookId: '1', source: 'author', pinned: true }];
  const copy = JSON.parse(JSON.stringify(books));
  bp.partition(books);
  assert.deepEqual(books, copy);
});
