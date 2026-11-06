'use strict';

/**
 * 作品库自动补建的单元测试（纯 Node）。
 *
 * 这段逻辑的风险不在「能不能建」，而在「会不会多建一本」和「会不会绑错」——
 * 作品库里出现重名书，作者根本分不清该点哪本。所以下面的用例围着这两点写。
 *
 * 运行：node tools/test-writer-adopt.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const library = require('../src/main/library.js');

function tmpDir(tag) {
  const dir = path.join(os.tmpdir(), `cw-adopt-${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const remote = (id, name, chapters) => ({ bookId: id, name, chapters: chapters || 0, cover: '' });

test('平台新书（还没有章节）→ 本地建一本并绑好作品号', () => {
  const dir = tmpDir('new');

  const res = library.adoptPlatformBooks(dir, [remote('1001', '新书甲', 0)]);
  assert.equal(res.created.length, 1);
  assert.equal(res.linked.length, 0);

  const books = library.listBooks(dir);
  assert.equal(books.length, 1);
  assert.equal(books[0].name, '新书甲');
  assert.equal(books[0].platformBookId, '1001', '必须已经连到后台作品号');

  const full = library.getBook(dir, '1001');
  assert.ok(full && full.chapters.length === 1, '给一章空白章节方便直接开写');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('重复对账不会重复建书', () => {
  const dir = tmpDir('twice');
  const list = [remote('1001', '新书甲', 0)];

  library.adoptPlatformBooks(dir, list);
  const second = library.adoptPlatformBooks(dir, list);

  assert.equal(second.created.length, 0, '第二次应无新增');
  assert.equal(library.listBooks(dir).length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('平台上已有章节的老书不在本地建空壳，留给「同步」去拉正文', () => {
  const dir = tmpDir('old');

  const res = library.adoptPlatformBooks(dir, [remote('2002', '老书乙', 36)]);
  assert.equal(res.created.length, 0);
  assert.equal(res.linked.length, 0);
  assert.equal(library.listBooks(dir).length, 0, '不能用一个空壳把待同步入口顶掉');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('本地先有同名作品、之后才在后台建书 → 绑在一起，不重复建', () => {
  const dir = tmpDir('twin');
  const made = library.createBook(dir, '同名的书');
  const localId = made.book.bookId;

  const res = library.adoptPlatformBooks(dir, [remote('3003', '同名的书', 0)]);
  assert.equal(res.created.length, 0, '不该再建一本');
  assert.equal(res.linked.length, 1);
  assert.equal(res.linked[0].platformBookId, '3003');

  const books = library.listBooks(dir);
  assert.equal(books.length, 1, '作品库里只能有一本同名的书');
  assert.equal(String(books[0].bookId), String(localId), '保留作者原本那一本');
  assert.equal(books[0].platformBookId, '3003');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('本地同名但已经绑过别的作品 → 不抢绑，另建一本', () => {
  const dir = tmpDir('bind2');
  const made = library.createBook(dir, '撞名的书');
  library.saveBook(dir, Object.assign({}, library.getBook(dir, made.book.bookId), {
    platformBookId: '9001',
  }));

  const res = library.adoptPlatformBooks(dir, [remote('9002', '撞名的书', 0)]);
  assert.equal(res.linked.length, 0, '已绑定的书不能被改绑');
  assert.equal(res.created.length, 1, '另一本后台书应单独建出来');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('一次补多本：各自绑定各自的号，顺序不乱', () => {
  const dir = tmpDir('multi');

  const res = library.adoptPlatformBooks(dir, [
    remote('5001', '甲', 0),
    remote('5002', '乙', 0),
    remote('5003', '丙', 12), // 有章节，应跳过
  ]);

  assert.equal(res.created.length, 2);
  const books = library.listBooks(dir);
  const byName = new Map(books.map((b) => [b.name, b.platformBookId]));
  assert.equal(byName.get('甲'), '5001');
  assert.equal(byName.get('乙'), '5002');
  assert.equal(byName.has('丙'), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('清单里有脏数据也不崩', () => {
  const dir = tmpDir('dirty');

  const res = library.adoptPlatformBooks(dir, [
    null,
    undefined,
    { bookId: '', name: '没有号' },
    { bookId: '7001' },
  ]);

  assert.equal(res.created.length, 1, '只有带号的那条会被建');
  assert.equal(library.listBooks(dir)[0].name, '未命名作品');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('非数组入参按空清单处理', () => {
  const dir = tmpDir('bad');
  const res = library.adoptPlatformBooks(dir, null);
  assert.deepEqual(res, { created: [], linked: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});
