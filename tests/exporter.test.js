'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const exporter = require('../src/renderer/exporter');
test('间贴段落序号和 Windows/Unix 空行解析', () => {
  assert.equal(exporter.parseParagraphNumber('第 42 段'), 42);
  assert.equal(exporter.parseParagraphNumber('未知'), 0);
  assert.deepEqual(exporter.splitParagraphs('  第一段\r\n\r\n第二段\n\n第三段  '), ['第一段', '第二段', '第三段']);
});
test('正文可信度排除章节列表和明显截断正文', () => {
  assert.equal(exporter.plausible('共2117字 第1章 列表'), false);
  assert.equal(exporter.plausible('正文'.repeat(40), 2000), false);
  assert.equal(exporter.plausible('故事正文'.repeat(500), 2000), true);
});
test('导出文件名清理 Windows 不支持的字符', () => {
  assert.equal(exporter.safeName('书名<>:"/\\|?*'), '书名_________');
});

test('整本没有章号时按创建号正序，不跟着分页顺序（最新页在前）走', () => {
  // 分页目录的数组顺序是「第 1 页 = 最新的一批」，纯标题的书没有章号可排，
  // 以前会原样输出成最新在前；现在按 chapterId 升序兜底（站点 ID 随创作递增）。
  globalThis.ChapterOrder = require('../src/renderer/chapter-order');
  const list = [
    { chapterId: '9005', title: '雪线' },
    { chapterId: '9006', title: '归途' },
    { chapterId: '9001', title: '起风' },
    { chapterId: '9002', title: '夜行' },
  ];
  assert.deepEqual(
    exporter.orderChapters(list).map((c) => c.chapterId),
    ['9001', '9002', '9005', '9006']
  );
});

test('有章号的仍然按章号排，创建号只做兜底', () => {
  globalThis.ChapterOrder = require('../src/renderer/chapter-order');
  const list = [
    { chapterId: '9009', title: '第2章 乙' },
    { chapterId: '9001', title: '第10章 丙' },
    { chapterId: '9005', title: '第1章 甲' },
  ];
  assert.deepEqual(
    exporter.orderChapters(list).map((c) => c.title),
    ['第1章 甲', '第2章 乙', '第10章 丙']
  );
});
