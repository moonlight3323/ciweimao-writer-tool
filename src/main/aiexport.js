'use strict';

/**
 * AI 素材包：把软件里的数据摊成「人也能看懂、AI 也能直接吃」的几份文件。
 *
 * 为什么不只做接口：网页版 AI 读不到本机端口，命令行 agent 也不一定愿意调接口。
 * 一份 CSV 加一份 Markdown，谁都能用 —— 拖进去、粘进去、或者让 agent 读文件都行。
 * 接口和 MCP 是在这个底座之上的加速器，不是替代品。
 *
 * 输出到 data/exports/ai/：
 *   README.md        目录说明 + 给 AI 的读法提示
 *   近7天趋势.csv    每本书每天的六项指标（带 BOM，Excel 直接开）
 *   评论摘要.md      规则分布、高风险原文、读者榜、按天分布
 *   章节素材.md      已归档书目的章节目录 + 每章开篇片段
 */

const fs = require('fs');
const path = require('path');
const library = require('./library');
const Reviewer = require('../renderer/reviewer');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function pct(n, d) {
  if (!d) return '0%';
  return Math.round((n / d) * 100) + '%';
}

function createAiexport(opts) {
  const o = opts || {};
  const getDataDir = o.getDataDir;
  const getVersion = o.getVersion || (() => '0.0.0');

  function outDir() {
    return path.join(getDataDir(), 'exports', 'ai');
  }

  function write(name, text, bom) {
    const dir = outDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, (bom ? '\ufeff' : '') + text, 'utf8');
    return { name, bytes: fs.statSync(file).size };
  }

  function snapshots() {
    const d = readJson(path.join(getDataDir(), 'stats-snapshots.json'));
    return (d && Array.isArray(d.snapshots)) ? d.snapshots : [];
  }

  function comments() {
    const d = readJson(path.join(getDataDir(), 'tsukkomi.json'));
    return (d && Array.isArray(d.items)) ? d.items : [];
  }

  function ranks() {
    const d = readJson(path.join(getDataDir(), 'rank-history.json'));
    return (d && Array.isArray(d.records)) ? d.records : [];
  }

  // ---------------------------------------------------------------- 趋势 CSV

  function trendCsv() {
    const snaps = snapshots();
    const head = '日期,书号,书名,字数,收藏,总订阅,新增订阅,章节均订,日均追订,单章最高订阅';
    const rows = [];
    // 取最近 7 个快照日
    snaps.slice(-7).forEach((s) => {
      (s.books || []).forEach((b) => {
        rows.push([
          s.day, b.bookId, `"${String(b.name || '').replace(/"/g, '""')}"`,
          b.words ?? '', b.collects ?? '', b.totalSubs ?? '', b.newSubs ?? '',
          b.avgSubs ?? '', b.dailyChase ?? '', b.maxSub ?? '',
        ].join(','));
      });
    });
    return [head].concat(rows).join('\r\n');
  }

  // ---------------------------------------------------------------- 评论摘要

  function commentDigest() {
    const items = comments();
    const raw = readJson(path.join(getDataDir(), 'tsukkomi.json')) || {};
    if (!items.length) {
      return '# 评论摘要\n\n还没有抓取过评论。在软件里「抓取与同步 → 开始抓取」之后再来生成。\n';
    }

    const r = Reviewer.review(items, {});
    const stat = r.stats || {};
    const L = [];

    L.push('# 评论摘要');
    L.push('');
    L.push(`- 抓取时间：${raw.syncedAt || '未知'}`);
    L.push(`- 评论总数：${items.length}`);
    L.push(`- 高风险：${stat.high || 0}　中风险：${stat.mid || 0}　无标记：${items.length - (stat.high || 0) - (stat.mid || 0)}`);
    L.push('');
    L.push('> 审查规则只标「辱骂 / 攻击 / 引流广告 / 剧透 / 刷屏 / 无依据指控」，');
    L.push('> 对作品的负面评价默认不视为违规。分数仅供参考，判断仍要看原文。');
    L.push('');

    // 规则分布
    const ruleMap = new Map();
    (r.items || []).forEach((x) => {
      (x.hits || []).forEach((h) => {
        const k = h.name || h.ruleId;
        ruleMap.set(k, (ruleMap.get(k) || 0) + 1);
      });
    });
    L.push('## 命中规则分布');
    L.push('');
    if (!ruleMap.size) {
      L.push('（没有任何评论命中规则）');
    } else {
      L.push('| 规则 | 条数 |');
      L.push('|---|---|');
      [...ruleMap.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
        L.push(`| ${k} | ${v} |`);
      });
    }
    L.push('');

    // 高风险原文
    const flagged = (r.items || []).filter((x) => x.level === 'high' || x.level === 'mid')
      .sort((a, b) => b.score - a.score).slice(0, 20);
    L.push(`## 需要看的原文（最多 20 条，共 ${flagged.length} 条有标记）`);
    L.push('');
    if (!flagged.length) {
      L.push('（没有命中规则的评论，评论区整体干净）');
    } else {
      flagged.forEach((x) => {
        const hits = (x.hits || []).map((h) => h.name).join('、');
        L.push(`- **[${x.level === 'high' ? '高' : '中'} ${x.score}]** ${x.nickname || '匿名'} `
          + `（${x.time || ''}｜${x.bookName || ''} ${x.chapterName || ''}）：${x.content}`);
        if (hits) L.push(`  - 命中：${hits}`);
      });
    }
    L.push('');

    // 读者榜
    const byReader = new Map();
    (r.items || []).forEach((x) => {
      const rid = String(x.readerId || '');
      if (!rid) return;
      const cur = byReader.get(rid) || { nickname: x.nickname, total: 0, flagged: 0 };
      cur.total += 1;
      if (x.level !== 'none') cur.flagged += 1;
      byReader.set(rid, cur);
    });
    const topReaders = [...byReader.entries()]
      .sort((a, b) => b[1].flagged - a[1].flagged || b[1].total - a[1].total)
      .slice(0, 10);
    L.push('## 发言最多的读者（按被标记数排）');
    L.push('');
    L.push('| 昵称 | 发言数 | 被标记 | 占比 |');
    L.push('|---|---|---|---|');
    topReaders.forEach(([, v]) => {
      L.push(`| ${v.nickname || '匿名'} | ${v.total} | ${v.flagged} | ${pct(v.flagged, v.total)} |`);
    });
    L.push('');

    // 按天
    const byDay = new Map();
    (r.items || []).forEach((x) => {
      const day = String(x.time || '').slice(0, 10);
      if (day) byDay.set(day, (byDay.get(day) || 0) + 1);
    });
    if (byDay.size) {
      L.push('## 按天分布');
      L.push('');
      L.push('| 日期 | 条数 |');
      L.push('|---|---|');
      [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).forEach(([d, n]) => {
        L.push(`| ${d} | ${n} |`);
      });
      L.push('');
    }

    return L.join('\n');
  }

  // ---------------------------------------------------------------- 章节素材

  function chapterMaterial() {
    const books = library.listBooks(getDataDir());
    const L = [];
    L.push('# 章节素材');
    L.push('');
    if (!books.length) {
      L.push('还没有归档任何正文。');
      L.push('');
      L.push('在软件里「章节导出」做一次导出，正文会自动归档到这里（不只写到你选的 TXT）。');
      L.push('归档之后，这份文件会列出章节目录与每章开篇，完整正文可以用接口 /v1/chapters/text 取。');
      return L.join('\n');
    }
    L.push(`已归档 ${books.length} 本，共 ${books.reduce((s, b) => s + (b.chapters || 0), 0)} 章。`);
    L.push('');
    books.forEach((b) => {
      const toc = library.getBookToc(getDataDir(), b.bookId);
      L.push(`## 《${b.name}》（书号 ${b.bookId}）`);
      L.push('');
      L.push(`- 章节数：${b.chapters}　总字数：${b.words}`);
      L.push(`- 导出时间：${new Date(b.exportedAt).toLocaleString('zh-CN')}`);
      L.push('');
      if (!toc) return;
      L.push('| 章 | 标题 | 字数 |');
      L.push('|---|---|---|');
      toc.chapters.forEach((c) => {
        L.push(`| ${c.index} | ${c.title} | ${c.words} |`);
      });
      L.push('');
    });
    L.push('---');
    L.push('');
    L.push('提示：要做剧情汇总，建议按区间取正文，例如先取 1–10 章，再逐步推进，');
    L.push('避免一次把整本塞进上下文。');
    return L.join('\n');
  }

  // ---------------------------------------------------------------- README

  function readme(files) {
    const books = library.listBooks(getDataDir());
    return [
      '# 这份文件夹是什么',
      '',
      `由「刺猬猫作家助手 v${getVersion()}」生成于 ${new Date().toLocaleString('zh-CN')}。`,
      '',
      '放在这里的东西就是给 AI 用的素材：你把它拖进对话框、或让 agent 读这个目录都行，',
      '不需要任何配置。',
      '',
      '## 文件',
      '',
      ...files.map((f) => `- \`${f.name}\`（${(f.bytes / 1024).toFixed(1)} KB）`),
      '',
      '## 怎么用',
      '',
      '**网页版 AI（豆包 / Kimi / ChatGPT 网页）**：直接把 Markdown 文件内容贴进去，',
      'CSV 用「上传文件」。它读不到你电脑上的任何东西，只能靠你递过去。',
      '',
      '**命令行 agent（dsh / Claude Code / Cursor 等）**：让它读这个目录即可，例如',
      '「读 <本目录>\\评论摘要.md，告诉我评论区主要在骂什么」。',
      '',
      '**想要更完整的数据**：在软件「设置 → AI 接入」里打开本机只读接口，',
      'agent 就能按需索取（评论可按规则筛、正文可按章取），不用你手动导。',
      '',
      '## 现在有什么数据',
      '',
      `- 评论：${comments().length} 条`,
      `- 数据快照：${snapshots().length} 天`,
      `- 榜单历史：${ranks().length} 天`,
      `- 已归档正文：${books.length} 本`,
      '',
      snapshots().length < 2
        ? '注意：快照不足两天，趋势类问题现在回答不了，需要软件连续采集几天。'
        : '',
      '',
    ].filter((x) => x !== '' || true).join('\n');
  }

  function generate() {
    const files = [];
    files.push(write('评论摘要.md', commentDigest(), false));
    files.push(write('章节素材.md', chapterMaterial(), false));
    files.push(write('近7天趋势.csv', trendCsv(), true));
    // README 最后写，这样能列出前面几个文件的大小
    files.push(write('README.md', readme(files), false));
    return { dir: outDir(), files };
  }

  return { generate, dir: outDir };
}

module.exports = { createAiexport };
