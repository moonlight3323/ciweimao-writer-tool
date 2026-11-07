'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { layout, create } = require('../src/renderer/plugin-floating');

test('自由放置：中央、边缘、四角在展开收起后仍保持同一个球坐标', () => {
  for (const anchor of [{ x: 440, y: 350 }, { x: 8, y: 8 }, { x: 1120, y: 720 },
    { x: 1120, y: 8 }, { x: 8, y: 720 }, { x: 400, y: 8 }, { x: 8, y: 350 }]) {
    for (const expanded of [false, true, false]) {
      const result = layout(anchor, { width: 1200, height: 800 }, {}, expanded);
      assert.equal(result.left + result.ballX, anchor.x);
      assert.equal(result.top + result.ballY, anchor.y);
      assert.ok(result.left >= 0 && result.left + result.width <= 1200);
      assert.ok(result.top >= 0 && result.top + result.height <= 800);
    }
  }
});

test('不同尺寸和异常输入会限制到可视区域，不产生 NaN 或越界容器', () => {
  for (const viewport of [{ width: 250, height: 200 }, { width: 60, height: 60 }]) {
    const result = layout({ x: Infinity, y: NaN }, viewport,
      { widget: { width: NaN, height: -100 }, panel: { width: Infinity, height: 5000 } }, true);
    for (const key of ['left', 'top', 'width', 'height', 'ballX', 'ballY']) assert.ok(Number.isFinite(result[key]));
    assert.ok(result.left + result.width <= viewport.width);
    assert.ok(result.top + result.height <= viewport.height);
  }
});

test('常驻实例独立拖动、松手保存位置，卸载仅清理自身', () => {
  const oldWindow = global.window;
  const handlers = new Set();
  global.window = { innerWidth: 1200, innerHeight: 800,
    addEventListener: (_, fn) => handlers.add(fn), removeEventListener: (_, fn) => handlers.delete(fn) };
  const make = () => {
    const result = { saved: [], messages: [] };
    result.host = { style: {}, appendChild() { result.mounts = (result.mounts || 0) + 1; }, remove() { result.removed = true; } };
    result.frame = { remove() { result.frameRemoved = true; } };
    result.controller = create({ ...result, initialPosition: { x: 400, y: 300 },
      savePosition: pos => result.saved.push(pos), notify: msg => result.messages.push(msg) });
    return result;
  };
  try {
    const first = make();
    const second = make();
    first.controller.event({ event: 'drag-start' });
    first.controller.event({ event: 'drag-move', dx: 123, dy: 55 });
    first.controller.event({ event: 'drag-end' });
    assert.deepEqual(first.saved[0], { x: 523, y: 355 });
    assert.deepEqual(second.messages.at(-1).anchor, { x: 400, y: 300 });
    first.controller.setExpanded(true);
    first.controller.setExpanded(false);
    assert.equal(first.mounts, 1, '展开收起不应移动或重建 iframe');
    first.controller.dispose();
    assert.ok(first.removed && first.frameRemoved);
    assert.equal(handlers.size, 1);
    assert.equal(second.removed, undefined);
    second.controller.dispose();
    assert.equal(handlers.size, 0);
  } finally { global.window = oldWindow; }
});
