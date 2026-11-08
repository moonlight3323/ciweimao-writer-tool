'use strict';

/**
 * 数据备份 / 清除 / 恢复的测试
 *
 * 重点盯三件容易出错的事：
 *   1. 备份目录不能落在被清除的范围里（否则备份跟着一起被删）；
 *   2. 清除只清目录内容、不删目录本身；
 *   3. 恢复之前要先给当前状态留一份，恢复错了能退回来。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dm = require('../src/main/datamanager');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

test('清除范围必须覆盖数据目录、密码本与登录态', () => {
  const userData = path.join('C:', 'Users', 'x', 'AppData', 'Roaming', '刺猬猫作家助手');
  // 自定义数据目录：三块都得在清除范围里
  const targets = dm.resetTargets({ dataDir: path.join('E:', 'mydata'), userData });
  const scopes = targets.map((t) => t.scope);
  assert.ok(scopes.includes('data'), '数据目录必须在清除范围里');
  assert.ok(scopes.includes('vault'), '密码本必须在清除范围里');
  assert.ok(scopes.includes('session'), '登录态必须在清除范围里');

  // 数据目录恰好就是 userData/data 时，密码本不能再单独列一次（会重复删）
  const same = dm.resetTargets({ dataDir: path.join(userData, 'data'), userData });
  const vaultEntries = same.filter((t) => t.scope === 'vault');
  assert.equal(vaultEntries.length, 0, '数据目录与 userData/data 重合时不该重复列密码本');
});

test('自定义数据目录时密码本单独列为一项', () => {
  const userData = path.join('D:', 'app', 'userData');
  const targets = dm.resetTargets({ dataDir: path.join('E:', 'mydata'), userData });
  const vault = targets.find((t) => t.scope === 'vault');
  assert.ok(vault, '自定义数据目录时密码本在 userData 下，必须单独清理');
  assert.equal(vault.path, path.join(path.resolve(userData), 'data'));
});

test('备份目录不会落在清除范围里', () => {
  const root = tmp('ciweimao-dm-root-');
  const appData = path.join(root, 'Roaming');
  const userData = path.join(appData, '刺猬猫作家助手');
  const dataDir = path.join(userData, 'data');
  try {
    const rootDir = dm.backupRoot(appData);
    assert.equal(rootDir, path.join(appData, dm.BACKUP_DIR_NAME));
    // 备份目录是 userData 的兄弟目录，不在任何清除目标之下
    const targets = dm.resetTargets({ dataDir, userData });
    for (const t of targets) {
      const rel = path.relative(t.path, rootDir);
      assert.ok(rel.startsWith('..') || path.isAbsolute(rel),
        `备份目录不能位于清除目标 ${t.path} 内部`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('备份能完整复制数据目录与密码本', () => {
  const root = tmp('ciweimao-dm-backup-');
  try {
    const userData = path.join(root, 'userData');
    const dataDir = path.join(userData, 'data');
    const backupDir = dm.backupRoot(path.join(root, 'Roaming'));

    write(path.join(dataDir, 'library', 'index.json'), '{"books":[]}');
    write(path.join(dataDir, 'ui-prefs.json'), '{"theme":"dark"}');
    write(path.join(dataDir, 'badwords-local.json'), '{"words":["测试"]}');
    write(path.join(userData, 'data', 'vault.json'), '{"items":[]}');

    const targets = dm.resetTargets({ dataDir, userData });
    const manifest = dm.createBackup(backupDir, targets, { reason: 'test' });

    assert.ok(manifest.files >= 4, `应至少备份 4 个文件，实际 ${manifest.files}`);
    assert.ok(manifest.bytes > 0);
    assert.ok(fs.existsSync(path.join(backupDir, manifest.name, 'backup.json')));

    // 备份里的数据目录内容按 scope 归位
    assert.equal(
      fs.readFileSync(path.join(backupDir, manifest.name, 'data', 'ui-prefs.json'), 'utf8'),
      '{"theme":"dark"}',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('清除只清目录内容，目录本身还在', () => {
  const root = tmp('ciweimao-dm-reset-');
  try {
    const userData = path.join(root, 'userData');
    const dataDir = path.join(userData, 'data');
    write(path.join(dataDir, 'library', 'index.json'), '{}');
    write(path.join(dataDir, 'ui-prefs.json'), '{}');
    fs.mkdirSync(path.join(userData, 'Partitions'), { recursive: true });
    write(path.join(userData, 'data', 'vault.json'), '{}');

    const result = dm.reset(dm.resetTargets({ dataDir, userData }));
    assert.ok(result.removed.length >= 2);
    assert.equal(result.failed.length, 0, '没有占用时不该有失败项');
    assert.ok(fs.existsSync(dataDir), '数据目录本身不该被删掉');
    assert.deepEqual(fs.readdirSync(dataDir), [], '数据目录里应当被清空');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('登录态目录交给 Electron，绝不用 fs 删（运行期必 EPERM）', () => {
  // 这条是事故回归：旧实现把 Local Storage / Partitions 也丢给 fs.rmSync，
  // 而这些目录被运行中的 Chromium 用 LevelDB 打开着，删必报
  //   EPERM: Permission denied: '…\Local Storage'
  // 于是「清除所有数据」一点就弹错、完全不可用。
  const root = tmp('ciweimao-dm-session-');
  try {
    const userData = path.join(root, 'userData');
    const dataDir = path.join(userData, 'data');
    write(path.join(dataDir, 'ui-prefs.json'), '{}');
    write(path.join(userData, 'Local Storage', 'leveldb', '000005.ldb'), 'x');
    write(path.join(userData, 'Network', 'Cookies'), 'x');

    const targets = dm.resetTargets({ dataDir, userData });
    const sessionOnes = dm.sessionTargets(targets);
    assert.ok(sessionOnes.length >= 2, 'Local Storage / Network 应标成 session 目标');
    assert.ok(sessionOnes.every((t) => t.via === 'electron'),
      'session 目标必须标记 via=electron，供主进程改走 session.clearStorageData');
    assert.ok(dm.fsTargets(targets).every((t) => t.via !== 'electron'),
      'fsTargets 只能返回我们自己的文件');

    const result = dm.reset(targets);
    // 关键：这些目录一个都不能被 fs 碰过
    assert.ok(fs.existsSync(path.join(userData, 'Local Storage', 'leveldb', '000005.ldb')),
      'session 目录不该被 fs 删除（运行期删不掉，只能交给 session API）');
    assert.ok(result.removed.every((p) => !/[\\/]Local Storage[\\/]?/.test(p)),
      'removed 里不能出现 session 路径');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('单个文件被占用时收集失败，不中断整轮清除', () => {
  // 一个缓存文件被占用，不该让已经清掉的数据变成一场空，
  // 更要紧的是不能把「清除」整体判死 —— 用户会以为功能坏了。
  const root = tmp('ciweimao-dm-partial-');
  try {
    const userData = path.join(root, 'userData');
    const dataDir = path.join(userData, 'data');
    write(path.join(dataDir, 'a.json'), '{}');
    write(path.join(dataDir, 'b.json'), '{}');

    const targets = dm.resetTargets({ dataDir, userData });
    // 造一个必然失败的清理目标：把一个普通文件当成「目录内容」去 readdir，
    // ENOTDIR 会被 reset 收进 failed 而不是抛出去。
    // 必须插到最前面 —— 后面的真实目标会把这个文件删掉，那时就测不到了。
    targets.unshift({
      scope: 'data', kind: 'contents', via: 'fs', path: path.join(dataDir, 'a.json'),
    });

    const result = dm.reset(targets);
    assert.ok(result.removed.length >= 2, '其它文件仍应被删掉');
    assert.ok(result.failed.length >= 1, '删不掉的那个应进 failed');
    assert.ok(result.failed[0].path, '失败项要带路径，界面才能说清是哪一步');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('数据目录把 userData 圈进来时，跳过里面的会话目录', () => {
  // 极端但真实：用户把「数据保存位置」选成了 userData 根目录。
  // 这时「清数据目录内容」会连带看到 Local Storage —— 不清掉它这道防线，
  // 同一条 EPERM 事故就换个入口复现了。
  const root = tmp('ciweimao-dm-overlap-');
  try {
    const userData = path.join(root, 'userData');
    write(path.join(userData, 'library', 'index.json'), '{}');
    write(path.join(userData, 'Local Storage', 'leveldb', '000005.ldb'), 'x');

    const targets = dm.resetTargets({ dataDir: userData, userData });
    // 数据目录就是 userData：data scope 的 contents 指 userData
    assert.equal(targets[0].kind, 'contents');
    assert.equal(path.resolve(targets[0].path), path.resolve(userData));

    const result = dm.reset(targets);
    assert.deepEqual(result.failed, [], '不该出现失败（会话目录被提前跳过）');
    assert.ok(!fs.existsSync(path.join(userData, 'library')), '普通数据应被清掉');
    assert.ok(fs.existsSync(path.join(userData, 'Local Storage', 'leveldb', '000005.ldb')),
      '会话目录必须保留给 Electron 清，不能在这里删');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coversSessionDir 判断覆盖关系', () => {
  const sep = path.sep;
  const sessions = [path.resolve('C:', 'u', 'Local Storage'), path.resolve('C:', 'u', 'Network')];
  assert.equal(dm.coversSessionDir(path.resolve('C:', 'u', 'Local Storage'), sessions), true, '同一路径算覆盖');
  assert.equal(dm.coversSessionDir(path.resolve('C:', 'u', 'Network'), sessions), true);
  assert.equal(dm.coversSessionDir(path.resolve('C:', 'u'), sessions), true, '祖先目录算覆盖（删它会连带删）');
  assert.equal(dm.coversSessionDir(path.resolve('C:', 'u', 'library'), sessions), false, '兄弟目录不算');
  assert.equal(dm.coversSessionDir(path.resolve('C:', 'u', 'Local Storage2'), sessions), false,
    '名字前缀相同但不同目录不算');
});

test('清除可以按 scope 跳过（只清数据、保留登录态）', () => {
  const root = tmp('ciweimao-dm-skip-');
  try {
    const userData = path.join(root, 'userData');
    const dataDir = path.join(userData, 'data');
    write(path.join(dataDir, 'ui-prefs.json'), '{}');
    // Windows 目录名不能带冒号，这里用等价的普通名字代表登录态分区
    write(path.join(userData, 'Partitions', 'persist-ciweimao', 'Cookies'), 'x');

    const result = dm.reset(dm.resetTargets({ dataDir, userData }), { skip: ['session'] });
    assert.ok(result.skipped.includes('session'), 'session 应被跳过');
    assert.ok(fs.existsSync(path.join(userData, 'Partitions', 'persist-ciweimao', 'Cookies')),
      '跳过 session 时登录态应保留');
    assert.deepEqual(fs.readdirSync(dataDir), [], '数据仍应被清空');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同一秒内连续备份不会互相覆盖', () => {
  const root = tmp('ciweimao-dm-unique-');
  try {
    const userData = path.join(root, 'userData');
    const dataDir = path.join(userData, 'data');
    const backupDir = dm.backupRoot(path.join(root, 'Roaming'));
    const targets = dm.resetTargets({ dataDir, userData });

    write(path.join(dataDir, 'ui-prefs.json'), 'FIRST');
    const a = dm.createBackup(backupDir, targets, { reason: 'first' });
    write(path.join(dataDir, 'ui-prefs.json'), 'SECOND');
    const b = dm.createBackup(backupDir, targets, { reason: 'second' });

    assert.notEqual(a.name, b.name, '同秒两次备份必须落在不同目录');
    assert.equal(
      fs.readFileSync(path.join(backupDir, a.name, 'data', 'ui-prefs.json'), 'utf8'),
      'FIRST', '先前的备份不能被后来的覆盖',
    );
    assert.equal(
      fs.readFileSync(path.join(backupDir, b.name, 'data', 'ui-prefs.json'), 'utf8'),
      'SECOND',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('恢复能把数据放回去，并先给当前状态留一份备份', () => {
  const root = tmp('ciweimao-dm-restore-');
  try {
    const userData = path.join(root, 'userData');
    const dataDir = path.join(userData, 'data');
    const backupDir = dm.backupRoot(path.join(root, 'Roaming'));
    const targets = dm.resetTargets({ dataDir, userData });

    // 原始数据 → 备份 → 清空 → 写入「测试期间产生的新数据」
    write(path.join(dataDir, 'ui-prefs.json'), '{"theme":"dark","mine":true}');
    const made = dm.createBackup(backupDir, targets, { reason: 'before-clear' });
    dm.reset(targets);
    write(path.join(dataDir, 'ui-prefs.json'), '{"theme":"light","test":true}');

    const back = dm.restoreBackup(backupDir, made.name, targets);
    assert.equal(
      fs.readFileSync(path.join(dataDir, 'ui-prefs.json'), 'utf8'),
      '{"theme":"dark","mine":true}',
      '恢复后应回到备份时的内容',
    );

    // 恢复前的状态也留了备份，能退回来
    assert.ok(back.safetyBackup, '恢复前应自动生成安全备份');
    const list = dm.listBackups(backupDir);
    assert.equal(list.length, 2, '应有原始备份 + 恢复前备份两条');
    assert.ok(list.some((b) => b.reason === 'restore-pre'));

    const safetyPath = path.join(backupDir, back.safetyBackup, 'data', 'ui-prefs.json');
    assert.equal(fs.readFileSync(safetyPath, 'utf8'), '{"theme":"light","test":true}',
      '安全备份里应是恢复前的那份数据');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('恢复不存在的备份会报错而不是静默成功', () => {
  const root = tmp('ciweimao-dm-missing-');
  try {
    assert.throws(() => dm.restoreBackup(root, '20200101-000000', []), /备份不存在/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('备份列表按时间倒序，新的在最前', () => {
  const root = tmp('ciweimao-dm-list-');
  try {
    const dirA = path.join(root, '20260101-010101');
    const dirB = path.join(root, '20260202-020202');
    for (const [dir, name, at] of [
      [dirA, '20260101-010101', '2026-01-01T01:01:01.000Z'],
      [dirB, '20260202-020202', '2026-02-02T02:02:02.000Z'],
    ]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'backup.json'),
        JSON.stringify({ name, createdAt: at, parts: [] }), 'utf8');
    }
    const list = dm.listBackups(root);
    assert.equal(list.length, 2);
    assert.equal(list[0].name, '20260202-020202', '最新的备份应排在第一位');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('体积展示口径', () => {
  assert.equal(dm.humanSize(0), '0 B');
  assert.equal(dm.humanSize(999), '999 B');
  assert.equal(dm.humanSize(2048), '2.0 KB');
  assert.equal(dm.humanSize(5 * 1024 * 1024), '5.0 MB');
});
