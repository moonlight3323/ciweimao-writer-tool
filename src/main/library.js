'use strict';

/**
 * 章节正文归档。
 *
 * 导出的 TXT 只写到用户选定的位置，应用内不留档 —— 于是「让 AI 汇总剧情」这件事
 * 无从下手（AI 拿不到正文）。这里把每次导出同时归档一份到 data/library/：
 *
 *   data/library/index.json          书目索引（书名、章数、字数、导出时间）
 *   data/library/<bookId>/book.json  章节正文，按 index 排好
 *
 * 设计取舍：
 * - 存 JSON 而不是拆成一章一个 txt。一本 300 章约 600KB，JSON 一次读完更省事，
 *   接口按 index 取单章也不用扫目录。
 * - 只保留最近 MAX_BOOKS 本，避免长期使用把磁盘堆满；移除的是最久未更新的那本。
 * - 这是本地缓存，用户可以在设置里一键清空。
 */

const fs = require('fs');
const path = require('path');

/** 最多保留几本书的归档 */
const MAX_BOOKS = 200;
/** 单本正文上限（防止异常数据写爆磁盘） */
const MAX_BOOK_BYTES = 20 * 1024 * 1024;

function safeId(bookId) {
  return String(bookId || '').replace(/[^0-9A-Za-z_-]/g, '') || 'unknown';
}

function libraryDir(dataDir) {
  return path.join(dataDir, 'library');
}

function indexPath(dataDir) {
  return path.join(libraryDir(dataDir), 'index.json');
}

