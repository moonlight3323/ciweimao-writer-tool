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
