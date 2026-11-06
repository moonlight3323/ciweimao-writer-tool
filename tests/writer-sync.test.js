'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../src/renderer/writer-sync');

test('优先使用保存的后台章节号，兼容旧版 chapter_ 前缀', () => {
  assert.equal(sync.remoteChapterId({ platformChapterId: '900', id: 'local_1' }), '900');
  assert.equal(sync.remoteChapterId({ id: 'chapter_901', content: '已有正文' }), '901');
  assert.equal(sync.remoteChapterId({ id: 'chapter_902', content: '' }), '');
});

test('增量同步只返回本地缺少的后台章节', () => {
  const local = [
    { platformChapterId: '100' },
    { id: 'chapter_101', content: '旧版已同步正文' },
    { id: 'chapter_1', content: '' },
  ];
  const remote = [
    { chapterId: '102', title: '第三章' },
    { chapterId: '101', title: '第二章' },
    { chapterId: '100', title: '第一章' },
  ];
  assert.deepEqual(sync.missingRemoteChapters(local, remote), [remote[0]]);
});
