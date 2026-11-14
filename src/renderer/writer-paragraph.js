'use strict';

/**
 * 段间距（纯文本里的空行整理）。
 *
 * 编辑器是 textarea，没有 CSS 段间距可用 —— 「段与段之间空一行」只能真的写空行。
 * 这里只处理字符串、不碰 DOM，边界情况可以在 Node 里直接测。
 */
(function (root) {
  /**
   * 把正文整理成「段与段之间空 gap 行」，顺带清掉行尾多余的空白。
   *
   * 这里的「段」就是**每个非空行**：码字台里回车会自动带段首缩进，
   * 「一键排版」也是按行处理的，所以一行一段是这套编辑器的既定结构。
   * （用 Shift+Enter 顶格续行的少数情况会被当成新段，可接受。）
   * 幂等：对同一段文字连续调用两次，结果一致。
   *
   * @param {string} text 正文
   * @param {number} gap  段间空几行（0–2，超范围按边界处理）
   * @returns {string}
   */
  function applyGap(text, gap) {
    const wanted = Math.max(0, Math.min(2, Number(gap) || 0));
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const paragraphs = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      paragraphs.push(line.replace(/[ \t\u3000]+$/, ''));
    }
    return paragraphs.join('\n' + '\n'.repeat(wanted));
  }

  /**
   * 当前正文里段落之间最多空了几行（用于把面板上的档位点亮）。
   * 首尾的空行不算：那是作者随手多敲的，不代表段间距。
   */
  function detectGap(text) {
    const lines = String(text == null ? '' : text).split('\n');
    let first = -1;
    let last = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0) return 0;
    let run = 0;
    let max = 0;
    for (let i = first; i <= last; i += 1) {
      if (!lines[i].trim()) {
        run += 1;
        if (run > max) max = run;
      } else {
        run = 0;
      }
    }
    return max >= 2 ? 2 : (max === 1 ? 1 : 0);
  }

  const api = { applyGap, detectGap };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WriterParagraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
