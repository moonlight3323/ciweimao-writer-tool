'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../src/renderer/writer-sync');

test('优先使用保存的后台章节号，兼容旧版 chapter_ 前缀', () => {
  assert.equal(sync.remoteChapterId({ platformChapterId: '900', id: 'local_1' }), '900');
  assert.equal(sync.remoteChapterId({ id: 'chapter_900901', content: '已有正文' }), '900901');
  assert.equal(sync.remoteChapterId({ id: 'chapter_900902', content: '' }), '');
  assert.equal(sync.remoteChapterId({ id: `chapter_${Date.now()}`, content: '本地正文' }), '');
});

test('增量同步只返回本地缺少的后台章节', () => {
  const local = [
    { platformChapterId: '100' },
    { id: 'chapter_900101', content: '旧版已同步正文' },
    { id: 'chapter_1', content: '' },
  ];
  const remote = [
    { chapterId: '102', title: '第三章' },
    { chapterId: '900101', title: '第二章' },
    { chapterId: '100', title: '第一章' },
  ];
  assert.deepEqual(sync.missingRemoteChapters(local, remote), [remote[0]]);
});

test('同卷同章号会被识别为本地与后台冲突', () => {
  const local = [{
    id: 'chapter_1710000000000',
    title: '第160章 本地版本',
    volume: '正文',
    content: '本地内容',
  }];
  const remote = { chapterId: '9002', title: '第160章 网页版本', volume: '正文' };
  const hit = sync.findChapterConflict(local, remote);
  assert.equal(hit.chapter, local[0]);
  assert.equal(hit.key, '正文|number:160');
});
