'use strict';

/**
 * 评论 / 间贴审查引擎
 *
 * 规则层移植自「刺猬猫作者助手 v1.3.1」的 detector.js（拆分自其 NSIS → app-64.7z → app.asar），
 * 按本项目的契约重构：输出仍是 hits[{ruleId,name,severity,matched,note}] + score + level，
 * 下游（列表、筛选、执行台、信号）无需改动。
 *
 * 相比上一版的最大差别，是补上了这几样东西：
 *   1. 词库分层：L1 辱骂（单独即高分）/ L2 攻击性（需负面语境共现）/ L3 差评（只作辅助信号）。
 *      这样「写得太拖沓了」不会被当成辱骂，而「傻*逼作者」也跑不掉。
 *   2. 归一化：去空白与零宽字符、全角转半角、符号折叠，抵抗「傻 逼」「傻＊逼」「ｃｎｍ」这类规避。
 *   3. 减权：出现「不是骂你 / 个人看法 / 理性讨论」等缓和语时降 18 分。
 *   4. 严重指控单独成档：无证据的抄袭 / 洗稿 / 骗钱类指控，单独命中即需人工确认。
 *   5. 读者画像：按「负面占比」判断是不是专业带节奏的，而不是只看单条分数。
 *
 * 设计取向（沿用原工具的判断，也与本项目一致）：
 *   对「作品的负面评价」评分必须低。作者要控的是人身攻击、辱骂、广告、剧透、刷屏，不是差评。
 *   误删一条正常批评，比漏掉一条恶评代价大得多。
 */
