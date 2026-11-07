'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bridge() {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = app.indexOf('function pluginBridgeSource(token)');
  const end = app.indexOf('/**', start);
  const script = vm.runInNewContext(`(${app.slice(start, end)})('test-token')`);
  const handlers = new Map();
  const timers = new Map();
  const rafs = new Map();
  const sent = [];
  let id = 0;
  const listen = (name, fn) => {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
  };
  const emit = (name, data) => { for (const fn of handlers.get(name) || []) fn(data); };
  const parent = { postMessage: value => sent.push(value) };
  const window = { dispatchEvent() {} };
  const document = { documentElement: { dataset: {} }, getElementById: () => null };
  vm.runInNewContext(script, {
    console, parent, window, document, addEventListener: listen,
    CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data.detail; } },
    setTimeout: fn => { const key = ++id; timers.set(key, fn); return key; },
    clearTimeout: key => timers.delete(key),
    requestAnimationFrame: fn => { const key = ++id; rafs.set(key, fn); return key; },
    cancelAnimationFrame: key => rafs.delete(key),
  });
  return { api: window.PluginAPI, sent, timers, rafs, emit,
    receive: (data, source = parent) => emit('message', { source, data: { token: 'test-token', ...data } }),
  };
}

test('插件 SDK 握手只接受宿主与当前 token，正常响应立即清理超时器', async () => {
  const b = bridge();
  b.receive({ type: 'ciweimao-plugin-host', mode: 'floating', ballX: 12, token: 'wrong' });
  assert.equal(b.api.floating.getState(), null);
  b.receive({ type: 'ciweimao-plugin-host', mode: 'floating', ballX: 12 });
  assert.equal((await b.api.ready).ballX, 12);
  const before = b.timers.size;
  const promise = b.api.app.info();
  const request = b.sent.at(-1);
  assert.equal(b.timers.size, before + 1);
  b.receive({ type: 'ciweimao-plugin-response', id: request.id, ok: true, result: { apiVersion: '1.1.0' } });
  assert.equal((await promise).apiVersion, '1.1.0');
  assert.equal(b.timers.size, before);
});

test('卸载事件取消待处理请求，注销事件处理函数可独立生效', async () => {
  const b = bridge();
  let disposed = 0, changed = 0;
  b.api.on('dispose', () => disposed++);
  const off = b.api.floating.onChange(() => changed++);
  b.receive({ type: 'ciweimao-plugin-host', mode: 'floating' });
  off();
  b.receive({ type: 'ciweimao-plugin-host', mode: 'floating' });
  assert.equal(changed, 1);
  const rejected = assert.rejects(b.api.storage.get('state'), /插件已卸载/);
  b.receive({ type: 'ciweimao-plugin-host', event: 'dispose' });
  await rejected;
  await assert.rejects(b.api.app.info(), /插件已卸载/);
  assert.equal(disposed, 1);
});

test('通用拖动使用屏幕坐标，逐帧合并移动并支持取消和清理', () => {
  const b = bridge();
  const handlers = new Map();
  const element = { classList: { add() {}, remove() {} }, setPointerCapture() {}, releasePointerCapture() {},
    addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  let clicks = 0;
  const off = b.api.floating.bindDrag(element, { onClick: () => clicks++ });
  const event = (type, values) => handlers.get(type)({ button: 0, pointerId: 1,
    screenX: 100, screenY: 100, type, preventDefault() {}, ...values });
  event('pointerdown');
  event('pointermove', { screenX: 150, screenY: 180, clientX: 20, clientY: 20 });
  event('pointermove', { screenX: 190, screenY: 200, clientX: 20, clientY: 20 });
  assert.equal(b.rafs.size, 1);
  event('pointerup');
  assert.equal(b.sent.filter(item => item.event === 'drag-move').length, 1);
  assert.equal(b.sent.find(item => item.event === 'drag-move').dx, 90);
  assert.equal(b.rafs.size, 0);
  assert.equal(clicks, 0);
  event('pointerdown');
  event('pointercancel');
  assert.equal(b.sent.at(-1).event, 'drag-cancel');
  assert.equal(clicks, 0);
  off();
  assert.equal(handlers.size, 0);
});
