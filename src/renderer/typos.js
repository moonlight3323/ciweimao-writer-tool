'use strict';

/**
 * 本地错别字提示。
 *
 * 这是一个保守的规则层：只提示明确的固定词组误写、常见形近/音近字、
 * 明显重复字和连续重复标点，不自动断言上下文一定错误。候选项带上原因，
 * 交给作者逐条确认，避免把文学表达误改掉。
 */
(function (root) {
  const WORD_RULES = [
    ['在见', '再见', '固定词组通常写作“再见”'],
    ['在次', '再次', '固定词组通常写作“再次”'],
    ['在三', '再三', '固定词组通常写作“再三”'],
    ['在度', '再度', '固定词组通常写作“再度”'],
    ['在也', '再也', '固定词组通常写作“再也”'],
    ['在来', '再来', '固定词组通常写作“再来”'],
    ['在一次', '再一次', '固定词组通常写作“再一次”'],
    ['做为', '作为', '固定词组通常写作“作为”'],
    ['象是', '像是', '固定词组通常写作“像是”'],
    ['像征', '象征', '“象征”中的字形容易写错'],
    ['即然', '既然', '固定词组通常写作“既然”'],
    ['既使', '即使', '固定词组通常写作“即使”'],
    ['必须品', '必需品', '“必需品”表示生活必需的物品'],
    ['按装', '安装', '固定词组通常写作“安装”'],
    ['安照', '按照', '固定词组通常写作“按照”'],
    ['暴光', '曝光', '固定词组通常写作“曝光”'],
    ['爆发户', '暴发户', '固定词组通常写作“暴发户”'],
    ['帐号', '账号', '现代汉语通常写作“账号”'],
    ['帐户', '账户', '现代汉语通常写作“账户”'],
    ['蓝球', '篮球', '球类名称通常写作“篮球”'],
    ['篮天', '蓝天', '固定词组通常写作“蓝天”'],
    ['辩别', '辨别', '固定词组通常写作“辨别”'],
    ['辨法', '办法', '固定词组通常写作“办法”'],
    ['松驰', '松弛', '固定词组通常写作“松弛”'],
    ['水笼头', '水龙头', '固定词组通常写作“水龙头”'],
    ['再接再励', '再接再厉', '成语通常写作“再接再厉”'],
    ['一愁莫展', '一筹莫展', '成语通常写作“一筹莫展”'],
    ['天翻地复', '天翻地覆', '成语通常写作“天翻地覆”'],
    ['默守成规', '墨守成规', '成语通常写作“墨守成规”'],
    ['迫不急待', '迫不及待', '成语通常写作“迫不及待”'],
    ['融汇贯通', '融会贯通', '成语通常写作“融会贯通”'],
    ['不醒人事', '不省人事', '成语通常写作“不省人事”'],
    ['不可思意', '不可思议', '成语通常写作“不可思议”'],
    ['直接了当', '直截了当', '成语通常写作“直截了当”'],
    ['形消骨立', '形销骨立', '成语通常写作“形销骨立”'],
    ['自抱自弃', '自暴自弃', '成语通常写作“自暴自弃”'],
    ['义气用事', '意气用事', '成语通常写作“意气用事”'],
    ['防碍', '妨碍', '固定词组通常写作“妨碍”'],
    ['题纲', '提纲', '固定词组通常写作“提纲”'],
    ['决择', '抉择', '固定词组通常写作“抉择”'],
    ['通辑', '通缉', '固定词组通常写作“通缉”'],
    ['取谛', '取缔', '固定词组通常写作“取缔”'],
    ['脉博', '脉搏', '固定词组通常写作“脉搏”'],
    ['按步就班', '按部就班', '成语通常写作“按部就班”'],
    ['针贬时弊', '针砭时弊', '成语通常写作“针砭时弊”'],
    ['兵慌马乱', '兵荒马乱', '成语通常写作“兵荒马乱”'],
  ].map(([word, suggestion, reason]) => ({ word, suggestion, reason, kind: 'word' }));

  const DUPLICATE_RULES = [
    ['的的', '的', '疑似重复字'],
    ['了了', '了', '疑似重复字'],
    ['着着', '着', '疑似重复字'],
    ['我我', '我', '疑似重复字'],
    ['他他', '他', '疑似重复字'],
    ['她她', '她', '疑似重复字'],
    ['是是', '是', '疑似重复字'],
    ['在在', '在', '疑似重复字'],
  ].map(([word, suggestion, reason]) => ({ word, suggestion, reason, kind: 'duplicate' }));

  const PUNCT_RULES = [
    ['。。', '。', '连续重复句号'],
    ['，，', '，', '连续重复逗号'],
    ['！！', '！', '连续重复感叹号'],
    ['？？', '？', '连续重复问号'],
    ['！！', '！', '连续重复感叹号'],
    ['；；', '；', '连续重复分号'],
    ['：：', '：', '连续重复冒号'],
  ].map(([word, suggestion, reason]) => ({ word, suggestion, reason, kind: 'punctuation' }));

  const RULES = Object.freeze(WORD_RULES.concat(DUPLICATE_RULES, PUNCT_RULES));

  function occurrences(text, word) {
    const t = String(text || '');
    const w = String(word || '');
    const out = [];
    if (!w) return out;
    let from = 0;
    while (from <= t.length) {
      const at = t.indexOf(w, from);
      if (at < 0) break;
      out.push({ start: at, end: at + w.length });
      from = at + Math.max(1, w.length);
      if (out.length >= 200) break;
    }
    return out;
  }

  function contextOf(text, start, end, pad) {
    const t = String(text || '');
    const p = pad == null ? 14 : pad;
    const left = Math.max(0, start - p);
    const right = Math.min(t.length, end + p);
    return {
      before: (left > 0 ? '…' : '') + t.slice(left, start).replace(/\n/g, ' '),
      hit: t.slice(start, end),
      after: t.slice(end, right).replace(/\n/g, ' ') + (right < t.length ? '…' : ''),
    };
  }

  function find(text, options) {
    const t = String(text || '');
    const o = options || {};
    const ignored = new Set((o.ignoredWords || []).map((word) => String(word)));
    const candidates = [];
    RULES.forEach((rule) => {
      if (ignored.has(rule.word)) return;
      occurrences(t, rule.word).forEach((pos) => {
        candidates.push({
          id: `${pos.start}:${rule.word}:${rule.suggestion}`,
          word: rule.word,
          suggestion: rule.suggestion,
          reason: rule.reason,
          kind: rule.kind,
          start: pos.start,
          end: pos.end,
          context: contextOf(t, pos.start, pos.end),
        });
      });
    });
    // 长词优先，同一位置只保留一个候选；不同位置按正文顺序显示。
    candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const result = [];
    candidates.forEach((candidate) => {
      const previous = result[result.length - 1];
      if (previous && candidate.start < previous.end) return;
      result.push(candidate);
    });
    return result;
  }

  const api = { RULES, occurrences, contextOf, find };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Typos = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