(function (root) {
  // ------------------------------------------------------------ 词库

  // L1 明确辱骂 / 人身攻击：单独命中即高分
  const L1 = [
    '傻逼', '傻b', '煞笔', '沙比', '沙雕', '智障', '弱智', '脑残', '白痴', '低能',
    '废物', '垃圾作者', '狗作者', '死作者', '你妈', '尼玛', '你妈死了', 'cnm', 'nmsl',
    '操你', '草你', '去死', '死全家', '畜生', '杂种', '贱人', '贱货', '婊子', '婊',
    '蛆', '狗东西', '滚你妈', '狗屎', '屎一样', '一坨屎',
    '不要脸', '骗子作者', '骗钱', '圈钱',
    '脑子进水', '脑子有问题', '没脑子', '神经病', '缺心眼', '死妈', '草泥马',
    '你妈的', '他妈的作者', '烂人', '人渣', '乐色', '扑街作者',
  ];

  // L2 攻击性表达：需要与负面语境共现
  const L2 = [
    '写得什么', '什么垃圾', '浪费钱', '退钱', '别写了', '滚出', '封笔', '你配吗',
    '小学生文笔', '复制粘贴', '抄袭', '洗稿', '水文', '骗订阅', '智商税',
    '崩了', '烂尾', '烂书', '破书', '劝退', '毒点', '膈应', '有病',
    '夹带私货', '夹私货', '三观不正', '恶心人', '侮辱智商', '智商下线',
    '写的是啥', '写的啥', '写的什么玩意',
  ];

  // L3 负面评价：仅作辅助信号，不单独构成恶意
  const L3 = [
    '难看', '无聊', '拖沓', '水', '失望', '无语', '一般', '不行', '拉胯',
    '崩', '毒', '尬', '出戏', '降智', '凑字数', '注水', '看不下去', '弃书',
    '弃了', '弃坑', '老套', '俗套',
  ];

  // 广告 / 引流：按类别拆开，界面上的徽标才有区分度
  const ADS = {
    'ad-group': ['加群', 'qq群', 'q群', '微信群', '加微信', '加我', '私聊', '关注公众号'],
    'ad-link': ['http://', 'https://', 'www.', '点击链接', '扫码'],
    'ad-money': ['代写', '推广', '兼职', '日结', '刷单', '免费领取', '资源分享'],
  };

  const SPOILER = ['剧透', '后面死了', '结局是', '最后是', '凶手是', '答案是', '真相是'];

  /**
   * 严重指控：无证据的抄袭 / 洗钱类指责。
   * 这类牵扯名誉，误判代价高，所以单独成档并提示人工确认，而不是直接建议删除。
   */
  const SERIOUS = ['抄袭', '洗稿', '骗钱', '圈钱', '刷数据', '买榜'];

  /**
   * 明确的负面评价词（默认关闭，可在设置里开）。
   * 原工具里作者要求「说尴尬、说暴死这类也一并处理」，但这会把正常吐槽整片标红，
   * 所以本项目默认不启用，作为可选强度。
   * 注意不能用「崩坏」「烂」「水」这类会和作品名/常用字冲突的短词——
   * 原工具踩过「崩坏这边还真没搞懂」被判高危的坑（《崩坏》是作品名）。
   */
  const STRICT_NEG = [
    '尴尬', '暴死', '扑街', '凉了', '劝退', '弃书', '弃坑',
    '看不下去', '难看', '无聊', '垃圾', '废话', '水文', '注水',
    '拖沓', '烂尾', '崩了', '毒点', '降智', '出戏', '离谱',
    '幼稚', '中二', '羞耻', '拉胯', '白开水', '干瘪', '生硬',
    '太水', '很水', '太烂', '很烂', '烂透', '差劲',
    '橘子', '橘气', '变嫁', '药丸', '死路一条', '傻软', '野狗',
    '割头皮', '饭圈', '舔狗', '大小脑', '没长好',
    '恶心', '吐了', '臭不可闻', '一坨', '真恶心', '恶心死了', '令人作呕',
  ];

  /** 攻击对象：判断是否指向作者本人 */
  const TARGET_AUTHOR = ['作者', '你', '写手', '太太', '大大'];

  /** 缓和 / 免责表述：出现时降权（「不是骂你」「个人看法」） */
  const MITIGATE = ['不是骂', '别误会', '没有恶意', '个人看法', '仅供参考', '理性讨论', '说句公道话'];

  // ------------------------------------------------------------ 归一化

  /**
   * 归一化：让「傻 逼」「ｃｎｍ」这类规避写法也能命中词库。
   * 只做字符层面的清理，不改动词序，避免把正常句子误伤。
   */
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      // 空白与零宽 / 方向控制字符
      .replace(/[\s\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
      // 重复符号折叠：*** ××× 。。。
      .replace(/[＊*×]{2,}/g, '*')
      .replace(/[·•。]{2,}/g, '')
      // 全角数字/字母 → 半角
      .replace(/[\uff01-\uff5e]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
      });
  }

  /**
   * 宽松版归一化：在 norm 之上把用来隔断的字也去掉。
   *
   * 原工具只把连续符号折叠成一个 '*'，于是「傻*逼」「傻**逼」归一后仍是「傻*逼」，
   * 和词库里的「傻逼」对不上——等于没防住最常用的那种规避写法。
   * 这里额外给一条通道：去掉 * × 与汉字之间的 x，让「傻*逼」「傻xx逼」都能命中。
   */
  function normLoose(s) {
    return norm(s)
      .replace(/[＊*×·•。.,，、~\-_|/\\]/g, '')
      // 只删夹在两个汉字中间的 x，避免把英文单词拆坏
      .replace(/([\u4e00-\u9fa5])[xX](?=[\u4e00-\u9fa5])/g, '$1');
  }

  /** 词表命中（同时查严格与宽松两种归一化结果） */
  function scan(text, words, looseText) {
    const hit = [];
    const loose = looseText == null ? normLoose(text) : looseText;
    for (let i = 0; i < words.length; i += 1) {
      const w = norm(words[i]);
      if (!w) continue;
      if (text.indexOf(w) >= 0 || loose.indexOf(w) >= 0) hit.push(words[i]);
    }
    return hit;
  }

  // ------------------------------------------------------------ 单条判定

  const DEFAULT_CONFIG = {
    // 高危线：对应原工具的「建议处理」
    high: 70,
    // 中危线：对应原工具的「可疑」。
    // 原代码默认 55，但它自己的《使用须知》写的是「45~69 为可疑」，
    // 按 55 取会让剧透(46)、严重指控(54)、广告(66) 全都落不到中风险，故按说明书取 45。
    mid: 45,
    // 把「尴尬 / 暴死 / 扑街」这类负面评价也计入（默认关，见 STRICT_NEG 注释）
    strictNegative: false,
    customWords: [],
    protectedReaders: [],
  };

  /**
   * 单条内容打分。
   * @returns {{score:number, hits:Array, reasons:string[]}}
   */
  function checkOne(rawContent, cfg) {
    const raw = String(rawContent || '');
    const s = norm(raw);
    const hits = [];
    const reasons = [];
    let score = 0;

    if (!s) return { score: 0, hits: [], reasons: ['空内容'] };

    // 1) L1 辱骂：单独即高分
    const hitL1 = scan(s, L1);
    if (hitL1.length) {
      const pts = 72 + Math.min(18, (hitL1.length - 1) * 9);
      score += pts;
      hits.push({
        ruleId: 'attack',
        name: '人身攻击',
        severity: pts,
        matched: hitL1.slice(0, 3).join('、'),
        note: '含明确辱骂用语',
      });
      reasons.push('含人身攻击词：' + hitL1.slice(0, 3).join('、'));
    }

    // 2) L2 攻击性表达：单独出现只记轻分，和负面语境共现才加重
    const hitL2 = scan(s, L2);
    if (hitL2.length) {
      const negative = hitL2.length >= 2 || hitL1.length > 0 || scan(s, L3).length > 0;
      const pts = negative ? 22 + Math.min(16, (hitL2.length - 1) * 6) : 8;
      score += pts;
      hits.push({
        ruleId: 'attack-soft',
        name: '攻击性表达',
        severity: pts,
        matched: hitL2.slice(0, 3).join('、'),
        note: negative ? '伴随负面语境' : '单独出现，权重较低',
      });
      reasons.push('含攻击性表达：' + hitL2.slice(0, 3).join('、'));
    }

    // 2.5) 无证据的严重指控
    const hitSerious = scan(s, SERIOUS);
    if (hitSerious.length && !hitL1.length) {
      score += 46;
      hits.push({
        ruleId: 'accuse',
        name: '严重指控',
        severity: 46,
        matched: hitSerious.slice(0, 2).join('、'),
        note: '牵扯名誉，建议先核实再处理',
      });
      reasons.push('含严重指控：' + hitSerious.slice(0, 2).join('、'));
    }

    // 3) L3 纯负面评价：低权重
    const hitL3 = scan(s, L3);
    if (hitL3.length && !hitL1.length && !hitL2.length) {
      const pts = Math.min(14, 5 + hitL3.length * 3);
      score += pts;
      hits.push({
        ruleId: 'negative',
        name: '负面评价',
        severity: pts,
        matched: hitL3.slice(0, 3).join('、'),
        note: '对作品的评价，通常不需要处理',
      });
      reasons.push('负面评价：' + hitL3.slice(0, 3).join('、'));
    }

    // 4) 广告引流
    Object.keys(ADS).forEach(function (ruleId) {
      const found = scan(s, ADS[ruleId]);
      if (!found.length) return;
      let pts = 66 + Math.min(20, (found.length - 1) * 10);
      // 光一个「推广」可能是正常讨论；但带外链或长数字（群号、QQ）就是铁证，直接上高危线
      if (/https?:\/\/|www\./.test(s) || /\d{5,}/.test(s)) pts = Math.max(pts, 72);
      score += pts;
      hits.push({
        ruleId: ruleId,
        name: ruleId === 'ad-group' ? '引流加群' : ruleId === 'ad-link' ? '外部链接' : '利益诱导',
        severity: pts,
        matched: found.slice(0, 3).join('、'),
        note: '引导读者离开平台或涉及交易',
      });
      reasons.push('疑似广告引流：' + found.slice(0, 3).join('、'));
    });

    // 5) 剧透
    const hitSp = scan(s, SPOILER);
    if (hitSp.length) {
      score += 46;
      hits.push({
        ruleId: 'spoiler',
        name: '剧透',
        severity: 46,
        matched: hitSp.slice(0, 2).join('、'),
        note: '可能破坏他人阅读体验',
      });
      reasons.push('含剧透内容');
    }

    // 6) 刷屏：同字符 / 短语重复 / 字符多样性过低
    const repeatChar = raw.match(/(.)\1{6,}/);
    if (repeatChar) {
      score += 20;
      hits.push({
        ruleId: 'spam-char',
        name: '重复刷屏',
        severity: 20,
        matched: repeatChar[0].slice(0, 12),
        note: '同一字符重复 7 次以上',
      });
      reasons.push('存在重复刷屏字符');
    }
    const repeatPhrase = raw.match(/(.{2,8})\1{3,}/);
    if (repeatPhrase && !repeatChar) {
      score += 50;
      hits.push({
        ruleId: 'spam-phrase',
        name: '复读刷屏',
        severity: 50,
        matched: repeatPhrase[0].slice(0, 16),
        note: '同一短语重复 4 次以上',
      });
      reasons.push('存在重复短语刷屏');
    }
    if (raw.length > 12 && new Set(raw).size / raw.length < 0.22) {
      score += 14;
      hits.push({
        ruleId: 'spam-dup',
        name: '字符重复率异常',
        severity: 14,
        matched: '',
        note: '用字过于单一',
      });
      reasons.push('字符重复率异常');
    }

    // 7) 情绪强度：只加分，不单独成案
    const bang = (raw.match(/[!！]/g) || []).length;
    const ques = (raw.match(/[?？]/g) || []).length;
    if (bang >= 4 || ques >= 5) {
      const pts = (bang >= 4 ? 10 : 0) + (ques >= 5 ? 6 : 0);
      score += pts;
      if (hitL1.length || hitL2.length) {
        hits.push({
          ruleId: 'emotion',
          name: '情绪激烈',
          severity: pts,
          matched: bang >= 4 ? '感叹号堆叠' : '连续质问',
          note: '配合攻击性用语时加重',
        });
      }
      reasons.push(bang >= 4 ? '感叹号堆叠，情绪激烈' : '连续质问');
    }

    // 8) 指向作者的直接攻击
    if (hitL1.length && scan(s, TARGET_AUTHOR).length) {
      score += 10;
      hits.push({
        ruleId: 'attack-target',
        name: '指向作者',
        severity: 10,
        matched: '作者 / 你',
        note: '攻击对象是作者本人',
      });
      reasons.push('攻击对象指向作者本人');
    }

    // 9) 缓和语：减权
    const hitMiti = scan(s, MITIGATE);
    if (hitMiti.length) {
      score -= 18;
      reasons.push('含缓和/免责表述，已降权');
    }

    // 10) 极短且纯情绪：封顶，避免「y」「6」这类正常吐槽被顶上去
    if (raw.length <= 4 && !hitL1.length && !hitL2.length) {
      score = Math.min(score, 18);
    }

    // 11) 可选：把明确负面评价一并计入
    if (cfg.strictNegative) {
      const hitStrict = scan(s, STRICT_NEG);
      if (hitStrict.length && score < 72) {
        const pts = 72 + Math.min(18, (hitStrict.length - 1) * 6);
        score = pts;
        hits.push({
          ruleId: 'negative-strict',
          name: '负面评价（已计入）',
          severity: pts,
          matched: hitStrict.slice(0, 3).join('、'),
          note: '设置里开启了「负面评价也计入」',
        });
        reasons.push('负面评价：' + hitStrict.slice(0, 3).join('、'));
      }
    }

    // 12) 自定义词
    if (cfg.customWords.length) {
      const hitCustom = scan(s, cfg.customWords);
      if (hitCustom.length) {
        const pts = 40 + (hitCustom.length - 1) * 10;
        score += pts;
        hits.push({
          ruleId: 'custom',
          name: '自定义词',
          severity: pts,
          matched: hitCustom.slice(0, 3).join('、'),
          note: '来自设置里的自定义词表',
        });
        reasons.push('命中自定义词：' + hitCustom.slice(0, 3).join('、'));
      }
    }

    return { score: Math.max(0, Math.min(100, Math.round(score))), hits, reasons };
  }

  // ------------------------------------------------------------ 读者画像

  /**
   * 拿一个读者发过的全部内容，判断是不是「专业带节奏的」。
   * 正常读者即使偶尔发牢骚，也不会七成以上都在唱衰。
   */
  function analyzeReader(contents, opts) {
    const o = opts || {};
    const threshold = o.threshold == null ? 0.7 : o.threshold;
    const list = (contents || []).filter((c) => typeof c === 'string' && c.trim());
    if (!list.length) {
      return { verdict: 'insufficient', ratio: 0, total: 0, negative: 0, worst: 0, note: '没有样本' };
    }

    const scores = list.map((c) => checkOne(c, Object.assign({}, DEFAULT_CONFIG, { strictNegative: true })).score);
    const negative = scores.filter((v) => v >= 45).length;
    const worst = Math.max.apply(null, scores);
    const ratio = negative / list.length;

    if (list.length === 1) {
      if (worst >= 80) {
        return { verdict: 'suspect', ratio: 1, total: 1, negative: 1, worst, note: '仅 1 条但性质恶劣，建议人工看一眼' };
      }
      return { verdict: 'insufficient', ratio: 0, total: 1, negative: 0, worst, note: '只有 1 条且性质不严重，暂不判定' };
    }
    if (list.length === 2) {
      if (ratio >= 0.5 || worst >= 80) {
        return {
          verdict: 'suspect', ratio, total: 2, negative, worst,
          note: ratio >= 0.5 ? '2 条里一半以上负面，列为可疑' : '含极恶劣言论，列为可疑',
        };
      }
      return { verdict: 'insufficient', ratio, total: 2, negative, worst, note: '样本偏少，暂不判定' };
    }

    const verdict = ratio >= threshold ? 'rhythm-troll' : ratio >= 0.45 ? 'suspect' : 'normal';
    return {
      verdict,
      ratio: Math.round(ratio * 100) / 100,
      total: list.length,
      negative,
      worst,
      note:
        verdict === 'rhythm-troll'
          ? '负面占比 ' + Math.round(ratio * 100) + '%，像专业带节奏'
          : verdict === 'suspect'
            ? '负面占比 ' + Math.round(ratio * 100) + '%，有嫌疑但不够确凿'
            : '负面占比 ' + Math.round(ratio * 100) + '%，看起来是正常读者',
    };
  }

  // ------------------------------------------------------------ 批量入口

  /**
   * 审查一批间贴 / 评论。
   * @param {Array} items 适配层产出（需含 content / readerId / nickname）
   * @param {Object} opts { high, mid, strictNegative, customWords, protectedReaders }
   * @returns {Object} { items, stats } —— 契约与上一版一致
   */
  function review(items, opts) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, opts || {});
    const high = Number(cfg.high) || DEFAULT_CONFIG.high;
    const mid = Number(cfg.mid) || DEFAULT_CONFIG.mid;
    const protectedSet = new Set((cfg.protectedReaders || []).map(String));

    // 行为维度预统计：单读者发言量、相同内容重复次数
    const byReader = new Map();
    const byContent = new Map();
    for (const it of items) {
      const rid = it.readerId || 'unknown';
      byReader.set(rid, (byReader.get(rid) || 0) + 1);
      const c = String(it.content || '').trim();
      if (c) byContent.set(c, (byContent.get(c) || 0) + 1);
    }

    const out = [];
    for (const it of items) {
      const content = String(it.content || '').trim();
      const r = checkOne(content, cfg);
      let score = r.score;
      const hits = r.hits.slice();

      // 行为规则一：本批里同一读者发言量异常
      const mine = byReader.get(it.readerId || 'unknown') || 0;
      if (mine >= 40) {
        score += 30;
        hits.push({ ruleId: 'behavior-flood', name: '高频发言', severity: 30, matched: '本批 ' + mine + ' 次', note: '单读者发言量异常，疑似刷屏' });
      } else if (mine >= 20) {
        score += 15;
        hits.push({ ruleId: 'behavior-flood', name: '高频发言', severity: 15, matched: '本批 ' + mine + ' 次', note: '发言量偏高' });
      }

      // 行为规则二：完全相同的长内容反复出现（短梗不算）
      if (content.length >= 8) {
        const dup = byContent.get(content) || 0;
        if (dup >= 4) {
          score += 20;
          hits.push({ ruleId: 'behavior-dup', name: '内容复读', severity: 20, matched: '相同内容 ' + dup + ' 次', note: '疑似复制刷屏' });
        }
      }

      // 保护名单：直接压到低风险
      const protectedUser = protectedSet.has(String(it.readerId || '')) || protectedSet.has(String(it.nickname || ''));
      if (protectedUser) {
        score = Math.min(score, 20);
        hits.push({ ruleId: 'protected', name: '保护名单', severity: 0, matched: String(it.nickname || ''), note: '该读者在保护名单中' });
      }

      score = Math.max(0, Math.min(100, Math.round(score)));
      const level = score >= high ? 'high' : score >= mid ? 'mid' : 'none';

      out.push(Object.assign({}, it, { score, level, hits }));
    }

    // ---- 汇总 ----
    const flagged = out.filter((x) => x.level !== 'none');

    // 读者聚合：条数、标记数、最高分、负面占比、带节奏判定
    const readerAgg = new Map();
    for (const x of out) {
      const rid = x.readerId || 'unknown';
      const rec = readerAgg.get(rid) || {
        readerId: rid,
        nickname: x.nickname,
        total: 0,
        flagged: 0,
        score: 0,
        negative: 0,
        contents: [],
      };
      rec.total += 1;
      if (x.level !== 'none') rec.flagged += 1;
      if (x.score >= 45) rec.negative += 1;
      rec.score = Math.max(rec.score, x.score);
      if (x.content) rec.contents.push(x.content);
      readerAgg.set(rid, rec);
    }

    const readers = [...readerAgg.values()].map((r) => {
      const judge = analyzeReader(r.contents, {});
      return {
        readerId: r.readerId,
        nickname: r.nickname,
        total: r.total,
        flagged: r.flagged,
        score: r.score,
        negative: r.negative,
        ratio: judge.ratio,
        verdict: judge.verdict,
        note: judge.note,
      };
    });

    const likelyBadReaders = readers
      .filter((r) => r.flagged >= 2 || r.score >= high || r.verdict === 'rhythm-troll' || r.verdict === 'suspect')
      .sort((a, b) => b.flagged - a.flagged || b.ratio - a.ratio || b.score - a.score);

    return {
      items: out,
      stats: {
        total: out.length,
        high: out.filter((x) => x.level === 'high').length,
        mid: out.filter((x) => x.level === 'mid').length,
        readers: readerAgg.size,
        suspiciousReaders: likelyBadReaders.length,
        topRules: summarizeRules(flagged),
        likelyBadReaders: likelyBadReaders.slice(0, 30),
        config: { high, mid, strictNegative: !!cfg.strictNegative },
      },
    };
  }

  function summarizeRules(flagged) {
    const m = new Map();
    for (const x of flagged) {
      for (const h of x.hits) {
        if (h.ruleId === 'protected') continue;
        const rec = m.get(h.ruleId) || { ruleId: h.ruleId, name: h.name, count: 0 };
        rec.count += 1;
        m.set(h.ruleId, rec);
      }
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }

  const api = {
    review,
    checkOne,
    analyzeReader,
    norm,
    DEFAULT_CONFIG,
    LEX: { L1, L2, L3, ADS, SPOILER, SERIOUS, STRICT_NEG, TARGET_AUTHOR, MITIGATE },
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Reviewer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
