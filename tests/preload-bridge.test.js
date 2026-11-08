'use strict';

/**
 * preload 桥接层的结构检查
 *
 * 这个测试盯的是一类会在运行时炸掉整个界面的错误：
 *
 * 1. **对象字面量里重复的键**。JS 里同名键后一个会静默覆盖前一个。
 *    我加 `app: { relaunch }` 时就在 `exposeInMainWorld('api', {...})` 里
 *    又写了一个 `app:`，把原来的 userDataPath / focusMode / closeBehavior 全覆盖了。
 *    后果不是「某个按钮点了没反应」，而是 app.js 顶层
 *    `initCloseBehavior()` 里 `window.api.app.closeBehavior.get()` 抛 TypeError，
 *    **整个渲染脚本从那一行往后都不执行** —— 深色模式、清除数据这些排在后面的绑定
 *    也一起失效，表现成「到处都点不动」。
 *
 * 2. **渲染层用到、桥接层没暴露的方法**。少一个就是同样的 TypeError。
 *
 * 两条都用静态解析，不需要真的启动 Electron。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');

/**
 * 取 preload 里 `exposeInMainWorld('api', { ... })` 那一层对象，返回它的顶层键序列（含重复）。
 *
 * 只在「缩进两格且以标识符+冒号开头」的行上判断顶层键：
 * 更深的缩进属于子对象，不参与本层判重。
 */
function topLevelKeys(src) {
  const start = src.indexOf("exposeInMainWorld('api'");
  assert.ok(start >= 0, 'preload 里应当有 exposeInMainWorld(\'api\', …)');
  const body = src.slice(start);
  const keys = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    // 先按上一行的括号深度判断这一行是不是顶层
    const trimmed = line.trim();
    if (depth === 1 && /^[A-Za-z_$][\w$]*\s*:/.test(trimmed)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(trimmed);
      if (m && m[1] !== 'api') keys.push(m[1]);
    }
    // 累计花括号：{ 加一，} 减一（字符串里的大括号这里忽略，
    // 本文件没有含大括号的字符串字面量）
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth === 0 && keys.length) break;
  }
  return keys;
}

test('preload 暴露的顶层键没有重复', () => {
  const keys = topLevelKeys(PRELOAD);
  assert.ok(keys.length > 5, `解析到的顶层键太少（${keys.length}），检查脚本可能失效`);
  const seen = new Map();
  for (const k of keys) seen.set(k, (seen.get(k) || 0) + 1);
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(dup, [],
    `这些键在 exposeInMainWorld 对象里写了两遍，后一个会静默覆盖前一个：${dup.join('、')}`);
});

test('app 桥接对象保留了全部原有方法（曾被重复键整块覆盖过）', () => {
  // 逐条点名：这些都是老功能，缺任何一个都会让界面某处直接抛错
  for (const name of [
    'userDataPath', 'focusMode', 'openExternal', 'openPath', 'reveal',
    'closeBehavior', 'onCloseBehaviorChanged', 'onAskCloseBehavior',
    'answerCloseBehavior', 'relaunch',
  ]) {
    assert.ok(new RegExp(`\\b${name}\\s*:`).test(PRELOAD), `app 里应保留 ${name}`);
  }
});

test('渲染层用到的 api 顶层域，preload 都暴露了', () => {
  const keys = new Set(topLevelKeys(PRELOAD));
  // app.js 里所有 window.api.xxx.yyy 的 xxx
  const used = new Set();
  const re = /window\.api\.([A-Za-z_$][\w$]*)\./g;
  let m;
  while ((m = re.exec(APP)) !== null) used.add(m[1]);
  const missing = [...used].filter((k) => !keys.has(k)).sort();
  assert.deepEqual(missing, [],
    `渲染层用了 window.api.${missing.join('/')}，但 preload 没暴露这些域`);
});

test('数据管理与版本检测用到的方法都在桥接层里', () => {
  // 这轮新增的四个方法，缺一个就是「点了没反应」
  for (const [domain, methods] of Object.entries({
    data: ['backups', 'backupNow', 'reset', 'restore'],
    version: ['change', 'resetData'],
  })) {
    for (const m of methods) {
      assert.ok(
        new RegExp(`\\b${m}\\s*:`).test(PRELOAD),
        `${domain}.${m} 必须在 preload 里暴露`,
      );
      assert.ok(
        APP.includes(`window.api.${domain}.${m}`),
        `app.js 里应当真的用到 ${domain}.${m}（如果没用，说明功能没接上）`,
      );
    }
  }
});