function bookPath(dataDir, bookId) {
  return path.join(libraryDir(dataDir), safeId(bookId), 'book.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

/** 原子写：先写 .tmp 再改名，避免读到半个文件 */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

function readIndex(dataDir) {
  const idx = readJson(indexPath(dataDir), null);
  if (!idx || !Array.isArray(idx.books)) return { books: [], updatedAt: 0 };
  return idx;
}

/**
 * 归档一本书的正文。
 * @param {string} dataDir
 * @param {{bookId:string|number, name:string, chapters:Array}} payload
 */
function archive(dataDir, payload) {
  const p = payload || {};
  const bookId = safeId(p.bookId);
  const name = String(p.name || ('作品 ' + bookId));
  const list = Array.isArray(p.chapters) ? p.chapters : [];
  if (!list.length) throw new Error('没有可归档的章节');

  const chapters = list.map((c, i) => ({
    index: Number.isFinite(c.index) ? c.index : i + 1,
    title: String(c.title || ('第 ' + (i + 1) + ' 章')),
    words: Number.isFinite(c.words) ? c.words : String(c.content || '').length,
    content: String(c.content || ''),
  }));

  const old = readJson(bookPath(dataDir, bookId), null) || {};
  const now = Date.now();
  const book = {
    ...old,
    bookId,
    name,
    source: old.source || 'author',
    createdAt: old.createdAt || now,
    updatedAt: now,
    exportedAt: now,
    chapters,
  };
  let bytes = Buffer.byteLength(JSON.stringify(book), 'utf8');
  if (bytes > MAX_BOOK_BYTES) {
    throw new Error('这本书正文超过 20MB，未归档（可以分批导出）');
  }

  writeJson(bookPath(dataDir, bookId), book);

  // 更新索引
  const idx = readIndex(dataDir);
  const totalWords = chapters.reduce((s, c) => s + (c.words || 0), 0);
  const entry = {
    bookId,
    name,
    chapters: chapters.length,
    words: totalWords,
    source: book.source,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    exportedAt: book.exportedAt,
    bytes,
  };
  const rest = idx.books.filter((b) => String(b.bookId) !== bookId);
  rest.push(entry);
  rest.sort((a, b) => (b.exportedAt || 0) - (a.exportedAt || 0));

  // 超出上限时，把最久没更新的整本删掉
  const kept = rest.slice(0, MAX_BOOKS);
  const dropped = rest.slice(MAX_BOOKS);
  dropped.forEach((b) => {
    try {
      fs.rmSync(path.join(libraryDir(dataDir), safeId(b.bookId)), { recursive: true, force: true });
    } catch (_) { /* 删不掉就算了，下次还会再试 */ }
  });

  writeJson(indexPath(dataDir), { books: kept, updatedAt: Date.now() });
  return { bookId, chapters: chapters.length, words: totalWords, bytes, dropped: dropped.length };
}

function listBooks(dataDir) {
  return readIndex(dataDir).books;
}

function countWords(content) {
  return String(content || '').replace(/\s/g, '').length;
}

function makeLocalId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 写入整本作品，并同步书目索引。创作页的所有保存最终都走这里。 */
function saveBook(dataDir, payload) {
  const p = payload || {};
  const bookId = safeId(p.bookId || makeLocalId());
  const old = readJson(bookPath(dataDir, bookId), null) || {};
  const now = Date.now();
  const chapters = (Array.isArray(p.chapters) ? p.chapters : []).map((c, i) => {
    const content = String(c.content || '');
    return {
      index: i + 1,
      id: safeId(c.id || `chapter_${i + 1}`),
      title: String(c.title || `第${i + 1}章`),
      volume: String(c.volume || '正文'),
      words: countWords(content),
      content,
      updatedAt: Number(c.updatedAt) || now,
      status: String(c.status || ''),
      platformChapterId: String(c.platformChapterId || '').replace(/[^0-9A-Za-z_-]/g, ''),
      publishedAt: String(c.publishedAt || ''),
    };
  });
  const source = String(p.source || old.source || 'local');
  const book = {
    ...old,
    bookId,
    name: String(p.name || old.name || '未命名作品').trim() || '未命名作品',
    source,
    platformBookId: String(p.platformBookId || old.platformBookId || (source === 'author' ? bookId : ''))
      .replace(/[^0-9A-Za-z_-]/g, ''),
    createdAt: Number(old.createdAt) || Number(p.createdAt) || now,
    updatedAt: now,
    exportedAt: Number(old.exportedAt) || 0,
    chapters,
  };
  const bytes = Buffer.byteLength(JSON.stringify(book), 'utf8');
  if (bytes > MAX_BOOK_BYTES) throw new Error('这本书正文超过 20MB，请拆分后再导入');
  writeJson(bookPath(dataDir, bookId), book);

  const idx = readIndex(dataDir);
  const entry = {
    bookId,
    name: book.name,
    source: book.source,
    platformBookId: book.platformBookId,
    chapters: chapters.length,
    words: chapters.reduce((sum, c) => sum + c.words, 0),
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    exportedAt: book.exportedAt,
    bytes,
  };
  const books = idx.books.filter((b) => String(b.bookId) !== bookId);
  books.push(entry);
  books.sort((a, b) => (b.updatedAt || b.exportedAt || 0) - (a.updatedAt || a.exportedAt || 0));
  writeJson(indexPath(dataDir), { books: books.slice(0, MAX_BOOKS), updatedAt: now });
  return { book, entry };
}

function createBook(dataDir, name) {
  const now = Date.now();
  return saveBook(dataDir, {
    bookId: makeLocalId(),
    name,
    source: 'local',
    createdAt: now,
    chapters: [{ id: 'chapter_1', title: '第一章', volume: '正文', content: '', updatedAt: now }],
  });
}

function getBook(dataDir, bookId) {
  return readJson(bookPath(dataDir, bookId), null);
}

function deleteBook(dataDir, bookId) {
  const id = safeId(bookId);
  const idx = readIndex(dataDir);
  const exists = idx.books.some((b) => String(b.bookId) === id);
  if (!exists) return false;
  fs.rmSync(path.join(libraryDir(dataDir), id), { recursive: true, force: true });
  writeJson(indexPath(dataDir), {
    books: idx.books.filter((b) => String(b.bookId) !== id),
    updatedAt: Date.now(),
  });
  return true;
}

/** 章节目录（不含正文，避免接口一次吐出整本） */
function getBookToc(dataDir, bookId) {
  const book = readJson(bookPath(dataDir, bookId), null);
  if (!book) return null;
  return {
    bookId: book.bookId,
    name: book.name,
    exportedAt: book.exportedAt,
    chapters: (book.chapters || []).map((c) => ({
      index: c.index,
      title: c.title,
      words: c.words,
      chars: (c.content || '').length,
    })),
  };
}

/** 取单章正文 */
function getChapter(dataDir, bookId, index) {
  const book = readJson(bookPath(dataDir, bookId), null);
  if (!book) return null;
  const want = Number(index);
  const ch = (book.chapters || []).find((c) => Number(c.index) === want);
  if (!ch) return null;
  return {
    bookId: book.bookId,
    name: book.name,
    index: ch.index,
    title: ch.title,
    words: ch.words,
    content: ch.content,
  };
}

/** 多章合并（AI 做梗概时常要连续若干章） */
function getChapterRange(dataDir, bookId, from, to) {
  const book = readJson(bookPath(dataDir, bookId), null);
  if (!book) return null;
  const a = Number(from) || 1;
  const b = Number(to) || a;
  const chapters = (book.chapters || []).filter((c) => c.index >= a && c.index <= b);
  return {
    bookId: book.bookId,
    name: book.name,
    from: a,
    to: b,
    count: chapters.length,
    chapters: chapters.map((c) => ({ index: c.index, title: c.title, content: c.content })),
  };
}

function clearAll(dataDir) {
  const dir = libraryDir(dataDir);
  let removed = 0;
  try {
    const books = fs.readdirSync(dir);
    books.forEach((f) => {
      try {
        fs.rmSync(path.join(dir, f), { recursive: true, force: true });
        removed += 1;
      } catch (_) { /* ignore */ }
    });
  } catch (_) { /* 目录不存在 */ }
  return removed;
}

module.exports = {
  archive, listBooks, saveBook, createBook, getBook, deleteBook,
  getBookToc, getChapter, getChapterRange, clearAll,
  libraryDir, MAX_BOOKS,
};
