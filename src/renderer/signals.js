'use strict';

/**
 * 读者反馈信号提取
 *
 * 定位：不从评论里找「该删谁」，而是找「作者该知道什么」。
 * 尤其是「章节疑似被屏蔽」这类信息，后台不会主动提醒，但读者会第一时间在间贴里喊。
 *
 * 原则：这里只做分类提示，不下判断。误报成本低（作者扫一眼即可），漏报成本高。
 */
(function (root) {
  const TYPES = [
    {
      id: 'censored',
      name: '疑似被屏蔽',
      hint: '读者反映章节 / 内容看不到、被删、审核中',
      rank: 1,
      patterns: [
        '屏蔽', '被审核', '和谐', '404', '吞了', '删了', '看不到了', '看不到',
        '没了', '下架', '违规', '翻不了', '打不开', '加载不出', '章被', '被删',
      ],
    },
    {
      id: 'typo',
      name: '错字与排版',
      hint: '读者指出的文字错误，通常是免费校对',
      rank: 2,
      patterns: [
        '错别字', '错字', '打错', '写错', '漏字', '多了个', '少了个', '重复了',
        '排版', '标点', '断句', '分段', '乱码', '名字错',
      ],
    },
    {
      id: 'quit',
      name: '断更质疑',
      hint: '读者担心弃坑，通常伴随情绪，值得优先回应',
      rank: 3,
      patterns: ['断更', '太监', '弃坑', '鸽了', '不写了', '还更吗', '是不是不更了', '跑路'],
    },
    {
      id: 'update',
      name: '催更',
      hint: '读者催更，可以估算读者热度',
      rank: 4,
      patterns: ['催更', '加更', '多更', '不够看', '求更', '快更', '更新啊', '今天更', '啥时候更', '什么时候更'],
    },
    {
      id: 'plot',
      name: '剧情反馈',
      hint: '对剧情走向的讨论与质疑，属于免费读者调研',
      rank: 5,
      patterns: ['写崩', '崩了', '不合理', '人设', '逻辑', '这段', '节奏', '太水', '拖沓', '仓促'],
    },
  ];

  const TYPE_MAP = new Map(TYPES.map((t) => [t.id, t]));

  function compile() {
    return TYPES.map((t) => ({
      id: t.id,
      name: t.name,
      hint: t.hint,
      rank: t.rank,
      patterns: t.patterns,
    }));
  }

  /**
   * 从间贴数组中提取信号。
   * @returns {Object} { byType: [{ id,name,hint,count,items }], total }
   */
  function extract(items) {
    const types = compile();
    const buckets = new Map(types.map((t) => [t.id, []]));

    for (const it of items || []) {
      const c = (it.content || '').trim();
      if (c.length < 2) continue;
      for (const t of types) {
        const hit = t.patterns.find((p) => c.includes(p));
        if (hit) {
          buckets.get(t.id).push({
            id: it.id,
            content: c,
            nickname: it.nickname || '',
            time: it.time || '',
            bookName: it.bookName || '',
            chapterName: it.chapterName || '',
            paraPos: it.paraPos || '',
            readerId: it.readerId || '',
            hitWord: hit,
          });
          break; // 一条评论只归入优先级最高的类别
        }
      }
    }

    const byType = types
      .map((t) => {
        const list = buckets.get(t.id);
        return {
          id: t.id,
          name: t.name,
          hint: t.hint,
          rank: t.rank,
          count: list.length,
          // 按时间倒序，新的在前
          items: list.sort((a, b) => (a.time < b.time ? 1 : -1)),
        };
      })
      .filter((t) => t.count > 0)
      .sort((a, b) => a.rank - b.rank);

    return {
      byType,
      total: byType.reduce((s, t) => s + t.count, 0),
    };
  }

  const api = { TYPES, TYPE_MAP, extract };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Signals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
