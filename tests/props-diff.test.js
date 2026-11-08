'use strict';

/**
 * 道具获得的指标定义与差值逻辑
 *
 * 盯的重点有两条：
 *   1. **指标必须与作者后台一致**：四项、按平台的顺序，没有「宝箱」。
 *      之前按猜测多写过一项，永远读不到、只会显示「—」误导用户。
 *   2. **0 和没有数据要分开**：昨天没抓到时不能显示 ±0，
 *      否则用户会以为「今天一个都没收到」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const pd = require('../src/renderer/props-diff');

test('指标顺序与作者后台一致：推荐票 → 月票 → 打赏 → 刀片', () => {
  assert.deepEqual(pd.keys(), ['recommend', 'monthly', 'reward', 'blade']);
});

test('指标名称照抄平台，不含「宝箱」', () => {
  assert.deepEqual(pd.ITEMS.map((x) => x.label),
    ['总推荐票', '总月票', '总打赏', '总刀片']);
  const joined = pd.ITEMS.map((x) => `${x.label}${x.hint}`).join('');
  assert.equal(joined.includes('宝箱'), false, '平台没有宝箱这一项，不能凭空加');
});

test('差值：增加为 up，减少为 down，持平为 flat', () => {
  const rows = pd.diffAgainst(
    { recommend: 10, monthly: 5, reward: 300, blade: 2 },
    { recommend: 12, monthly: 4, reward: 300, blade: 5 },
  );
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.recommend.diff, 2);
  assert.equal(by.recommend.tone, 'up');
  assert.equal(by.monthly.diff, -1);
  assert.equal(by.monthly.tone, 'down');
  assert.equal(by.reward.diff, 0);
  assert.equal(by.reward.tone, 'flat');
  assert.equal(by.blade.diff, 3);
});

test('昨天没抓到这项时不能算成 0 差值', () => {
  const rows = pd.diffAgainst(
    { recommend: null, monthly: 5, reward: 0, blade: 0 },
    { recommend: 12, monthly: 5, reward: 0, blade: 0 },
  );
  const rec = rows.find((r) => r.key === 'recommend');
  assert.equal(rec.value, 12, '今天的数值照常显示');
  assert.equal(rec.diff, null, '没有可比数据时差值必须是 null');
  assert.equal(rec.tone, 'none');
});

test('完全没有前一天快照时全部无差值', () => {
  const rows = pd.diffAgainst(null, { recommend: 3 });
  assert.ok(rows.every((r) => r.diff === null));
  assert.equal(rows.find((r) => r.key === 'recommend').value, 3);
});

test('今天没抓到的项显示为 null，不参与差值', () => {
  const rows = pd.diffAgainst({ recommend: 10 }, {});
  assert.equal(rows.find((r) => r.key === 'recommend').value, null);
  assert.equal(rows.find((r) => r.key === 'recommend').diff, null);
});

test('脏数据按「没有数据」处理', () => {
  const clean = pd.normalizeItems({ recommend: '12', monthly: -3, reward: 'abc', blade: undefined });
  assert.equal(clean.recommend, 12, '数字字符串能认');
  assert.equal(clean.monthly, null, '负数当没有数据');
  assert.equal(clean.reward, null);
  assert.equal(clean.blade, null);
});

test('差值文案带正负号，无数据用破折号', () => {
  assert.equal(pd.diffText(3), '+3');
  assert.equal(pd.diffText(-3), '-3');
  assert.equal(pd.diffText(0), '±0');
  assert.equal(pd.diffText(null), '—');
});

test('前一天日期计算跨月跨年都对', () => {
  assert.equal(pd.previousDay('2026-03-01'), '2026-02-28');
  assert.equal(pd.previousDay('2024-03-01'), '2024-02-29', '闰年二月有 29 天');
  assert.equal(pd.previousDay('2026-01-01'), '2025-12-31');
  assert.equal(pd.previousDay('bad'), '');
});

test('日期加减天数', () => {
  assert.equal(pd.shiftDay('2026-11-08', -6), '2026-11-02');
  assert.equal(pd.shiftDay('2026-11-08', 0), '2026-11-08');
  assert.equal(pd.shiftDay('2026-01-05', -10), '2025-12-26');
});

/* ---------- 快照按「作品 + 统计日」隔离：道具必然是某一本书的 ---------- */

test('同一天不同作品的快照互不影响', () => {
  const list = [
    { day: '2026-11-08', bookId: 'A', capturedAt: '2026-11-08T01:00:00Z', items: { recommend: 100 } },
    { day: '2026-11-08', bookId: 'B', capturedAt: '2026-11-08T02:00:00Z', items: { recommend: 7 } },
  ];
  assert.equal(pd.findDay(list, '2026-11-08', 'A').items.recommend, 100);
  assert.equal(pd.findDay(list, '2026-11-08', 'B').items.recommend, 7);
});

