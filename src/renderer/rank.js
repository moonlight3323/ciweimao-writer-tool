'use strict';

/**
 * 平台榜单
 *
 * 与作者后台无关，抓的是公开页 www.ciweimao.com/rank-index，无需登录。
 * 精简版只保留两个榜：点击榜、收藏榜，各取周榜与月榜前 10。
 *
 * 页面结构（实测 2026-11-04）：
 *   div.title-box > h3.title(榜名) + ol(周榜/月榜切换)
 *   div.title-box 的下一个兄弟节点 ul.tab，内含 20 个 li：前 10 为周榜，后 10 为月榜
 *   第 1 名是 li.top1 > div.info（含作者），第 2 名起是 li > a[title]
 */
(function (root) {
  const WANTED = { 点击榜: 'click', 收藏榜: 'collect' };
  const TOP_N = 10;

  /** '31.0万' → 310000；'5507' → 5507 */
  function parseNum(s) {
    if (s == null) return null;
    const m = String(s).match(/([\d.]+)\s*(万)?/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (Number.isNaN(v)) return null;
    return m[2] ? Math.round(v * 10000) : Math.round(v);
  }

  function parseLi(li) {
    const iconEl = li.querySelector('i.icon-top');
    const rankRaw = iconEl ? iconEl.textContent.trim().replace(/NO\./i, '') : '';
    const rank = parseInt(rankRaw, 10);

    const info = li.querySelector('div.info');
    if (info) {
      const a = info.querySelector('h3 a[title]');
      const authorA = info.querySelector('p.author a');
      const numEl = info.querySelector('p.num span');
      return {
        rank: Number.isNaN(rank) ? null : rank,
        title: a ? (a.getAttribute('title') || a.textContent).trim() : '',
        author: authorA ? authorA.textContent.trim() : '',
        category: '',
        raw: numEl ? numEl.textContent.trim() : '',
        num: parseNum(numEl ? numEl.textContent : ''),
        url: a ? a.href : '',
      };
    }

    const a2 = li.querySelector('a[title]');
    const b = li.querySelector('b');
    const numEl2 = li.querySelector('span.num');
    return {
      rank: Number.isNaN(rank) ? null : rank,
      title: a2 ? (a2.getAttribute('title') || a2.textContent).trim() : '',
      author: '',
      category: b ? b.textContent.trim().replace(/[[\]]/g, '') : '',
      raw: numEl2 ? numEl2.textContent.trim() : '',
      num: parseNum(numEl2 ? numEl2.textContent : ''),
      url: a2 ? a2.href : '',
    };
  }

  /**
   * 解析榜单页 HTML。
   * @returns {{click:{week:Array,month:Array}, collect:{week:Array,month:Array}}}
   */
  function parseRankHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = { click: { week: [], month: [] }, collect: { week: [], month: [] } };

    const heads = doc.querySelectorAll('h3.title');
    for (let i = 0; i < heads.length; i += 1) {
      const name = heads[i].textContent.trim();
      const key = WANTED[name];
      if (!key) continue;

      const titleBox = heads[i].closest('.title-box');
      if (!titleBox) continue;

      // 周榜与月榜是两个独立的 ul（月榜带 hide 类），依次排在 title-box 之后
      const uls = [];
      let node = titleBox.nextElementSibling;
      while (node && !node.classList.contains('title-box')) {
        if (node.tagName === 'UL' && node.classList.contains('tab')) uls.push(node);
        node = node.nextElementSibling;
      }
      if (!uls.length) continue;

      const weekLis = Array.prototype.filter.call(uls[0].children, (el) => el.tagName === 'LI');
      const monthLis = uls[1]
        ? Array.prototype.filter.call(uls[1].children, (el) => el.tagName === 'LI')
        : [];

      out[key].week = weekLis.map(parseLi).filter((x) => x.title).slice(0, TOP_N);
      out[key].month = monthLis.map(parseLi).filter((x) => x.title).slice(0, TOP_N);
    }
    return out;
  }

  /** 某日之前最近的一条记录 */
  function previousRecord(records, date) {
    const prior = (records || []).filter((r) => r.date < date).sort((a, b) => (a.date < b.date ? 1 : -1));
    return prior[0] || null;
  }

  /**
   * 计算排名变化。
   * diff > 0 表示名次上升（数字变小），diff < 0 表示下降，null 表示新上榜。
   */
  function annotate(current, previous) {
    const result = {};
    ['click', 'collect'].forEach((key) => {
      result[key] = {};
      ['week', 'month'].forEach((period) => {
        const cur = (current[key] && current[key][period]) || [];
        const prevList = (previous && previous[key] && previous[key][period]) || [];
        const prevMap = new Map(prevList.map((x) => [x.title, x]));

        result[key][period] = cur.map((item) => {
          const p = prevMap.get(item.title);
          const rankDiff = p && p.rank != null && item.rank != null ? p.rank - item.rank : null;
          const numDiff = p && p.num != null && item.num != null ? item.num - p.num : null;
          return Object.assign({}, item, {
            prevRank: p ? p.rank : null,
            isNew: !p,
            rankDiff,
            numDiff,
          });
        });
      });
    });
    return result;
  }

  /** 合并进历史（同日覆盖） */
  function mergeRecord(records, record) {
    const list = (records || []).filter((r) => r.date !== record.date);
    list.push(record);
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    return list;
  }

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const api = { parseRankHtml, parseNum, previousRecord, annotate, mergeRecord, today, TOP_N };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Rank = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
