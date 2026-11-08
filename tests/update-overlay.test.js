'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(kind, notice = null) {
  const elements = new Map();
  function element() {
    const listeners = new Map();
    return {
      hidden: true, textContent: '', dataset: {}, style: {}, children: [],
      classList: { add() {}, remove() {} },
      set innerHTML(value) { this.children = []; },
      appendChild(child) { this.children.push(child); },
      addEventListener(name, handler) { listeners.set(name, handler); },
      fire(name = 'click') { return listeners.get(name)(); },
    };
  }
  function get(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  }
  const calls = [];
  let boot, releaseDetach;
  let detachGate = Promise.resolve();
  const context = vm.createContext({
    console,
    browserOpen: kind === 'browser', miaoyuOpen: kind === 'miaoyu',
    window: { api: { update: {
      notice: async () => notice,
      check: async () => ({ available: true, current: '1.0.5', version: '1.0.6',
        type: 'app', sizeText: '1 MB', bundle: [], fallback: true }),
      onEvent() {},
    } } },
    document: { querySelector: get, createElement: element, body: element() },
    requestAnimationFrame: handler => handler(),
    setTimeout: handler => { boot = handler; },
    closeBrowser: async () => {
      calls.push('detach-browser');
      await detachGate;
      context.browserOpen = false;
    },
    closeMiaoyu: async () => {
      calls.push('detach-miaoyu');
      await detachGate;
      context.miaoyuOpen = false;
    },
    showBrowserKeepPage: async () => {
      calls.push('restore-browser');
      context.browserOpen = true;
    },
    openMiaoyu: async () => {
      calls.push('restore-miaoyu');
      context.miaoyuOpen = true;
    },
  });
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('let updateOverlayState =');
  const end = app.indexOf('window.restoreUpdateOverlay = restoreUpdateOverlay;', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(app.slice(start, end) + 'window.restoreUpdateOverlay = restoreUpdateOverlay;', context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/update-ui.js'), 'utf8'), context);
  return {
    calls, get, boot: () => boot(),
    pauseDetach() { detachGate = new Promise(resolve => { releaseDetach = resolve; }); },
    finishDetach() { releaseDetach(); },
    clickAction(label) {
      const button = get('#updateActions').children.find(child => child.textContent === label);
      assert.ok(button, `缺少操作：${label}`);
      return button.fire();
    },
  };
}

for (const kind of ['browser', 'miaoyu']) {
  test(`${kind}：更新窗口等待网页摘下，关闭后恢复同一页面`, async () => {
    const h = harness(kind);
    await h.boot();
    assert.deepEqual(h.calls, [], '启动时仅显示横幅，不打断内嵌网页');
    h.pauseDetach();
    const opening = h.get('#updateBarOpen').fire();
    await Promise.resolve();
    assert.equal(h.get('#updateDialog').hidden, true, '内嵌网页尚未摘下时不能显示确认框');
    h.finishDetach();
    await opening;
    assert.equal(h.get('#updateDialog').hidden, false);
    assert.deepEqual(h.calls, [`detach-${kind}`]);
    h.clickAction('稍后提醒');
    await new Promise(setImmediate);
    assert.equal(h.get('#updateDialog').hidden, true);
    assert.deepEqual(h.calls, [`detach-${kind}`, `restore-${kind}`]);
  });
}

test('连续点击更新横幅时，共用摘取过程，不提前显示弹窗或重复恢复', async () => {
  const h = harness('browser');
  await h.boot();
  h.pauseDetach();
  const openings = [h.get('#updateBarOpen').fire(), h.get('#updateBarOpen').fire()];
  await Promise.resolve();
  assert.equal(h.get('#updateDialog').hidden, true);
  assert.deepEqual(h.calls, ['detach-browser']);
  h.finishDetach();
  await Promise.all(openings);
  h.clickAction('稍后提醒');
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, ['detach-browser', 'restore-browser']);
});

test('本地页面打开和关闭更新框时，不会额外打开内嵌网页', async () => {
  const h = harness('local');
  await h.boot();
  await h.get('#updateBarOpen').fire();
  h.clickAction('稍后提醒');
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, []);
});

for (const kind of ['updated', 'rolled-back']) {
  test(`${kind} 提示同样摘取和恢复内嵌网页`, async () => {
    const h = harness('miaoyu', { kind, from: '1.0.5', to: '1.0.6' });
    await h.boot();
    const selector = kind === 'updated' ? '#updateCompleteDialog' : '#updateDialog';
    assert.equal(h.get(selector).hidden, false);
    assert.deepEqual(h.calls, ['detach-miaoyu']);
    if (kind === 'updated') h.get('#btnUpdateCompleteClose').fire();
    else h.clickAction('知道了');
    await new Promise(setImmediate);
    assert.equal(h.get(selector).hidden, true);
    assert.deepEqual(h.calls, ['detach-miaoyu', 'restore-miaoyu']);
  });
}
