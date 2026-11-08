'use strict';

/**
 * 侧边栏自定义顺序的规则测试
 *
 * 最要紧的一条是「设置项删不掉」——它是用户唯一的恢复入口，
 * 这条规则一旦被改坏，用户删完侧边栏就再也回不来了。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const nav = require('../src/renderer/nav-order');

test('默认顺序包含设置项且在最后', () => {
  const list = nav.defaultOrder();
  assert.ok(list.includes('settings'));
  assert.equal(list[list.length - 1], 'settings', '设置项默认排最后');
  assert.equal(new Set(list).size, list.length, '默认顺序不能有重复项');
});

test('固定项不能删除，但可以自由排序', () => {
  // 用户反馈：概览 / 数据看板 / 抓取与同步 / 功能中心 也该锁住删除，
  // 但**排序必须照旧生效**——锁的是「删除」，不是「移动」。
  const FIXED = ['overview', 'books', 'sync', 'plugins', 'settings'];
  for (const view of FIXED) {
    assert.equal(nav.isLocked(view), true, `${view} 应锁定删除`);

    const res = nav.remove(nav.defaultOrder(), view);
    assert.equal(res.removed, false, `${view} 不该被移除`);
    assert.ok(res.order.includes(view), `${view} 被拒绝后仍应留在顺序里`);
    assert.match(res.reason, /不能从侧边栏移除/, '拒绝理由要说清是「不能移除」而不是「不能动」');

    // 关键：锁定不影响上下移动。边界项（第一个 / 最后一个）本来就没得动，跳过。
    const order = nav.defaultOrder();
    const i = order.indexOf(view);
    if (i > 0) {
      const up = nav.move(order, view, -1);
      assert.equal(up.indexOf(view), i - 1, `${view} 应能上移一位`);
    }
    if (i < order.length - 1) {
      const down = nav.move(order, view, 1);
      assert.equal(down.indexOf(view), i + 1, `${view} 应能下移一位`);
    }
  }
});

test('非固定项仍可删除', () => {
  for (const view of ['writer', 'writing-stats', 'reviews', 'export', 'rank', 'miaoyu']) {
    assert.equal(nav.isLocked(view), false, `${view} 不该被锁`);
    assert.equal(nav.remove(nav.defaultOrder(), view).removed, true, `${view} 应可删除`);
  }
});

test('普通项可以删除，顺序里随之消失', () => {
  const res = nav.remove(nav.defaultOrder(), 'rank');
  assert.equal(res.removed, true);
  assert.ok(!res.order.includes('rank'));
  assert.equal(res.order.length, nav.defaultOrder().length - 1);
});

test('删除不存在的项不会改变顺序', () => {
  const order = nav.remove(nav.defaultOrder(), 'rank').order;
  const again = nav.remove(order, 'rank');
  assert.equal(again.removed, false);
  assert.deepEqual(again.order, order);
});

test('normalize 会清洗脏数据并补回全部固定项', () => {
  const got = nav.normalize(['writer', 'writer', 'not-a-view', null, 42, { view: 'books' }]);
  // 去重、丢弃未知项、对象形式也认；剩余固定项按 LOCKED 顺序补到末尾
  assert.deepEqual(got, ['writer', 'books', 'overview', 'sync', 'plugins', 'settings'],
    '脏数据要被清掉，缺的固定项要补齐');
  assert.equal(new Set(got).size, got.length, '不能有重复');
});

test('normalize 对非数组输入也只补回固定项', () => {
  const onlyFixed = ['overview', 'books', 'sync', 'plugins', 'settings'];
  for (const bad of [null, undefined, {}, 'writer', 0]) {
    const got = nav.normalize(bad);
    assert.deepEqual(got, onlyFixed, `${JSON.stringify(bad)} 应只补回固定项`);
  }
});

test('上移下移是相邻交换，越界时原样返回', () => {
  // 必须传完整的固定项：normalize 会把缺的补到末尾，手工列表会被改写，
  // 那时候断言失败的原因跟「移动」无关，纯属干扰。
  const list = ['overview', 'writer', 'books', 'sync', 'plugins', 'settings'];
  assert.deepEqual(nav.move(list, 'books', -1), ['overview', 'books', 'writer', 'sync', 'plugins', 'settings']);
  assert.deepEqual(nav.move(list, 'books', 1), ['overview', 'writer', 'sync', 'books', 'plugins', 'settings'],
    '下移是相邻交换');
  assert.deepEqual(nav.move(list, 'overview', -1), list, '第一项再上移不动');
  assert.deepEqual(nav.move(list, 'settings', 1), list, '最后一项再下移不动');
  assert.deepEqual(nav.move(list, 'nope', 1), list, '不存在的项原样返回');
});

test('move 不会改动传入的数组', () => {
  const list = nav.defaultOrder();
  const copy = list.slice();
  nav.move(list, 'books', -1);
  assert.deepEqual(list, copy, '纯函数不能就地修改入参');
});

test('被删的项可以加回来，位置在设置之前', () => {
  const afterDelete = nav.remove(nav.defaultOrder(), 'rank').order;
  assert.ok(!afterDelete.includes('rank'));
  const back = nav.restore(afterDelete, 'rank');
  assert.ok(back.includes('rank'));
  assert.equal(back[back.indexOf('rank') + 1], 'settings', '加回来时紧邻设置项之前');
});

test('hiddenOf 列出被删掉的项', () => {
  const order = nav.remove(nav.defaultOrder(), 'rank').order;
  const hidden = nav.hiddenOf(order);
  assert.deepEqual(hidden, ['rank']);
});

test('labelOf 给出中文显示名，未知项回退原名', () => {
  assert.equal(nav.labelOf('plugins'), '功能中心');
  assert.equal(nav.labelOf('books'), '数据看板');
  assert.equal(nav.labelOf('whatever'), 'whatever');
});

test('界面上的每个 view 都能在默认顺序里找到标签', () => {
  // 这条防的是「加了视图但忘了加导航」和「导航里写了不存在的视图」两种偏差。
  // index.html 里的 data-view 必须与 DEFAULT_NAV 完全对上。
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8',
  );
  const views = new Set();
  const re = /<section[^>]*class="view[^"]*"[^>]*data-view="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) views.add(m[1]);
  const navViews = new Set(nav.knownViews());
  for (const v of views) {
    assert.ok(navViews.has(v), `页面里有视图 ${v}，但侧边栏默认顺序里没有`);
  }
});

test('侧边栏里的每一项都在页面里有对应视图（不能出现死链）', () => {
  // 反向检查：DEFAULT_NAV 里写了 props 但页面没建 section，
  // 侧边栏就会多出一个点了没反应的入口。
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8',
  );
  const views = new Set();
  const re = /<section[^>]*class="view[^"]*"[^>]*data-view="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) views.add(m[1]);
  for (const v of nav.knownViews()) {
    assert.ok(views.has(v), `侧边栏有 ${v}，但页面里没有对应的 <section data-view="${v}">`);
  }
});

test('顺序里缺了固定项会自动补回来（老数据 / 手改配置的自愈）', () => {
  // 固定项本身删不掉，所以「不在顺序里」只能来自旧数据或配置被改。
  // 让它们永久消失是错的 —— 尤其「设置」是唯一的恢复入口。
  const broken = ['writer', 'writing-stats', 'reviews', 'export', 'rank', 'miaoyu'];
  const norm = nav.normalize(broken);

  for (const view of ['overview', 'books', 'sync', 'plugins', 'settings']) {
    assert.ok(norm.includes(view), `${view} 应被补回`);
  }
  // 用户原有顺序保持不动，缺的补在末尾
  assert.deepEqual(norm.slice(0, broken.length), broken, '原有顺序不能被打乱');
});

test('补回固定项不会产生重复', () => {
  const full = nav.defaultOrder();
  const again = nav.normalize(full);
  assert.equal(again.length, full.length);
  assert.equal(new Set(again).size, again.length);
  assert.deepEqual(again, full, '已经完整的顺序应原样返回');
});
