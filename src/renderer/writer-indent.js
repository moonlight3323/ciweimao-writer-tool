'use strict';

/**
 * 码字时的段首缩进。
 *
 * 目标：正文编辑区默认就是「一键排版」之后的观感 —— 每个自然段开头空两个全角字符，
 * 一行写满自动折行的部分仍然顶格。
 *
 * 只算「按一次回车该往哪儿插什么」，不碰 DOM，方便在 Node 里直接测各种边界。
 */
(function (root) {
  /** 段首缩进：两个全角空格。一键排版也用它，两处必须同一个值，否则排版会漂 */
  const INDENT = '\u3000\u3000';

  /**
   * @param {string} value  textarea 当前全文
   * @param {number} start  选区起点
   * @param {number} end    选区终点
   * @returns {{from:number, to:number, text:string}} 把 [from,to) 换成 text
   */
  function planEnter(value, start, end) {
    const text = String(value == null ? '' : value);
    const from = Math.max(0, Math.min(Number(start) || 0, text.length));
    const to = Math.max(from, Math.min(Number(end) || 0, text.length));

    const lineStart = text.lastIndexOf('\n', from - 1) + 1;
    const lineBreak = text.indexOf('\n', from);
    const lineEnd = lineBreak < 0 ? text.length : lineBreak;
    const beforeCaret = text.slice(lineStart, from);
    const afterCaret = text.slice(to, lineEnd);

    // 这一行前后都只剩空白（上一步回车留下的两个缩进空格）：把整行换成「空行 + 新段缩进」，
    // 否则连按回车会堆出一串只有空格的「空行」，一键排版时又会被折成别的东西
    if (to === from && beforeCaret.trim() === '' && afterCaret.trim() === '') {
      return { from: lineStart, to: lineEnd, text: `\n${INDENT}` };
    }

    return { from, to, text: `\n${INDENT}` };
  }

  const api = { INDENT, planEnter };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WriterIndent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
