'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../src/renderer/stats');

test('后台作品号优先对应本地作品，并保留章节均订', () => {
  const result = stats.mapAuthorBooksToLibrary([
    { bookId: '9001', name: '后台名称', avgSubs: 1234 },
  ], [
    { bookId: 'local-a', platformBookId: '9001', name: '本地名称' },
  ]);
  assert.deepEqual(result[0], {
    bookId: 'local-a', platformBookId: '9001', name: '后台名称', avgSubs: 1234, matchedBy: 'platformBookId',
  });
});

test('作者库作品可直接用相同 bookId 对应', () => {
  const [result] = stats.mapAuthorBooksToLibrary(
    [{ bookId: '9002', name: '作品二', avgSubs: 88 }],
    [{ bookId: '9002', name: '作品二' }],
  );
  assert.equal(result.bookId, '9002');
  assert.equal(result.matchedBy, 'bookId');
});

test('未绑定的旧作品仅在书名唯一时回退对应', () => {
  const [unique] = stats.mapAuthorBooksToLibrary(
    [{ bookId: '9003', name: '唯一书名', avgSubs: 66 }],
    [{ bookId: 'local-b', name: '唯一书名' }],
  );
  assert.equal(unique.bookId, 'local-b');
  assert.equal(unique.matchedBy, 'name');

  const [duplicate] = stats.mapAuthorBooksToLibrary(
    [{ bookId: '9004', name: '同名作品', avgSubs: 77 }],
    [{ bookId: 'local-c', name: '同名作品' }, { bookId: 'local-d', name: '同名作品' }],
  );
  assert.equal(duplicate.bookId, '');
  assert.equal(duplicate.matchedBy, '');
});

test('后台没有章节均订时保留 null 供插件跳过覆盖', () => {
  const [result] = stats.mapAuthorBooksToLibrary(
    [{ bookId: '9005', name: '无均订', avgSubs: null }],
    [{ bookId: '9005', name: '无均订' }],
  );
  assert.equal(result.avgSubs, null);
});
