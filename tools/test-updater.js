'use strict';

/**
 * updater 判定逻辑的单元测试。
 *
 * 这里**不启动 Electron**，只 require src/main/updater.js —— 该模块刻意不依赖
 * electron，就是为了让这些规则能在命令行里跑。
 *
 * 网络部分用本地 HTTP 服务模拟：一个正常包、一个内容与哈希不符的包、一个 404，
 * 以便覆盖「首个地址失效切下一个」和「校验不通过拒绝安装」两条路径。
 *
 * 运行：node tools/test-updater.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const updater = require('../src/main/updater.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 起一个只服务几个固定路径的本地服务器 */
function startServer(routes) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url];
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function tmpDir(tag) {
  const dir = path.join(os.tmpdir(), `cw-test-${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------- 1. semver

test('版本比较按数字段走，不能按字符串比', () => {
  assert.equal(updater.compareVersions('0.9.10', '0.10.0'), -1, '0.9.10 应小于 0.10.0');
  assert.equal(updater.compareVersions('0.10.1', '0.10.2'), -1);
  assert.equal(updater.compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(updater.compareVersions('0.10.2', '0.10.2'), 0);
  assert.equal(updater.compareVersions('v0.10.2', '0.10.2'), 0, '带 v 前缀也应能比');
});

test('非法版本号直接报错，不静默当作 0', () => {
  assert.equal(updater.parseVersion('0.10'), null);
  assert.equal(updater.parseVersion(''), null);
  assert.throws(() => updater.compareVersions('abc', '0.1.0'), /版本号不合法/);
});

// ------------------------------------------------------- 2. 跨版本变更集

test('跨版本筛选：只取 (当前, 目标] 区间，且按版本倒序', () => {
  const changes = [
    { version: '0.10.0', date: '2026-11-02', items: ['· 更早的改动'] },
    { version: '0.10.1', date: '2026-11-05', items: ['· 声明弹窗补全署名'] },
    { version: '0.10.2', date: '2026-11-08', items: ['· 修复：投递后页面不跳转'] },
    { version: '0.10.3', date: '2026-11-10', items: ['· 新增：自动更新'] },
    { version: '0.11.0', date: '2026-11-20', items: ['· 还没到'] },
  ];
  const r = updater.pickChanges('0.10.1', '0.10.3', changes);
  assert.deepEqual(r.bundle.map((e) => e.version), ['0.10.3', '0.10.2'], '倒序，且不含 0.10.1 及更早');
  assert.equal(r.across, 2);
  assert.equal(r.fallback, false);
  assert.equal(r.total, 2);
});

test('清单顺序写乱时，展示顺序仍按版本号排', () => {
  const changes = [
    { version: '0.10.3', date: 'c', items: ['· c'] },
    { version: '0.10.2', date: 'b', items: ['· b'] },
  ];
  const r = updater.pickChanges('0.10.1', '0.10.3', changes);
  assert.deepEqual(r.bundle.map((e) => e.version), ['0.10.3', '0.10.2']);
});

// ------------------------------------------------------ 3. changes 缺失

test('changes 缺失或为空 → 空数组 + fallback 标记', () => {
  const a = updater.pickChanges('0.10.1', '0.10.2', undefined);
  assert.deepEqual(a.bundle, []);
  assert.equal(a.fallback, true);

  const b = updater.pickChanges('0.10.1', '0.10.2', []);
  assert.equal(b.fallback, true);

  const c = updater.pickChanges('0.10.1', '0.10.2', [{ version: '0.10.2' }]);
  assert.equal(c.fallback, false, '有版本但没 items 也算提供了说明');
});

test('目标不高于当前时不产生变更集', () => {
  const r = updater.pickChanges('0.10.3', '0.10.3', [{ version: '0.10.3', items: ['· x'] }]);
  assert.equal(r.fallback, true);
  assert.equal(r.bundle.length, 0);
});

// ------------------------------------------------------ 4. 哈希不符拒绝

test('sha256 不符：拒绝落盘结果，不进入可安装状态', async (t) => {
  const payload = Buffer.from('this is not the package you expect');
  const { server, base } = await startServer({ '/pkg.zip': payload });
  t.after(() => server.close());

  const dir = tmpDir('sha');
  const dest = path.join(dir, 'pkg.zip');
  const wrongSha = sha256(Buffer.from('something else'));

  await assert.rejects(
    () => updater.downloadWithFallback([`${base}/pkg.zip`], dest, wrongSha),
    /下载失败.*校验不通过/s,
  );
  assert.equal(fs.existsSync(dest), false, '校验失败的文件必须清掉，不能留在盘上');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('sha256 相符：正常返回文件与字节数', async (t) => {
  const payload = Buffer.from('ok package body');
  const { server, base } = await startServer({ '/pkg.zip': payload });
  t.after(() => server.close());

  const dir = tmpDir('sha-ok');
  const dest = path.join(dir, 'pkg.zip');
  const r = await updater.downloadWithFallback([`${base}/pkg.zip`], dest, sha256(payload));

  assert.equal(r.bytes, payload.length);
  assert.equal(fs.existsSync(dest), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------- 5. 首个地址 404 切下一个

test('url 数组第一个 404、第二个可用 → 正常完成', async (t) => {
  const payload = Buffer.from('fallback works');
  const { server, base } = await startServer({ '/b.zip': payload });
  t.after(() => server.close());

  const dir = tmpDir('fallback');
  const dest = path.join(dir, 'pkg.zip');
  const r = await updater.downloadWithFallback(
    [`${base}/gone.zip`, `${base}/b.zip`],
    dest,
    sha256(payload),
  );

  assert.equal(r.url, `${base}/b.zip`, '应记录最终成功的地址');
  assert.equal(r.bytes, payload.length);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('全部地址都失败时抛出可读错误，并列出每个地址的原因', async (t) => {
  const { server, base } = await startServer({});
  t.after(() => server.close());

  const dir = tmpDir('allfail');
  await assert.rejects(
    () => updater.downloadWithFallback([`${base}/x.zip`], path.join(dir, 'p.zip'), 'a'.repeat(64)),
    /HTTP 404/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ 6. 跳过版本

test('skippedVersions：同版本不提示，更高版本提示并清理旧记录', () => {
  const skipped = ['0.10.2'];

  assert.equal(updater.isSkipped('0.10.2', skipped), true, '被跳过的版本不该再提示');
  assert.equal(updater.isSkipped('0.10.3', skipped), false, '更高版本必须提示');

  const cleaned = updater.pruneSkipped('0.10.3', skipped);
  assert.deepEqual(cleaned, [], '升到 0.10.3 后，0.10.2 的记录应被清掉');

  const keep = updater.pruneSkipped('0.10.2', ['0.10.2', '0.10.3']);
  assert.deepEqual(keep, ['0.10.3'], '只清理比目标低的，目标本身与更高的保留');

  assert.equal(updater.isSkipped('0.10.2', undefined), false);
  assert.equal(updater.isSkipped('0.10.2', []), false);
});

// ------------------------------------------------------------- 流式下载

test('流式下载：边收边报进度，累计字节单调递增且落在文件大小上', async (t) => {
  const payload = Buffer.alloc(240 * 1024, 7);
  // 分批发，确保客户端拿到的是多个 chunk，而不是一次性的一大块
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': payload.length,
    });
    const step = Math.floor(payload.length / 6);
    let offset = 0;
    const tick = setInterval(() => {
      if (offset >= payload.length) {
        clearInterval(tick);
        res.end();
        return;
      }
      const end = Math.min(offset + step, payload.length);
      res.write(payload.slice(offset, end));
      offset = end;
    }, 25);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const dir = tmpDir('stream');
  const dest = path.join(dir, 'pkg.zip');
  const seen = [];
  const r = await updater.downloadWithFallback(
    [`http://127.0.0.1:${port}/pkg.zip`],
    dest,
    sha256(payload),
    (bytes) => seen.push(bytes),
  );

  assert.ok(seen.length > 1, `进度应多次回调，实际 ${seen.length} 次`);
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1], '累计字节不能倒退');
  }
  assert.equal(seen[seen.length - 1], payload.length, '最后一次应等于文件总长');
  assert.equal(r.bytes, payload.length);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('下载中途失败会清掉半截文件，不留脏数据', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 100000 });
    res.write(Buffer.alloc(1000, 1));
    setTimeout(() => res.destroy(), 30);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const dir = tmpDir('partial');
  const dest = path.join(dir, 'pkg.zip');
  await assert.rejects(
    () => updater.downloadWithFallback([`http://127.0.0.1:${port}/pkg.zip`], dest, 'a'.repeat(64)),
  );
  assert.equal(fs.existsSync(dest), false, '断流后的半截文件必须删除');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- 清单校验