test('找前一天快照时也按作品分开', () => {
  const list = [
    { day: '2026-11-07', bookId: 'A', capturedAt: '2026-11-07T08:00:00Z', items: { recommend: 1 } },
    { day: '2026-11-07', bookId: 'B', capturedAt: '2026-11-07T08:00:00Z', items: { recommend: 9 } },
  ];
  assert.equal(pd.findPrevious(list, '2026-11-08', 'A').items.recommend, 1);
  assert.equal(pd.findPrevious(list, '2026-11-08', 'B').items.recommend, 9);
});

test('同一天同作品抓了多次取最后一次', () => {
  const list = [
    { day: '2026-11-08', bookId: 'A', capturedAt: '2026-11-08T01:00:00Z', items: { recommend: 1 } },
    { day: '2026-11-08', bookId: 'A', capturedAt: '2026-11-08T20:00:00Z', items: { recommend: 9 } },
  ];
  assert.equal(pd.findDay(list, '2026-11-08', 'A').items.recommend, 9);
});

test('合并快照：同一天同一本只保留最新一次，日期升序', () => {
  let list = [];
  list = pd.mergeSnapshot(list, { day: '2026-11-08', bookId: 'A', capturedAt: 't1', items: { recommend: 1 } });
  list = pd.mergeSnapshot(list, { day: '2026-11-07', bookId: 'A', capturedAt: 't2', items: { recommend: 2 } });
  list = pd.mergeSnapshot(list, { day: '2026-11-08', bookId: 'A', capturedAt: 't3', items: { recommend: 7 } });
  assert.equal(list.length, 2, '两天只留两条');
  assert.equal(list[1].day, '2026-11-08', '按日期升序');
  assert.equal(list[1].items.recommend, 7, '后抓的覆盖先抓的');
});

test('合并快照：不同作品各留各的', () => {
  let list = [];
  list = pd.mergeSnapshot(list, { day: '2026-11-08', bookId: 'A', capturedAt: 't1', items: {} });
  list = pd.mergeSnapshot(list, { day: '2026-11-08', bookId: 'B', capturedAt: 't2', items: {} });
  assert.equal(list.length, 2, '同一天两本书不该互相覆盖');
});

test('合并快照不修改入参', () => {
  const original = [{ day: '2026-11-07', bookId: 'A', capturedAt: 'x', items: {} }];
  const copy = JSON.parse(JSON.stringify(original));
  pd.mergeSnapshot(original, { day: '2026-11-08', bookId: 'A', capturedAt: 'y', items: {} });
  assert.deepEqual(original, copy);
});

/* ---------- 趋势取数：只取有记录的那几天，不补零 ---------- */

test('近 7 日只返回窗口内的快照，不补零', () => {
  const list = [
    { day: '2026-11-01', bookId: 'A', capturedAt: 'a', items: { recommend: 1 } },
    { day: '2026-11-05', bookId: 'A', capturedAt: 'b', items: { recommend: 2 } },
    { day: '2026-11-08', bookId: 'A', capturedAt: 'c', items: { recommend: 3 } },
  ];
  const got = pd.seriesFor(list, 'A', { days: 7, today: '2026-11-08' });
  assert.deepEqual(got.map((s) => s.day), ['2026-11-05', '2026-11-08'],
    '11-01 超出 7 日窗口（11-02~11-08），中间没抓的日子不补 0');
});

test('近 30 日把窗口放宽', () => {
  const list = [
    { day: '2026-11-01', bookId: 'A', capturedAt: 'a', items: {} },
    { day: '2026-11-08', bookId: 'A', capturedAt: 'c', items: {} },
  ];
  assert.equal(pd.seriesFor(list, 'A', { days: 30, today: '2026-11-08' }).length, 2);
});

test('按月（days=0）返回全部历史', () => {
  const list = [
    { day: '2026-09-01', bookId: 'A', capturedAt: 'a', items: {} },
    { day: '2026-11-08', bookId: 'A', capturedAt: 'c', items: {} },
  ];
  assert.equal(pd.seriesFor(list, 'A', { days: 0, today: '2026-11-08' }).length, 2);
});

test('趋势只取指定作品的快照', () => {
  const list = [
    { day: '2026-11-08', bookId: 'A', capturedAt: 'a', items: {} },
    { day: '2026-11-08', bookId: 'B', capturedAt: 'b', items: {} },
  ];
  const got = pd.seriesFor(list, 'A', { days: 7, today: '2026-11-08' });
  assert.equal(got.length, 1);
  assert.equal(got[0].bookId, 'A');
});
