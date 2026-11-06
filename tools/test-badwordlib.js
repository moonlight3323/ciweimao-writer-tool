'use strict';

/**
 * 敏感词库的单元测试（纯 Node，不启动 Electron）。
 *
 * 重点不是在「能存能读」，而是守住几条不能破的线：
 * 脏对象不能把正文带进来、归一化不能把该合并的拆开、上限淘汰不能把热词删掉、
 * 文件坏了不能让程序崩。
 *
 * 运行：node tools/test-badwordlib.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../src/main/badwordlib.js');

function tmpDir(tag) {
  const dir = path.join(os.tmpdir(), `cw-bw-${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readFileJson(dir) {
  return JSON.parse(fs.readFileSync(lib.filePath(dir), 'utf8'));
}

// ------------------------------------------------------------ 1. 白名单字段

test('白名单：脏对象里的 title / content / userName 一律不落盘', () => {
  const dir = tmpDir('safe');
  lib.addMany(dir, [
    { w: '血腥', hits: 2, title: '第六章', content: '正文全文……', userName: '某读者' },
    { w: '暴力', hits: 1, content: '又是一段正文' },
  ]);

  const raw = fs.readFileSync(lib.filePath(dir), 'utf8');
  assert.ok(!raw.includes('正文全文'), '正文内容不能出现在文件里');
  assert.ok(!raw.includes('某读者'), '读者昵称不能出现在文件里');
  assert.ok(!raw.includes('第六章'), '章节标题不能出现在文件里');

  const data = readFileJson(dir);
  const keys = Object.keys(data.words[0]).sort();
  assert.deepEqual(
    keys,
    ['first', 'hits', 'last', 'submitted', 'submittedAt', 'w'],
    '每条只允许这六个字段',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- 2. 去重累加

test('去重累加：两次写入 3 与 5，最终 hits=8，first 取早、last 取晚', () => {
  const dir = tmpDir('merge');
  lib.addMany(dir, [{ w: '血腥', hits: 3 }], '2026-11-05T10:00:00.000Z');
  lib.addMany(dir, [{ w: '血腥', hits: 5 }], '2026-11-06T09:00:00.000Z');

  const words = lib.list(dir);
  assert.equal(words.length, 1, '同一个词只能有一条记录');
  assert.equal(words[0].hits, 8);
  assert.equal(words[0].first, '2026-11-05T10:00:00.000Z', 'first 应取较早那次');
  assert.equal(words[0].last, '2026-11-06T09:00:00.000Z', 'last 应取较晚那次');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('倒序写入也不会把 first/last 弄反', () => {
  const dir = tmpDir('merge-rev');
  lib.addMany(dir, [{ w: '血腥' }], '2026-11-06T09:00:00.000Z');
  lib.addMany(dir, [{ w: '血腥' }], '2026-11-05T10:00:00.000Z');

  const w = lib.list(dir)[0];
  assert.equal(w.first, '2026-11-05T10:00:00.000Z');
  assert.equal(w.last, '2026-11-06T09:00:00.000Z');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 3. 归一化

test('归一化：前后空格视为同词，纯英文统一小写，中英混排保持原样', () => {
  const dir = tmpDir('norm');
  lib.addMany(dir, [{ w: ' 血腥 ' }, { w: '血腥' }, { w: 'ABC' }, { w: 'abc' }, { w: 'A站' }]);

  const words = lib.list(dir);
  const byWord = new Map(words.map((w) => [w.w, w]));

  assert.equal(byWord.has('血腥'), true, '「 血腥 」应归一化成「血腥」');
  assert.equal(byWord.get('血腥').hits, 2, '两次应合并成一条、hits 累加');
  assert.equal(byWord.has('abc'), true, 'ABC 与 abc 应视为同一个词');
  assert.equal(byWord.get('abc').hits, 2);
  assert.equal(byWord.has('A站'), true, '中英混排不转小写');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('归一化：空词与超长词直接丢弃', () => {
  const dir = tmpDir('drop');
  lib.addMany(dir, ['', '   ', 'x'.repeat(33), '正常词']);

  const words = lib.list(dir);
  assert.equal(words.length, 1);
  assert.equal(words[0].w, '正常词');

  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- 4. 上限淘汰

test('上限淘汰：5001 条只保留 4000 条，且淘汰的是 hits 最低的', () => {
  const dir = tmpDir('cap');
  const many = [];
  for (let i = 0; i <= 5000; i += 1) many.push({ w: `词${i}`, hits: i + 1 });
  lib.addMany(dir, many);

  const words = lib.list(dir);
  assert.equal(words.length, 4000, '超过 5000 条应裁剪到 4000 条');

  const minHits = Math.min(...words.map((w) => w.hits));
  assert.equal(minHits, 1002, '保留的应是 hits 最高的 4000 条');

  const kept = new Set(words.map((w) => w.w));
  assert.equal(kept.has('词0'), false, 'hits=1 的词应被淘汰');
  assert.equal(kept.has('词5000'), true, 'hits=5001 的词必须留下');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('未达上限时不做任何裁剪', () => {
  const dir = tmpDir('nocap');
  const many = [];
  for (let i = 0; i < 100; i += 1) many.push({ w: `词${i}`, hits: 1 });
  lib.addMany(dir, many);
  assert.equal(lib.list(dir).length, 100);

  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- 5. 清空

test('clear 清空后列表为空，stats 归零', () => {
  const dir = tmpDir('clear');
  lib.addMany(dir, ['血腥', '暴力']);
  assert.equal(lib.stats(dir).total, 2);

  lib.clear(dir);
  assert.deepEqual(lib.list(dir), []);
  assert.equal(lib.stats(dir).total, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('remove 只删指定词', () => {
  const dir = tmpDir('remove');
  lib.addMany(dir, ['血腥', '暴力']);
  lib.remove(dir, ' 血腥 ');

  const words = lib.list(dir);
  assert.equal(words.length, 1);
  assert.equal(words[0].w, '暴力');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ 6. 损坏恢复

test('文件损坏：list 不抛异常、返回空数组，并把坏文件改名留档', () => {
  const dir = tmpDir('corrupt');
  fs.writeFileSync(lib.filePath(dir), '{ 这不是合法 JSON', 'utf8');

  let words;
  assert.doesNotThrow(() => { words = lib.list(dir); });
  assert.deepEqual(words, []);

  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('badwords-local.corrupt-'));
  assert.equal(backups.length, 1, '坏文件应被改名留档，方便排查');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('结构不对（words 不是数组）也走恢复流程', () => {
  const dir = tmpDir('corrupt2');
  fs.writeFileSync(lib.filePath(dir), JSON.stringify({ schema: 1, words: 'oops' }), 'utf8');

  assert.deepEqual(lib.list(dir), []);
  assert.equal(lib.stats(dir).total, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('没有数据文件时视为空库，不产生任何文件', () => {
  const dir = tmpDir('fresh');
  assert.deepEqual(lib.list(dir), []);
  assert.equal(fs.existsSync(lib.filePath(dir)), false, '只读操作不该创建文件');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 统计

test('stats：submittable 是未提交数，submitted 默认 0', () => {
  const dir = tmpDir('stats');
  lib.addMany(dir, ['a', 'b', 'c']);

  const s = lib.stats(dir);
  assert.equal(s.total, 3);
  assert.equal(s.submitted, 0);
  assert.equal(s.submittable, 3);

  fs.rmSync(dir, { recursive: true, force: true });
});