test('清单缺少 sha256 / url / 合法版本号时判为无效', () => {
  const base = { version: '0.10.2', type: 'app', size: 100, url: ['https://a/b.zip'] };

  assert.throws(() => updater.normalizeManifest({ ...base, sha256: '' }), /sha256/);
  assert.throws(() => updater.normalizeManifest({ ...base, sha256: 'xyz' }), /sha256/);
  assert.throws(() => updater.normalizeManifest({ ...base, sha256: 'a'.repeat(64), url: [] }), /下载地址/);
  assert.throws(() => updater.normalizeManifest({ ...base, sha256: 'a'.repeat(64), version: '0.10' }), /版本号不合法/);

  const ok = updater.normalizeManifest({
    version: '0.10.2',
    type: 'full',
    size: 2 * 1024 * 1024,
    sha256: 'A'.repeat(64),
    url: ['https://a/b.zip', 'ftp://bad/x.zip'],
    changes: [],
  });
  assert.equal(ok.type, 'full');
  assert.equal(ok.sha256, 'a'.repeat(64), '哈希统一转小写');
  assert.deepEqual(ok.urls, ['https://a/b.zip'], '非 http(s) 地址应被过滤');
  assert.match(ok.releasesPage, /github\.com\/.+\/releases$/);
});

// ------------------------------------------------------- 状态机与替换脚本

