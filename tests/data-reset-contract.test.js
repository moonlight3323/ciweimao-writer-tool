'use strict';

/**
 * 「清除所有数据」的接线检查
 *
 * 这条测试盯的是一个真实事故：
 *
 *   点「清除所有数据」→ 弹窗
 *   `清除失败：无法删除 E:\…\dev-data\Local Storage: EPERM, Permission denied`
 *
 * 原因不是权限设置问题，而是**方式用错了**：
 * `Local Storage` / `Network` / `Partitions` 这些目录是 Chromium 自己的 LevelDB，
 * 运行期一直被进程打开着，`fs.rmSync` 永远删不掉。
 * 唯一正解是用 Electron 的 `session.clearStorageData()`，让 Chromium 自己去清。
 *
 * 这里用静态解析盯住三件事：
 *   1. `data:reset` / `version:reset-data` 走同一条 `resetAllData()`，且是 async
 *   2. `resetAllData()` 的顺序：先备份 → 再删我们的文件 → 最后清会话
 *   3. `clearSessionData()` 覆盖三个会话并且真的调了 clearStorageData
 * 任何一条被改坏，界面上就是「点了没反应 / 弹权限错误」，很难靠肉眼发现。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
const DM = fs.readFileSync(path.join(ROOT, 'src', 'main', 'datamanager.js'), 'utf8');

/** 取一个函数声明的完整函数体（靠大括号配平，够用于本项目风格） */
function fnBody(src, name) {
  const head = src.indexOf(`function ${name}(`);
  assert.ok(head >= 0, `找不到函数 ${name}`);
  const open = src.indexOf('{', head);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 的函数体没闭合`);
}

test('清除数据与「不继承旧数据」走同一条实现', () => {
  const resetHandler = MAIN.slice(
    MAIN.indexOf("ipcMain.handle('data:reset'"),
    MAIN.indexOf("ipcMain.handle('data:restore'"),
  );
  assert.ok(resetHandler.includes('resetAllData('),
    'data:reset 必须调用 resetAllData()，否则又会出现两套清除逻辑');

  const versionHandler = MAIN.slice(
    MAIN.indexOf("ipcMain.handle('version:reset-data'"),
  ).slice(0, 600);
  assert.ok(versionHandler.includes('resetAllData('),
    'version:reset-data 也必须走 resetAllData()');
});

test('两个清除入口都是 async（要等 session.clearStorageData 完成）', () => {
  assert.ok(MAIN.includes("ipcMain.handle('data:reset', async"),
    'data:reset 必须是 async：清 Chromium 存储是异步的，不同步就等于没清');
  assert.ok(MAIN.includes("ipcMain.handle('version:reset-data', async"),
    'version:reset-data 必须是 async');
});

test('resetAllData 的顺序：先备份，再删文件，最后清会话', () => {
  const body = fnBody(MAIN, 'resetAllData');
  const iBackup = body.indexOf('createBackup(');
  const iReset = body.indexOf('datamanager.reset(');
  const iSession = body.indexOf('clearSessionData(');

  assert.ok(iBackup >= 0, '必须先备份');
  assert.ok(iReset >= 0, '必须删我们的数据文件');
  assert.ok(iSession >= 0, '必须清 Chromium 会话存储');
  assert.ok(iBackup < iReset, '备份要在删除之前 —— 备份失败就必须中止，不能先删');
  assert.ok(iReset < iSession, '会话清理放最后：它清完 cookies 就再也读不到东西了');
});

test('clearSessionData 覆盖三个会话，且用 session API 而不是删目录', () => {
  const body = fnBody(MAIN, 'clearSessionData');

  assert.ok(body.includes('session.defaultSession'),
    '默认会话（主界面 / 插件沙箱）必须清');
  assert.ok(body.includes('PARTITION'), 'persist:ciweimao（作者后台登录态）必须清');
  assert.ok(body.includes('miaoyu.PARTITION'), 'persist:miaoyu（喵语数据）必须清');
  assert.ok(body.includes('clearStorageData('),
    '必须调 clearStorageData()，这才是 Chromium 认可的清理方式');
  assert.ok(body.includes('clearCache('), 'HTTP 缓存也要清');
  assert.ok(body.includes('flushStorageData('),
    '清完要刷盘：紧接着就 relaunch，停在内存里等于没清');

  // 反例防线：这里绝不能出现文件删除
  assert.ok(!/rmSync|rmdir/.test(body),
    'clearSessionData 里不能出现 rmSync —— 那些目录运行期删不掉，只会 EPERM');
});

test('datamanager 把会话目标标成 electron，fs 不得碰它们', () => {
  assert.ok(DM.includes("via: 'electron'"),
    '会话目标必须标记 via=electron');
  const body = fnBody(DM, 'reset');
  assert.ok(body.includes("t.via === 'electron'"),
    'reset 必须跳过 electron 目标，不能拿 fs 去删');
  const fsPart = fnBody(DM, 'fsTargets');
  assert.ok(fsPart.includes("t.via !== 'electron'"),
    'fsTargets 只能返回我们自己的文件');
});

test('部分失败要能被界面看到，而不是静默重启', () => {
  const helper = fnBody(MAIN, 'resetProblemText');
  assert.ok(helper.includes('failed'), '必须把失败项转成文案');

  const handler = MAIN.slice(
    MAIN.indexOf("ipcMain.handle('data:reset'"),
    MAIN.indexOf("ipcMain.handle('data:restore'"),
  );
  assert.ok(handler.includes('problem'),
    'data:reset 必须把 problem 一并返回，界面据此提示');
});
