'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const vm = require('node:vm');
const updater = require('../src/main/updater');

test('目标版本启动确认时保留更新助手正在使用的脚本、锁和备份', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-updater-recovery-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'cw-updater-recovery-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const backup = path.join(root, 'backup');
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, 'version.txt'), 'old');
  fs.writeFileSync(path.join(root, 'run-update.cmd'), 'active helper');
  fs.writeFileSync(path.join(root, 'run-update.lock'), 'active lock');
  updater.writeState(root, { from: '1.0.4', to: '1.0.5', stage: 'installing', bakPath: backup });
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const start = main.indexOf('function recoverUpdateState()');
  const end = main.indexOf('/** 拉清单', start);
  const context = vm.createContext({ fs, path, updater: { ...updater, tempRoot: () => root },
    dataDir: () => root, app: { getVersion: () => '1.0.5' }, updateNotice: null });
  vm.runInContext(main.slice(start, end) + '\nrecoverUpdateState();', context);
  assert.equal(fs.readFileSync(updater.okFlagPath(root), 'utf8'), '1.0.5');
  assert.equal(updater.readState(root).stage, 'installing');
  assert.ok(fs.existsSync(backup));
  assert.ok(fs.existsSync(path.join(root, 'run-update.cmd')));
  assert.ok(fs.existsSync(path.join(root, 'run-update.lock')));
});

async function scenario(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-updater-isolated-'));
  t.after(() => {
    // 删除范围仅限本测试创建的目录。
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'cw-updater-isolated-')));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const appDir = path.join(root, 'app');
  const newDir = path.join(root, 'new');
  const dataDir = path.join(root, '自定义数据');
  fs.mkdirSync(appDir);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(appDir, 'version.txt'), 'old');
  if (mode !== 'copy-failure') {
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(newDir, 'version.txt'), 'new');
  }
  fs.writeFileSync(path.join(root, 'fixture.cjs'), `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(path.join(root, 'fixture-ran.txt'))}, process.cwd());
    if (${JSON.stringify(mode)} === 'success' && fs.readFileSync(${JSON.stringify(path.join(appDir, 'version.txt'))}, 'utf8') === 'new') {
      setTimeout(() => fs.writeFileSync(${JSON.stringify(updater.okFlagPath(dataDir))}, '1.0.5'), 1800);
    }
  `);
  let command = updater.buildUpdateCommand({ pid: '', appDir, newDir, bakDir: path.join(root, 'backup'),
    exePath: process.execPath, args: 'fixture.cjs', dataDir, to: '1.0.5', waitSeconds: 3,
    lockPath: path.join(root, 'update.lock') });
  // 真实应用为 GUI exe；测试替身是控制台 Node，用 /b 防止测试弹出控制台窗口。
  command = command.replaceAll('start "" "%EXEPATH%"', 'start "" /b "%EXEPATH%"');
  const cmdPath = path.join(root, 'update.cmd');
  fs.writeFileSync(cmdPath, command, 'utf8');
  const start = Date.now();
  let output = '';
  const exit = await new Promise((resolve, reject) => {
    const child = cp.spawn('cmd.exe', ['/d', '/c', cmdPath], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('隔离更新测试超时')); }, 25000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  return { root, dataDir, appDir, exit, output, elapsed: Date.now() - start };
}

test('无控制台输入时确实等待慢启动，收到确认才完成替换', { skip: process.platform !== 'win32' }, async t => {
  const result = await scenario(t, 'success');
  assert.equal(result.exit, 0, JSON.stringify({ output: result.output, failure: updater.readFailed(result.dataDir) }));
  assert.ok(result.elapsed >= 1800, '不能把启动确认倒计时瞬间跑完');
  assert.equal(fs.readFileSync(path.join(result.appDir, 'version.txt'), 'utf8'), 'new');
  assert.equal(fs.existsSync(path.join(result.root, 'backup')), false);
  assert.equal(updater.readFailed(result.dataDir), null);
});

test('没有收到启动确认时保留旧版本，记录超时原因', { skip: process.platform !== 'win32' }, async t => {
  const result = await scenario(t, 'startup-failure');
  assert.equal(result.exit, 1);
  assert.ok(result.elapsed >= 3000);
  assert.equal(fs.readFileSync(path.join(result.appDir, 'version.txt'), 'utf8'), 'old');
  assert.equal(updater.readFailed(result.dataDir).reason, '启动确认超时');
});

test('复制失败立即恢复旧版本，错误提示能区别于启动失败', { skip: process.platform !== 'win32' }, async t => {
  const result = await scenario(t, 'copy-failure');
  assert.equal(result.exit, 1);
  assert.equal(fs.readFileSync(path.join(result.appDir, 'version.txt'), 'utf8'), 'old');
  assert.equal(updater.readFailed(result.dataDir).reason, '复制更新文件失败');
});
