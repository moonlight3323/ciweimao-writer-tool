'use strict';

/**
 * 章节目录的显示顺序。
 *
 * 目录数组的顺序取决于它是从哪来的：本地新建是追加到末尾（正序），
 * 从后台同步下来的是站点目录的顺序（新在前）。同一本书里两种来源混在一起，
 * 就会出现「前几条正序、后面倒序」这种看着很乱的状态。
 *
 * 这里只负责算出「该怎么排」，不改动存盘数据：
 *   卷内 —— 按章节号从小到大；读不出编号的（公告、楔子、番外）排在本卷最前，保持原相对顺序
 *   卷间 —— 按该卷最小章节号从小到大
 *
 * 单独放一个文件是为了能在 Node 里直接测：app.js 一加载就要 document，require 不了。
 */
(function (root) {
  const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const UNITS = { 十: 10, 百: 100, 千: 1000 };

  /** 「101」「１２」「一百零一」「十二」→ 数字；认不出来返回 NaN */
  function numberFromText(text) {
    const normalized = String(text == null ? '' : text).replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 65296));
    if (/^\d+$/.test(normalized)) return Number(normalized);
    let total = 0;
    let section = 0;
    let number = 0;
    for (const char of normalized) {
      if (Object.prototype.hasOwnProperty.call(DIGITS, char)) {
        number = DIGITS[char];
      } else if (char === '万') {
        total += (section + number) * 10000;
        section = 0;
        number = 0;
      } else if (UNITS[char]) {
        section += (number || 1) * UNITS[char];
        number = 0;
      } else {
        return NaN;
      }
    }
    return total + section + number;
  }

  /**
   * 从标题里读章节序号：「第101章」「第 101 章」「第十二回」「101 大结局」都认。
   * 读不出来返回 null —— 这类是特殊章节，不参与编号排序。
   */
  function chapterSeq(title) {
    const text = String(title == null ? '' : title);
    const matched = text.match(/第\s*([0-9０-９零〇一二三四五六七八九十百千万两]{1,10})\s*[章节回篇]/);
    if (matched) {
      const num = numberFromText(matched[1]);
      if (Number.isFinite(num)) return num;
    }
    // 有些书不带「第…章」，直接以数字开头
    const lead = text.match(/^\s*([0-9]{1,5})(?:\D|$)/);
    if (lead) return Number(lead[1]);
    return null;
  }

  /**
   * 返回按显示顺序排好的章节数组（不改动入参）。
   * @param {Object} book { chapters: [{ title, volume }] }
   */
  function displayChapters(book) {
    const chapters = Array.isArray(book && book.chapters) ? book.chapters : [];
    const groups = new Map();
    chapters.forEach((chapter) => {
      const volume = chapter.volume;
      if (!groups.has(volume)) groups.set(volume, []);
      groups.get(volume).push(chapter);
    });

    const entries = [...groups.entries()].map(([volume, list], uploadOrder) => {
      const decorated = list.map((chapter, index) => ({ chapter, index, seq: chapterSeq(chapter.title) }));
      decorated.sort((a, b) => {
        if (a.seq == null && b.seq == null) return a.index - b.index;
        if (a.seq == null) return -1;
        if (b.seq == null) return 1;
        if (a.seq !== b.seq) return a.seq - b.seq;
        return a.index - b.index;
      });
      // 整卷都没有编号时用 Infinity，这类卷排在带编号的卷前面
      const minSeq = decorated.reduce((min, x) => (x.seq == null ? min : Math.min(min, x.seq)), Infinity);
      return { volume, list: decorated.map((x) => x.chapter), minSeq, uploadOrder };
    });

    entries.sort((a, b) => {
      const left = a.minSeq === Infinity ? -1 : a.minSeq;
      const right = b.minSeq === Infinity ? -1 : b.minSeq;
      if (left !== right) return left - right;
      return a.uploadOrder - b.uploadOrder;
    });

    return entries.flatMap((entry) => entry.list);
  }

  const api = { numberFromText, chapterSeq, displayChapters };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChapterOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
