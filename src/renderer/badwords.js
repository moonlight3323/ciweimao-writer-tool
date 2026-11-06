'use strict';

/**
 * 敏感词处理：解析站点返回的词、在正文里定位、替换、预览。
 *
 * 站点返回的 `hint_words` 是给人看的字符串，格式没有公开约定，
 * 所以这里一套「从宽解析」：JSON / 带标签的标注 / 括号包裹 / 各种分隔符都试一遍，
 * 实在认不出来就把整段当一个候选。真正使用时会把原文写进日志，方便按实际格式补规则。
 *
 * 纯函数，不碰 DOM（除了 highlightHtml 生成字符串），便于单测。
 */
(function (root) {
  'use strict';

  /** 常见敏感词的文学化替代。只收「换了不影响情节」的词，单字不在这里处理。 */
  const SYNONYMS = {
    自杀: ['轻生', '自尽'],
    自尽: ['轻生'],
    死亡: ['离世', '殒命'],
    尸体: ['遗骸', '躯身'],
    鲜血: ['血色', '血渍'],
    血液: ['血色'],
    血腥: ['惨烈', '血污'],
    杀人: ['害命', '下死手'],
    杀死: ['了结', '撂倒'],
    屠杀: ['屠戮', '血洗'],
    强奸: ['侵害', '施暴'],
    强暴: ['施暴'],
    色情: ['情色'],
    裸体: ['赤身'],
    赤裸: ['赤着'],
    毒品: ['违禁药'],
    吸毒: ['用药'],
    枪支: ['枪械'],
    爆炸: ['爆开'],
    恐怖: ['骇人'],
    暴力: ['武力'],
    殴斗: ['动手'],
    赌博: ['赌局'],
    妓女: ['女子'],
    嫖娼: ['寻欢'],
    自杀式: ['搏命'],
    恐怖袭击: ['袭击'],
    血液横飞: ['血光四溅'],
    炸弹: ['爆裂物'],
    手枪: ['短枪'],
    步枪: ['长枪'],
    割喉: ['割向咽喉'],
    斩首: ['枭首'],
  };

  /** 标点与空白，不算「词」 */
  const PUNCT = /^[\s\p{P}\p{S}]+$/u;

  function clean(s) {
    return String(s == null ? '' : s).replace(/\u00a0/g, ' ').trim();
  }

  /** 去掉所有空白，用于「正文里到底有没有这个词」的判断 */
  function squash(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '');
  }

  function uniq(arr) {
    const seen = new Set();
    const out = [];
    arr.forEach((x) => {
      const k = squash(x);
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(clean(x));
    });
    return out;
  }

  /**
   * 解析站点返回的 hint_words。
   * @returns {string[]} 候选词（去重、去空白、长度 1~24）
   */
  function parseHint(raw) {
    let s = clean(raw);
    if (!s) return [];

    // 0) 去掉站点可能塞进来的说明性前缀，只留引号/标签里的内容
    const cands = [];

    // 1) JSON 数组
    if (/^\s*\[/.test(s)) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) {
          arr.forEach((x) => cands.push(String(x && x.word ? x.word : x)));
          if (cands.length) return uniq(cands).filter((w) => w.length <= 24);
        }
      } catch (_) { /* 不是 JSON 就往下走 */ }
    }

    // 2) 带标签的标注：<em>词</em> / <span class="red">词</span> / <b>词</b>
    const tagRe = /<(em|b|strong|i|span|font|mark)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = tagRe.exec(s))) {
      const t = clean(m[2].replace(/<[^>]+>/g, ''));
      if (t && t.length <= 24) cands.push(t);
    }
    if (cands.length) return uniq(cands).filter((w) => w.length <= 24);

    // 3) 括号包裹：【词】[词]「词」《词》<<词>>
    const bracketRe = /【([^】]{1,24})】|\[([^\]\n]{1,24})\]|「([^」]{1,24})」|《([^》]{1,24})》|<<([^>]{1,24})>>/g;
    while ((m = bracketRe.exec(s))) {
      const t = clean(m[1] || m[2] || m[3] || m[4] || m[5] || '');
      if (t) cands.push(t);
    }
    if (cands.length) return uniq(cands).filter((w) => w.length <= 24);

    // 4) 分隔符切分（中英文逗号、顿号、分号、竖线、斜杠、换行、制表、连续空格）
    if (/[,，、;；|\n\r\t]/.test(s)) {
      const parts = s.split(/[,，、;；|\n\r\t]+/).map(clean);
      const good = parts.filter((p) => p && p.length <= 24 && !PUNCT.test(p));
      if (good.length) return uniq(good);
    }

    // 5) 只有一个词，但前后带了说明文字：「xxx 疑似敏感」这类
    const quoted = s.match(/["“'『]([^"”'』]{1,24})["”'』]/g);
    if (quoted && quoted.length) {
      const inner = quoted.map((q) => q.replace(/^["“'『]|["”'』]$/g, ''));
      const good = inner.filter((w) => w && w.length <= 24);
      if (good.length) return uniq(good);
    }

    // 6) 兜底：整段就是一个词（很短），否则按空格取最长的几段
    if (s.length <= 24 && !PUNCT.test(s)) return [s];
    const words = s.split(/\s+/).filter((w) => w && w.length <= 24 && !PUNCT.test(w));
    if (words.length) return uniq(words).slice(0, 20);

    return [];
  }

  /** 找 word 在 text 里的所有出现位置（区分大小写，纯文本匹配） */
  function occurrences(text, word) {
    const t = String(text || '');
    const w = String(word || '');
    const out = [];
    if (!w) return out;
    let from = 0;
    while (from <= t.length) {
      const i = t.indexOf(w, from);
      if (i < 0) break;
      out.push({ start: i, end: i + w.length });
      from = i + Math.max(1, w.length);
      if (out.length > 200) break;
    }
    return out;
  }

  /** 取词周围的上下文片段 */
  function contextOf(text, start, end, pad) {
    const p = pad == null ? 14 : pad;
    const t = String(text || '');
    const a = Math.max(0, start - p);
    const b = Math.min(t.length, end + p);
    return {
      before: (a > 0 ? '…' : '') + t.slice(a, start).replace(/\n/g, ' '),
      hit: t.slice(start, end),
      after: t.slice(end, b).replace(/\n/g, ' ') + (b < t.length ? '…' : ''),
    };
  }

  /**
   * 判断每个词在正文里有没有。
   * 混合判断：原文找得到算命中；原文找不到但「去掉空白后」找得到，也算命中（作者分段写导致）。
   * 两者都没有 → 疑似误报（站点按分词/联想报出来的词，正文里其实没有）。
   */
  function analyze(text, words) {
    const t = String(text || '');
    const squashed = squash(t);
    const list = (words || []).map((w) => {
      const word = clean(w);
      let pos = occurrences(t, word);
      let viaSquash = false;
      if (!pos.length && word.length >= 1) {
        const flat = squash(word);
        if (flat && squashed.includes(flat)) viaSquash = true;
      }
      const count = pos.length;
      const sample = count ? contextOf(t, pos[0].start, pos[0].end) : null;
      return {
        word,
        count,
        viaSquash,
        hit: count > 0 || viaSquash,
        positions: pos,
        ctx: sample,
      };
    });
    return {
      items: list,
      hits: list.filter((x) => x.hit),
      misses: list.filter((x) => !x.hit),
      total: list.length,
    };
  }

  /** 在词中间插一个点：血腥 → 血.腥；单字只能在后面加（字.） */
  function midDot(word) {
    const w = String(word || '');
    if (w.length <= 1) return w + '.';
    const at = Math.ceil(w.length / 2);
    return w.slice(0, at) + '.' + w.slice(at);
  }

  /** 近义候选；没有就返回空数组 */
  function synonyms(word) {
    const w = clean(word);
    if (SYNONYMS[w]) return SYNONYMS[w].slice();
    // 词里包含某个已知词时，给出整体替换建议（如「血液横飞」命中「血液」）
    const keys = Object.keys(SYNONYMS).filter((k) => w.includes(k) && k !== w);
    if (keys.length) {
      const k = keys.sort((a, b) => b.length - a.length)[0];
      return SYNONYMS[k].map((s) => w.split(k).join(s));
    }
    return [];
  }

  /**
   * 按计划改正文。
   * 模式：dot 词中插点 / synonym 近义替换 / del 直接删掉 / skip 不改
   * @param {string} text
   * @param {Array} plan [{ word, mode, target? }]
   */
  function applyPlan(text, plan) {
    let out = String(text || '');
    const changes = [];
    (plan || []).forEach((p) => {
      if (!p || !p.word || p.mode === 'skip') return;
      let target = '';
      if (p.mode === 'dot') target = midDot(p.word);
      else if (p.mode === 'del') target = '';
      else if (p.mode === 'synonym') {
        const cands = p.target ? [p.target] : synonyms(p.word);
        target = cands[0] || '';
      } else return;
      // 删除模式允许 to 为空串；其它模式换成空串等于误删，直接跳过
      if (p.mode !== 'del' && (!target || target === p.word)) return;
      if (p.mode === 'del' && !p.word) return;
      const before = out;
      out = out.split(p.word).join(target);
      if (out !== before) {
        changes.push({
          from: p.word,
          to: target,
          mode: p.mode,
          count: occurrences(before, p.word).length,
        });
      }
    });
    return { text: out, changes };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * 命中区间：把词表在正文里扫一遍，合并重叠，同一位置只留最长的那一个。
   *
   * 高亮渲染和右栏列表都要用这份结果，放一起免得两处各写一遍合并逻辑，
   * 最后出现「正文高亮 3 处、列表说 4 处」这种对不上的情况。
   *
   * @param {string} text
   * @param {Array<string>} words
   * @returns {Array<{word:string,start:number,end:number}>} 按位置升序
   */
  function hitRanges(text, words) {
    const t = String(text || '');
    const list = (words || []).map(clean).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!list.length) return [];

    const marks = [];
    list.forEach((w) => {
      occurrences(t, w).forEach((p) => marks.push({ word: w, start: p.start, end: p.end }));
    });
    if (!marks.length) return [];

    // 长的先来：同一位置被「血腥」和「血腥横飞」同时命中时，保留后者整段
    marks.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    marks.forEach((p) => {
      const last = merged[merged.length - 1];
      if (last && p.start < last.end) {
        if (p.end > last.end) last.end = p.end;
        return;
      }
      merged.push({ word: p.word, start: p.start, end: p.end });
    });
    return merged;
  }

  /**
   * 把正文渲染成带高亮的 HTML（只用于只读预览）。
   * @param {Object} opts { fixed: boolean } 处理后的预览用另一种配色
   */
  function highlightHtml(text, words, opts) {
    const o = opts || {};
    const t = String(text || '');
    const merged = hitRanges(t, words);
    if (!merged.length) return escapeHtml(t);

    const cls = o.fixed ? ' class="is-fixed"' : '';
    let out = '';
    let cursor = 0;
    merged.forEach((p) => {
      out += escapeHtml(t.slice(cursor, p.start));
      out += `<mark${cls}>${escapeHtml(t.slice(p.start, p.end))}</mark>`;
      cursor = p.end;
    });
    out += escapeHtml(t.slice(cursor));
    return out;
  }

  /** 处理成纯文本后，正文转成站点编辑器要的 HTML：空行分段 */
  function textToHtml(text) {
    const paras = String(text || '')
      .replace(/\r\n?/g, '\n')
      .split(/\n{1,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (!paras.length) return '<p><br></p>';
    return paras.map((p) => `<p>${escapeHtml(p).replace(/&lt;br&gt;/g, '<br>')}</p>`).join('');
  }

  const api = {
    parseHint,
    analyze,
    occurrences,
    contextOf,
    midDot,
    synonyms,
    applyPlan,
    highlightHtml,
    hitRanges,
    textToHtml,
    escapeHtml,
    squash,
    SYNONYMS,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BadWords = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
