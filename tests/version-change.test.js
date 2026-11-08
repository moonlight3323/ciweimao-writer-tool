'use strict';

/**
 * 启动时「版本变了」的判定
 *
 * 这是第 3 项改造的核心：软件自己装的更新不该打扰用户，
 * 用户手动下载覆盖的才需要问一句「要不要接着用旧数据」。
 * 判错的后果两头都不好受——自动更新弹窗会天天烦人，
 * 手动安装不弹窗则可能让用户以为数据丢了。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const updater = require('../src/main/updater');

test('首次运行不询问', () => {
  const r = updater.decideVersionChange({ current: '1.0.5', last: '' });
  assert.equal(r.kind, 'first-run');
});

test('版本没变不询问', () => {
  const r = updater.decideVersionChange({ current: '1.0.5', last: '1.0.5' });
  assert.equal(r.kind, 'same-version');
  assert.equal(r.direction, 'same');
});

test('软件自己装的更新直接跳过询问', () => {
  const r = updater.decideVersionChange({
    current: '1.0.6', last: '1.0.5', autoInstalled: true,
  });
  assert.equal(r.kind, 'auto-update');
  assert.equal(r.direction, 'up');
  assert.equal(r.from, '1.0.5');
  assert.equal(r.to, '1.0.6');
});

test('手动下载安装要询问', () => {
  const r = updater.decideVersionChange({
    current: '1.0.6', last: '1.0.5', autoInstalled: false,
  });
  assert.equal(r.kind, 'manual-update');
  assert.equal(r.direction, 'up');
});

test('手动降级也算手动安装，方向标成 down', () => {
  const r = updater.decideVersionChange({
    current: '1.0.3', last: '1.0.6', autoInstalled: false,
  });
  assert.equal(r.kind, 'manual-update');
  assert.equal(r.direction, 'down', '降级要让界面能说清楚');
});

test('版本号写坏时按升级处理，仍然询问', () => {
  const r = updater.decideVersionChange({
    current: '1.0.x', last: '1.0.5', autoInstalled: false,
  });
  assert.equal(r.kind, 'manual-update');
  assert.equal(r.direction, 'up', '解析不了就当成升级，问一句比不问安全');
});

test('自动更新标记优先于手动判断', () => {
  // 更新器写了 installing 状态但版本号方向看起来像降级（回滚场景），
  // 仍然应该认定是软件自己装的，不要拿弹窗打扰用户
  const r = updater.decideVersionChange({
    current: '1.0.4', last: '1.0.5', autoInstalled: true,
  });
  assert.equal(r.kind, 'auto-update');
  assert.equal(r.direction, 'down');
});
