'use strict';

/**
 * 作者信箱「一键清除小红点」的停止逻辑。
 *
 * inbox.js 是浏览器端 IIFE，但它依赖的东西都能用假对象替掉：
 *   window.api.browser.*  → 页面跳转 / 取页面状态 / 执行脚本
 *   window.CiweimaoAdapter.pageSource → 只用来产出「要执行的源码」标识
 * 所以这里在 Node 里直接 require 它，跑的是真实控制流，不是复制一份逻辑。
 *
 * 页面内逐行点击的中断（__wbInboxStop）依赖真实 DOM，不在本文件覆盖范围内。
 */

const test = require('node:test');
const assert = require('node:assert');

const SRC = require.resolve('../src/renderer/inbox.js');

/** 每个场景一套干净的 window 桩，避免状态串味 */
function loadInbox(setup) {
  delete require.cache[SRC];
  const log = [];
  const state = {
    url: 'https://author.ciweimao.com/homepage/sys_mailbox?page=1',
    flag: false,
    scans: 0,
    clears: 0,
  };

  const plan = Object.assign({
    // scan 返回的 nextUrl 决定要不要翻页
    scanNext: ['', ''],
    // inboxClear 的返回值序列；不足时复用最后一个
    clearResults: [{ before: 3, after: 1, clicked: 2, mode: 'auto' }],
    // 每执行完一次 inboxClear 后回调，用来模拟「用户在这一刻点了停止」
    afterClear: null,
  }, setup || {});

  global.window = {
    api: {
      browser: {
        state: async () => ({ url: state.url }),
        goto: async (u) => { log.push('goto:' + u); state.url = u; },
        waitIdle: async () => {},
        evalInPage: async (src) => {
          if (src === 'location.href') return state.url;
          if (/^window\.__wbInboxStop\s*=/.test(src)) {
            state.flag = /true/.test(src);
            log.push('flag:' + state.flag);
            return true;
          }
          if (src.indexOf('<!DOCTYPE html>') !== -1) return '<html></html>';
          const m = /^ADAPTER:(\w+):(.*)$/.exec(src);
          if (!m) throw new Error('未预期的页面脚本：' + src);
          const name = m[1];
          if (name === 'inboxScan') {
            const n = state.scans;
            state.scans += 1;
            return { dots: 3, expands: 3, nextUrl: plan.scanNext[n] || '' };
          }
          if (name === 'inboxClear') {
            const n = state.clears;
            state.clears += 1;
            const r = Object.assign({}, plan.clearResults[Math.min(n, plan.clearResults.length - 1)]);
            if (plan.afterClear) plan.afterClear(n, state);
            return r;
          }
          throw new Error('未预期的适配器方法：' + name);
        },
      },
      diag: { save: async () => {} },
    },
    CiweimaoAdapter: {
      pageSource: (name, args) => 'ADAPTER:' + name + ':' + JSON.stringify(args || {}),
    },
  };

  const Inbox = require(SRC);
  return { Inbox, log, state, plan };
}

test('点击停止后不再翻页：第一页做完就退出', async () => {
  let stop = false;
  const phases = [];
  const { Inbox, state } = loadInbox({
    scanNext: ['https://author.ciweimao.com/homepage/sys_mailbox?page=2', ''],
    afterClear: () => { stop = true; },   // 第一页结束的瞬间用户点了停止
  });

  const res = await Inbox.clearAll({
    allPages: true,
    shouldStop: () => stop,
    onProgress: (p) => phases.push(p.phase),
  });

  assert.equal(res.stopped, true, '应标记为「已停止」');
  assert.equal(res.pages.length, 1, '只处理了第一页');
  assert.equal(res.clicked, 2, '已点开的条目要如实统计');
  assert.equal(state.scans, 1, '不该再去扫第二页');
  assert.ok(!phases.includes('done'), '停止时不能报「完成」');
  assert.equal(phases[phases.length - 1], 'stopped');
});

test('页面内的逐行中断也算停止，且不再进入下一页', async () => {
  const { Inbox, state } = loadInbox({
    scanNext: ['https://author.ciweimao.com/homepage/sys_mailbox?page=2', ''],
    // 适配器在页面返回 stopped: true —— 点「停止」后逐行循环自己断的行为
    clearResults: [{ before: 3, after: 2, clicked: 1, mode: 'auto', stopped: true }],
  });

  const res = await Inbox.clearAll({ allPages: true });

  assert.equal(res.stopped, true);
  assert.equal(res.pages.length, 1);
  assert.equal(res.clicked, 1);
  assert.equal(state.scans, 1, '扫过一次就够了');
});

test('还没开始就点了停止：一个页面都不碰', async () => {
  const { Inbox, state } = loadInbox({});
  const res = await Inbox.clearAll({ allPages: true, shouldStop: () => true });

  assert.equal(res.stopped, true);
  assert.deepEqual(res.pages, []);
  assert.equal(res.clicked, 0);
  assert.equal(state.scans, 0, '不该去扫页面');
  assert.ok(!state.flag, '开跑前要把上次的停止旗标清掉');
});

test('没点停止时行为不变：翻页做完并报完成', async () => {
  const phases = [];
  const { Inbox, state } = loadInbox({
    scanNext: ['https://author.ciweimao.com/homepage/sys_mailbox?page=2', ''],
    clearResults: [
      { before: 3, after: 1, clicked: 2, mode: 'auto' },
      { before: 2, after: 0, clicked: 2, mode: 'auto' },
    ],
  });

  const res = await Inbox.clearAll({
    allPages: true,
    shouldStop: () => false,
    onProgress: (p) => phases.push(p.phase),
  });

  assert.equal(res.stopped, false);
  assert.equal(res.pages.length, 2, '两页都处理了');
  assert.equal(res.clicked, 4);
  assert.equal(state.flag, false, '跑完旗标必须是关的，否则下次一开工就停');
  assert.equal(phases[phases.length - 1], 'done');
});

test('停止后再开一次能正常跑（旗标被重置）', async () => {
  const { Inbox, state } = loadInbox({});
  state.flag = true;                       // 上次停止留下的残留
  const res = await Inbox.clearAll({ allPages: false, shouldStop: () => false });

  assert.equal(res.stopped, false, '不该被上一次的残留旗标影响');
  assert.equal(res.pages.length, 1);
  assert.equal(state.flag, false);
});
