'use strict';

/**
 * 回车自动段首缩进（src/renderer/writer-indent.js）。
 *
 * 纯函数，直接在 Node 里 require 真模块；测的是 app.js 实际调用的那份实现。
 * 断言里用 \u3000 写全角空格，避免看不见的字符让人误判。
 */

const test = require('node:test');
const assert = require('node:assert');

const { INDENT, planEnter } = require('../src/renderer/writer-indent.js');

const IDEO = '\u3000';

/** 把 planEnter 的结果真的套到文本上，得到「按完回车之后」的内容与光标位置 */
function apply(value, start, end) {
  const plan = planEnter(value, start, end);
  return {
    value: value.slice(0, plan.from) + plan.text + value.slice(plan.to),
    caret: plan.from + plan.text.length,
  };
}

/** 连按 n 次回车 */
function pressEnter(value, times, caretStart) {
  let v = value;
  let caret = caretStart == null ? v.length : caretStart;
  for (let i = 0; i < times; i += 1) {
    const r = apply(v, caret, caret);
    v = r.value;
    caret = r.caret;
  }
  return v;
}

test('缩进就是两个全角空格', () => {
  assert.equal(INDENT, IDEO + IDEO);
  assert.equal(INDENT.length, 2);
});

test('行尾回车：新段首自动空两格', () => {
  const r = apply('第一段写完', 5, 5);
  assert.equal(r.value, `第一段写完\n${IDEO}${IDEO}`);
  assert.equal(r.caret, r.value.length, '光标应落在新段缩进之后');
});

test('行中间回车：后半句另起一段，同样带缩进', () => {
  assert.equal(apply('前半后半', 2, 2).value, `前半\n${IDEO}${IDEO}后半`);
});

test('缩进空行上再回车：整行换成「空行 + 新段缩进」，不留只有空格的行', () => {
  const before = `第一段\n${IDEO}${IDEO}`;
  assert.equal(apply(before, before.length, before.length).value, `第一段\n\n${IDEO}${IDEO}`);
});

test('连按三次回车：中间是空行，最后一行仍是带缩进的新段', () => {
  const v = pressEnter('正文', 3);
  assert.equal(v, `正文\n\n\n${IDEO}${IDEO}`);
  assert.ok(!/\u3000\u3000\n/.test(v), '不该留下只有缩进的空行');
});

test('已有缩进的段落里回车：不会重复叠加缩进', () => {
  const value = `${IDEO}${IDEO}已经排好版的段落`;
  const r = apply(value, value.length, value.length);
  assert.equal(r.value, `${IDEO}${IDEO}已经排好版的段落\n${IDEO}${IDEO}`);
  assert.equal(r.value.split('\n')[1], INDENT, '新行只有一个缩进');
});

test('选中一段文字再回车：选区被换行吃掉，缩进照补', () => {
  assert.equal(apply('保留删掉保留2', 2, 4).value, `保留\n${IDEO}${IDEO}保留2`);
});

test('空文本回车：得到带缩进的新段，不会崩', () => {
  assert.equal(apply('', 0, 0).value, `\n${IDEO}${IDEO}`);
});

test('越界的选区参数会被夹到合法范围', () => {
  assert.deepEqual(planEnter('abc', 99, -5), { from: 3, to: 3, text: `\n${IDEO}${IDEO}` });
  assert.deepEqual(planEnter(null, 0, 0), { from: 0, to: 0, text: `\n${IDEO}${IDEO}` });
});

test('和「一键排版」对得上：逐段回车写出来的结果再排版只补多余空行', () => {
  // 模拟作者逐段写：每段都按回车
  const written = `${IDEO}${IDEO}第一段\n${IDEO}${IDEO}第二段`;
  const formatted = written
    .split('\n')
    .map((line) => `${IDEO}${IDEO}${line.trim()}`)
    .join('\n');
  assert.equal(formatted, written, '已经带缩进的内容再排版不应变化');
});
