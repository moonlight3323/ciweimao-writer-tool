'use strict';

/**
 * 密码本按作者名排序与脱敏
 *
 * 两条底线：
 *   1. 密码永远不出现在对外字段里（这里一旦漏了，密码就会随 IPC 进渲染进程）；
 *   2. 有作者名的排在前面，让多账号用户一眼看到「哪个笔名对应哪条账号」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vo = require('../src/main/vault-order');

test('脱敏字段里绝不含密码', () => {
  const out = vo.redact({
    id: 'a1',
    username: 'me@example.com',
    secret: 'BASE64ENCRYPTEDPASSWORD',
    mode: 'email',
    authorName: '某某',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  assert.ok(!('secret' in out), '不能把 secret 透给界面');
  assert.equal(out.username, 'me@example.com');
  assert.equal(out.authorName, '某某');
  assert.equal(JSON.stringify(out).includes('BASE64ENCRYPTEDPASSWORD'), false);
});

test('有作者名的排在前面，未标记的沉底', () => {
  const list = vo.sortItems([
    { id: '1', username: 'no-name', updatedAt: '2026-03-01T00:00:00Z' },
    { id: '2', username: 'has-name', authorName: '乙作者', updatedAt: '2026-01-01T00:00:00Z' },
  ]);
  assert.equal(list[0].id, '2', '有作者名的优先，即使更久没用过');
  assert.equal(list[1].id, '1');
});

test('同为有作者名时按作者名分组，组内按最近使用', () => {
  const list = vo.sortItems([
    { id: 'a', username: 'u1', authorName: '甲', lastUsedAt: '2026-01-01T00:00:00Z' },
    { id: 'b', username: 'u2', authorName: '乙', lastUsedAt: '2026-05-01T00:00:00Z' },
    { id: 'c', username: 'u3', authorName: '甲', lastUsedAt: '2026-06-01T00:00:00Z' },
  ]);
  assert.deepEqual(list.map((x) => x.id), ['c', 'a', 'b'],
    '甲的两条在前（组内最近使用优先），乙在后');
});

test('未标记作者名的内部按最近使用排', () => {
  const list = vo.sortItems([
    { id: 'old', username: 'x', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'new', username: 'y', updatedAt: '2026-06-01T00:00:00Z' },
  ]);
  assert.deepEqual(list.map((x) => x.id), ['new', 'old']);
});

test('排序不修改入参', () => {
  const input = [{ id: '1', username: 'a' }, { id: '2', username: 'b', authorName: '甲' }];
  const copy = JSON.parse(JSON.stringify(input));
  vo.sortItems(input);
  assert.deepEqual(input, copy);
});

test('下拉文案：有作者名以作者名为主，没有则提示未标记', () => {
  assert.equal(vo.optionLabel({ username: 'abc', authorName: '笔名' }), '笔名 · abc');
  assert.equal(vo.optionLabel({ username: 'abc' }), 'abc · 未标作者名');
  assert.equal(vo.optionLabel({ username: 'same', authorName: 'same' }), 'same');
  assert.equal(vo.optionLabel({ username: 'me@x.com', authorName: '笔名', mode: 'email' }),
    '笔名 · me@x.com（邮箱登录）');
  assert.equal(vo.optionLabel(null), ' · 未标作者名');
});
