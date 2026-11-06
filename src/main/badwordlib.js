'use strict';

/**
 * 本地敏感词库。
 *
 * 只存「词」本身，不存正文、不存账号：站点在发布校验时返回的 hint_words
 * 已经足够说明哪些词被拦，正文留在用户自己的稿件里，不往这里搬。
 *
 * 文件：data/badwords-local.json
 *   { schema: 1, words: [{ w, hits, first, last, submitted, submittedAt }] }
 *
 * 几个刻意的取舍：
 * - 一切写盘失败都静默：这个库是副产品，不能因为磁盘写不进去就打断作者发布。
 * - 用白名单构造对象（pick），绝不用 delete 删字段 —— 上游万一塞进来整段正文，
 *   白名单天然挡得住，delete 则容易漏。
 * - 文件损坏不当异常处理：改名留档 + 重建空库，用户下次照常使用。
 */

const fs = require('fs');
const path = require('path');

const FILE = 'badwords-local.json';
const SCHEMA = 1;
/** 触发淘汰的条数 */
const MAX_WORDS = 5000;
/** 淘汰后保留的条数（留出余量，避免每次新增都触发一次全量排序） */
const KEEP_WORDS = 4000;
/** 单个词的字符上限，超过基本是误抓的整段文本 */
const MAX_LEN = 32;

function filePath(dataDir) {
  return path.join(dataDir, FILE);
}

/**
 * 归一化：先 trim；整词都是英文字母时转小写，其余字符原样保留。
 *
 * 中文不分大小写，转小写反而会把「ABC」和「abc」这种英文缩写合并 —— 这是想要的；
 * 但中英混排（如「A站」）不转，避免把有意义的写法改掉。
 */
function normalize(word) {
  let s = String(word == null ? '' : word).trim();
  if (!s) return '';
  if (/^[A-Za-z]+$/.test(s)) s = s.toLowerCase();
  if (s.length > MAX_LEN) return '';
  return s;
}

/** 白名单：只保留约定字段，其余键一律不带进来 */
function pick(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    w: String(o.w == null ? '' : o.w),
    hits: Math.max(0, Math.floor(Number(o.hits) || 0)),
    first: String(o.first == null ? '' : o.first),
    last: String(o.last == null ? '' : o.last),
    submitted: o.submitted === true,
    submittedAt: String(o.submittedAt == null ? '' : o.submittedAt),
  };
}

function emptyLib() {
  return { schema: SCHEMA, words: [] };
}

function writeLib(dataDir, lib) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = filePath(dataDir);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(lib, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false; // 静默：写不进去就当这次没收集到
  }
}

/** 损坏文件改名留档，然后重建空库。任何一步失败都不往外抛 */
function recover(dataDir) {
  const file = filePath(dataDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    if (fs.existsSync(file)) {
      fs.renameSync(file, path.join(dataDir, `badwords-local.corrupt-${stamp}`));
    }
  } catch (_) { /* 改名失败就让它留着，反正下次还会走这里 */ }
  writeLib(dataDir, emptyLib());
  return emptyLib();
}

function readLib(dataDir) {
  let raw;
  try {
    raw = fs.readFileSync(filePath(dataDir), 'utf8');
  } catch (_) {
    return emptyLib(); // 没有文件 = 空库，属于正常状态
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return recover(dataDir); // 解析失败：留档重建，不抛异常
  }
  if (!data || !Array.isArray(data.words)) return recover(dataDir);

  return {
    schema: SCHEMA,
    words: data.words.map(pick).filter((w) => w.w),
  };
}

// ------------------------------------------------------------------ 对外接口

function list(dataDir) {
  return readLib(dataDir).words;
}

/**
 * 批量写入。
 *
 * @param {string} dataDir
 * @param {Array<string|{w:string,hits?:number}>} words 字符串按出现 1 次计
 * @param {string} [nowIso] 时间戳，缺省取当前时间（测试里可注入以便断言 first/last）
 * @returns {{added:number, merged:number}}
 */
function addMany(dataDir, words, nowIso) {
  const now = String(nowIso || new Date().toISOString());
  const lib = readLib(dataDir);
  const map = new Map();
  lib.words.forEach((w) => { if (!map.has(w.w)) map.set(w.w, w); });

  let added = 0;
  let merged = 0;

  (Array.isArray(words) ? words : []).forEach((raw) => {
    const isObj = raw && typeof raw === 'object';
    const w = normalize(isObj ? raw.w : raw);
    if (!w) return;
    const inc = isObj ? Math.max(1, Math.floor(Number(raw.hits) || 1)) : 1;

    const hit = map.get(w);
    if (hit) {
      hit.hits += inc;
      // 首次时间取更早的，末次取更晚的：乱序写入也不会把区间弄反
      if (!hit.first || now < hit.first) hit.first = now;
      if (!hit.last || now > hit.last) hit.last = now;
      merged += 1;
    } else {
      map.set(w, {
        w,
        hits: inc,
        first: now,
        last: now,
        submitted: false,
        submittedAt: '',
      });
      added += 1;
    }
  });

  let entries = Array.from(map.values());
  if (entries.length > MAX_WORDS) {
    // hits 高的留下；撞车时最近出现的优先，保证淘汰的是「又少又旧」的那批
    entries.sort((a, b) => (b.hits - a.hits) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
    entries = entries.slice(0, KEEP_WORDS);
  }

  writeLib(dataDir, { schema: SCHEMA, words: entries });
  return { added, merged };
}

function stats(dataDir) {
  const words = readLib(dataDir).words;
  const submitted = words.filter((w) => w.submitted).length;
  return {
    total: words.length,
    submittable: words.length - submitted,
    submitted,
  };
}

function remove(dataDir, word) {
  const w = normalize(word);
  if (!w) return { removed: 0 };
  const lib = readLib(dataDir);
  const next = lib.words.filter((x) => x.w !== w);
  writeLib(dataDir, { schema: SCHEMA, words: next });
  return { removed: lib.words.length - next.length };
}

function clear(dataDir) {
  writeLib(dataDir, emptyLib());
  return { ok: true };
}

function dir(dataDir) {
  return filePath(dataDir);
}

module.exports = {
  FILE,
  SCHEMA,
  MAX_WORDS,
  KEEP_WORDS,
  MAX_LEN,
  normalize,
  filePath,
  readLib,
  list,
  addMany,
  stats,
  remove,
  clear,
  dir,
};
