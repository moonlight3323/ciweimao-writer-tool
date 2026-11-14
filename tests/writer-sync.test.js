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

test('已发布但丢了章节号的章节会按标题认领，不会重复拉成冲突副本', () => {
  const local = [{
    id: 'chapter_1794191190640', title: '第160章 雪线', volume: '正文',
    content: '正文', status: 'published', platformChapterId: '',
  }];
  const remote = [{ chapterId: '9002', title: '第160章 雪线', volume: '正文' }];
  assert.equal(sync.linkPublishedChapters(local, remote), 1);
  assert.equal(local[0].platformChapterId, '9002');
  assert.deepEqual(sync.missingRemoteChapters(local, remote), []);
});

test('未发布的同名草稿不认领后台章节，但也不会被当成后台新增重复拉取', () => {
  const local = [{
    id: 'chapter_1710000000000', title: '第160章 雪线', volume: '正文',
    content: '草稿', status: 'unpublished',
  }];
  const remote = [{ chapterId: '9002', title: '第160章 雪线', volume: '正文' }];
  assert.equal(sync.linkPublishedChapters(local, remote), 0);
  assert.equal(local[0].platformChapterId, undefined);
  assert.deepEqual(sync.missingRemoteChapters(local, remote), [], '本地已有这一章，不该再拉一份');
});

test('后台真正新增的章节仍然正常拉取', () => {
  const local = [{ id: 'chapter_1', title: '第1章 起风', content: '正文' }];
  const remote = [{ chapterId: '9003', title: '第2章 雪夜' }];
  assert.equal(sync.missingRemoteChapters(local, remote).length, 1);
});
