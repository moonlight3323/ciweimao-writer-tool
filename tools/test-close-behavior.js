'use strict';

/**
 * 「点关闭按钮之后干什么」的判定（src/main/closebehavior.js）。
 *
 * 这块线上错过两次：
 *   1. 关窗后进程不退出（侧栏窗口让 window-all-closed 不触发）
 *   2. 设置成「直接退出」后，窗口关了但进程留在托盘，点图标还能拉起来
 * 两次都只在真点关闭时才复现，本机没有 GUI 自动化能覆盖，所以把判定抽成纯函数盯住。
 */

const test = require('node:test');
const assert = require('node:assert');

const { decide } = require('../src/main/closebehavior.js');

test('正在退出流程中：直接放行，不再拦', () => {
  assert.equal(decide(true, 'minimize'), 'pass');
  assert.equal(decide(true, 'quit'), 'pass');
  assert.equal(decide(true, ''), 'pass');
});

test('偏好是「直接退出」：放行关闭（第 2 次踩坑就踩在这里）', () => {
  assert.equal(decide(false, 'quit'), 'pass');
});

test('偏好是「最小化到托盘」：拦下来收起窗口', () => {
  assert.equal(decide(false, 'minimize'), 'hide');
});

test('还没问过：拦下来先问', () => {
  assert.equal(decide(false, ''), 'ask');
});

test('偏好里是脏值也当成没问过，不能瞎收起窗口', () => {
  ['close', 'exit', 'QUIT', null, undefined, 0, {}].forEach((v) => {
    assert.equal(decide(false, v), 'ask', `脏值 ${String(v)} 应走询问`);
  });
});

test('只有 pass 会让窗口真的销毁，其余都要 preventDefault', () => {
  // 语义约束：hide / ask 必须拦，否则窗口被销毁、托盘就再也拉不回来了
  const mustPrevent = (action) => action !== 'pass';
  assert.equal(mustPrevent(decide(false, 'minimize')), true);
  assert.equal(mustPrevent(decide(false, '')), true);
  assert.equal(mustPrevent(decide(false, 'quit')), false);
});