test('状态机读写与非法状态清理', () => {
  const dir = tmpDir('state');

  assert.equal(updater.readState(dir), null, '没有状态文件时返回 null');

  updater.writeState(dir, {
    to: '0.10.2', from: '0.10.1', at: '2026-11-08T10:00:00Z',
    stage: 'ready', bakPath: '', attempts: 0,
  });
  const s = updater.readState(dir);
  assert.equal(s.stage, 'ready');
  assert.equal(s.to, '0.10.2');

  updater.writeState(dir, { to: '0.10.2', from: '0.10.1', stage: 'bogus' });
  assert.equal(updater.readState(dir), null, '未知 stage 视为没有状态，避免卡在半路');

  updater.clearState(dir);
  assert.equal(updater.readState(dir), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('run-update.cmd 内容：等待旧进程、覆盖、等 ok 标记、失败回滚', () => {
  const cmd = updater.buildUpdateCommand({
    pid: 4321,
    appDir: 'C:\\app\\resources\\app',
    newDir: 'C:\\Temp\\cw-update\\0.10.2\\new',
    bakDir: 'C:\\app\\resources\\app.bak-0.10.1',
    exePath: 'C:\\app\\刺猬猫作家助手.exe',
    args: '',
    dataDir: 'C:\\data',
    to: '0.10.2',
    waitSeconds: 15,
  });

  assert.match(cmd, /set "OLDPID=4321"/);
  assert.match(cmd, /findstr \/R \/C:"\\"%OLDPID%\\""/, '用带引号的 PID 精确匹配，避免误中内存列');
  assert.match(cmd, /robocopy "%NEWDIR%" "%APPDIR%" \/E/);
  assert.match(cmd, /if exist "%OKFLAG%" goto ok/);
  assert.match(cmd, /set \/a LEFT=15/);
  assert.match(cmd, /:rollback/);
  assert.match(cmd, /move \/y "%BAKDIR%" "%APPDIR%"/);
  assert.match(cmd, /update-failed\.json/, '回滚后要留失败记录');
  assert.ok(cmd.indexOf(':rollback') > cmd.indexOf(':probe'), '回滚分支必须在新版本启动检测之后');
  // 等旧进程要有上限，否则旧进程赖着不走时脚本会无限循环（用户看到窗口一直闪）
  assert.match(cmd, /set \/a WAITED=0/, '等待循环要有计数器');
  assert.match(cmd, /if %WAITED% GEQ 30 goto go/, '等满 60 秒必须放行，不能无限等');
  assert.match(cmd, /del "%LOCKFILE%"/, '结束时清锁，否则下次更新会被误判为「脚本运行中」');
  assert.ok(!/必须|强制/.test(cmd), '脚本里不该出现强制类措辞');
});

test('dry-run：替换脚本只拼接不执行，且不触碰真实目录', () => {
  const probe = path.join(os.tmpdir(), `cw-dry-${Date.now()}`);
  fs.mkdirSync(probe, { recursive: true });

  let rolled = 0;
  try {
    const cmd = updater.buildUpdateCommand({
      pid: process.pid, appDir: probe, newDir: probe, bakDir: probe + '-bak',
      exePath: probe, args: '--dry-run', dataDir: probe, to: '0.0.1',
    });
    // 只做文本检查，不 spawn —— 真正执行留给用户点「立即重启」
    assert.ok(cmd.length > 0);
    assert.match(cmd, /--dry-run/);
    rolled += 1;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
  assert.equal(rolled, 1);
});

test('humanSize 输出人能看懂的单位', () => {
  assert.equal(updater.humanSize(0), '大小未知');
  assert.equal(updater.humanSize(2048), '2 KB');
  assert.equal(updater.humanSize(2.1 * 1024 * 1024), '2.1 MB');
});
