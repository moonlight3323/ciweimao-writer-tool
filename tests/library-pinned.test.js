'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const library = require('../src/main/library');

test('作品置顶状态会同时保存到索引和书籍正文元数据', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ciweimao-library-pin-'));
  try {
    const created = library.createBook(dir, '正在连载的书');
    const id = created.book.bookId;
    assert.equal(library.listBooks(dir)[0].pinned, false);

    const pinned = library.setPinned(dir, id, true);
    assert.equal(pinned.pinned, true);
    assert.equal(library.listBooks(dir)[0].pinned, true);
    assert.equal(library.getBook(dir, id).pinned, true);

    library.setPinned(dir, id, false);
    assert.equal(library.listBooks(dir)[0].pinned, false);
    assert.equal(library.getBook(dir, id).pinned, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
