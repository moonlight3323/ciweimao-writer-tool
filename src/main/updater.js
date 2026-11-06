'use strict';

/**
 * 自动更新：清单解析、版本对比、下载校验、替换与回滚。
 *
 * 设计约束：
 * 1. 本模块**不 require electron**，所有路径由调用方（main.js）传入。
 *    这样 tools/test-updater.js 可以在纯 Node 下跑完所有判定逻辑，不必启动应用。
 * 2. 网络请求走 Node 内置 https，不引第三方库；下载器自己处理 302
 *    （GitHub Release 的附件会跳到 objects.githubusercontent.com）。
 * 3. 更新只读仓库里的 update/latest.json，客户端不写回任何东西到仓库。
 *
 * 目录约定：
 *   data/update-state.json   升级状态机（下载中/待重启/安装中）
 *   data/update-failed.json  回滚记录，启动时提示一次后删除
 *   data/update-ok.flag      新版本启动成功的标记，供 run-update.cmd 判断
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const REPO = 'moonlight3323/ciweimao-writer-tool';
const DEFAULT_MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/main/update/latest.json`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
/** 清单里保留多少个历史版本 */
const MAX_CHANGES = 10;

// ------------------------------------------------------------------ 版本号

/**
 * 解析 x.y.z。缺位补 0，非法字符直接判失败（返回 null），
 * 让调用方明确报「清单版本号不合法」而不是悄悄当成 0.0.0。
 */
function parseVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  const m = s.match(/^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 / 0 / 1；任一侧不合法时抛错，避免「拿不准就当作相同」造成误升级 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`版本号不合法：${!pa ? a : b}`);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

// -------------------------------------------------------------- 变更集筛选

/**
 * 从清单的 changes 里挑出「比当前版本新、且不超过目标版本」的条目，按版本倒序。
 *
 * 为什么按版本而不是按数组顺序：清单是人手维护的，十条记录里偶尔会插错位置；
 * 按版本号排一次，展示顺序就不会因为手抖而颠倒。
 *
 * changes 缺失或筛完为空时返回 fallback=true，界面据此显示
 * 「作者未提供本次更新说明」并给出发布页入口，而不是展示一个空列表。
 */
function pickChanges(current, target, changes) {
  const empty = { bundle: [], total: 0, fallback: true, across: 0 };
  if (!Array.isArray(changes) || !changes.length) return empty;

  let cur;
  let tgt;
  try {
    cur = compareVersions(current, target);
    // 目标不高于当前，说明不需要更新，变更集自然为空
    if (cur >= 0) return empty;
  } catch (_) {
    return empty;
  }

  const picked = [];
  for (const entry of changes) {
    if (!entry || typeof entry !== 'object') continue;
    let cmpLow;
    let cmpHigh;
    try {
      cmpLow = compareVersions(entry.version, current);
      cmpHigh = compareVersions(entry.version, target);
    } catch (_) {
      continue; // 单条版本号写错就跳过，不拖垮整份清单
    }
    if (cmpLow <= 0 || cmpHigh > 0) continue;
    picked.push({
      version: entry.version,
      date: typeof entry.date === 'string' ? entry.date : '',
      items: Array.isArray(entry.items)
        ? entry.items.map((x) => String(x == null ? '' : x)).filter(Boolean)
        : [],
    });
  }

  picked.sort((x, y) => compareVersions(y.version, x.version));
  return {
    bundle: picked,
    total: picked.reduce((n, e) => n + e.items.length, 0),
    fallback: picked.length === 0,
    across: picked.length,
  };
}

// ---------------------------------------------------------------- 跳过版本

/**
 * skippedVersions 里保存用户「跳过此版本」的选择。
 * 目标版本命中就不提示，同时把比它低的记录清掉 —— 升到更高版本后，
 * 那些旧记录再也不会被比较到，留着只会让偏好文件越积越长。
 */
function isSkipped(target, skipped) {
  if (!Array.isArray(skipped) || !skipped.length) return false;
  return skipped.some((v) => {
    try { return compareVersions(v, target) === 0; } catch (_) { return false; }
  });
}

function pruneSkipped(target, skipped) {
  if (!Array.isArray(skipped) || !skipped.length) return [];
  return skipped.filter((v) => {
    try { return compareVersions(v, target) > 0; } catch (_) { return false; }
  });
}

// ------------------------------------------------------------------ 清单

/**
 * 校验并规整清单。
 *
 * 这里刻意严格：缺 sha256、缺 url、版本号写坏，都直接判为无效清单。
 * 宁可「检查不到更新」，也不要在校验信息不全的情况下动用户的应用目录。
 */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('清单不是对象');
  const version = String(raw.version || '').trim();
  if (!parseVersion(version)) throw new Error(`清单版本号不合法：${version || '(空)'}`);

  const type = raw.type === 'full' ? 'full' : 'app';
  const sha256 = String(raw.sha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('清单缺少有效的 sha256');

  const urls = (Array.isArray(raw.url) ? raw.url : [raw.url])
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//i.test(u));
  if (!urls.length) throw new Error('清单缺少可用的下载地址');

  const size = Number(raw.size);
  return {
    version,
    type,
    sha256,
    urls,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    changes: Array.isArray(raw.changes) ? raw.changes.slice(0, MAX_CHANGES) : [],
    releasesPage: RELEASES_PAGE,
  };
}

/** 把字节数说成人话，界面和提示文案都用它 */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '大小未知';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ------------------------------------------------------------------ 网络

/**
 * GET 一个地址，跟随重定向，返回 Buffer。
 * 只允许 http/https 且限制跳转次数，避免被恶意清单带到奇怪的地方。
 */
function httpGetBuffer(url, opts) {
  const o = opts || {};
  const maxRedirect = o.maxRedirect == null ? 5 : o.maxRedirect;
  const timeout = o.timeout == null ? 20000 : o.timeout;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      reject(new Error(`地址不合法：${url}`));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error(`不支持的协议：${parsed.protocol}`));
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, { timeout }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (maxRedirect <= 0) {
          reject(new Error('重定向次数过多'));
          return;
        }
        const next = new URL(res.headers.location, parsed).href;
        httpGetBuffer(next, { maxRedirect: maxRedirect - 1, timeout }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

async function fetchManifest(urls, opts) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const errors = [];
  for (const u of list) {
    try {
      const buf = await httpGetBuffer(u, opts);
      return normalizeManifest(JSON.parse(buf.toString('utf8')));
    } catch (e) {
      errors.push(`${u}：${e.message}`);
    }
  }
  throw new Error(`读取更新清单失败（${errors.join('；') || '没有可用地址'}）`);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * 依次尝试清单里的每个地址下载，任一成功且哈希匹配即返回。
 *
 * 哈希只在整个文件落盘后算一次：边下边算看着快，但一旦某个地址中途断流，
 * 已经喂进去的数据没法回退，反而要重下；先落盘再校验，失败就换下一个地址重来。
 */
async function downloadWithFallback(urls, destFile, expectedSha, onProgress) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const errors = [];
  fs.mkdirSync(path.dirname(destFile), { recursive: true });

  for (const url of list) {
    try {
      const buf = await httpGetBuffer(url, { timeout: 120000 });
      if (typeof onProgress === 'function') onProgress(buf.length);
      fs.writeFileSync(destFile, buf);
      const got = await sha256File(destFile);
      if (got !== String(expectedSha || '').toLowerCase()) {
        errors.push(`${url}：校验不通过`);
        try { fs.unlinkSync(destFile); } catch (_) { /* ignore */ }
        continue;
      }
      return { file: destFile, bytes: buf.length, url };
    } catch (e) {
      errors.push(`${url}：${e.message}`);
    }
  }
  throw new Error(`下载失败（${errors.join('；') || '没有可用地址'}）`);
}

// -------------------------------------------------------------- 状态机

function statePath(dataDir) { return path.join(dataDir, 'update-state.json'); }
function failedPath(dataDir) { return path.join(dataDir, 'update-failed.json'); }
function okFlagPath(dataDir) { return path.join(dataDir, 'update-ok.flag'); }

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readState(dataDir) {
  const s = readJson(statePath(dataDir));
  if (!s || typeof s !== 'object') return null;
  const valid = s.stage === 'downloading' || s.stage === 'ready' || s.stage === 'installing';
  if (!valid) return null;
  return {
    to: String(s.to || ''),
    from: String(s.from || ''),
    at: String(s.at || ''),
    stage: s.stage,
    bakPath: typeof s.bakPath === 'string' ? s.bakPath : '',
    attempts: Number(s.attempts) || 0,
  };
}

function writeState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statePath(dataDir), JSON.stringify(state, null, 2), 'utf8');
}

function clearState(dataDir) {
  try { fs.unlinkSync(statePath(dataDir)); } catch (_) { /* 本来就没有 */ }
}

function readFailed(dataDir) { return readJson(failedPath(dataDir)); }

function clearFailed(dataDir) {
  try { fs.unlinkSync(failedPath(dataDir)); } catch (_) { /* ignore */ }
}

function writeFailed(dataDir, info) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(failedPath(dataDir), JSON.stringify(info, null, 2), 'utf8');
}

// ------------------------------------------------------ run-update.cmd 生成

/**
 * 生成替换脚本。
 *
 * 几个关键取舍：
 * - 用 `findstr /R /C:"\"<pid>\""` 判断旧进程是否退出：tasklist 的 CSV 输出里
 *   PID 一定带引号，按整数直接找会误中内存列（"12,345 K"）。
 * - 启动结果不靠 `tasklist` 匹配中文进程名（bat 编码一错就永远匹配不上），
 *   改为等新版本自己写 update-ok.flag —— 它必须成功跑完启动流程才会写，
 *   比「进程存在」更能证明真的起来了。
 * - 全程不删 resources\app.bak-：只有在确认新版本启动成功后才删，
 *   失败时它就是回滚源。
 *
 * @param {Object} o
 * @param {string} o.pid            旧主进程 PID
 * @param {string} o.appDir         要替换的 resources\app
 * @param {string} o.newDir         解压好的新代码目录
 * @param {string} o.bakDir         备份目录（app.bak-<旧版本>）
 * @param {string} o.exePath        新 exe 路径
 * @param {string} o.args           启动参数（已拼好，可为空）
 * @param {string} o.dataDir        数据目录，用于找 ok.flag 与写失败记录
 * @param {string} o.to             目标版本
 * @param {number} [o.waitSeconds]  等待新版本启动的秒数
 */
function buildUpdateCommand(o) {
  const wait = Number(o.waitSeconds) > 0 ? Number(o.waitSeconds) : 15;
  const q = (s) => String(s == null ? '' : s).replace(/"/g, '""');
  const stateFile = statePath(o.dataDir);
  const failedFile = failedPath(o.dataDir);
  const okFlag = okFlagPath(o.dataDir);

  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal enableextensions',
    `set "OLDPID=${o.pid}"`,
    `set "APPDIR=${q(o.appDir)}"`,
    `set "NEWDIR=${q(o.newDir)}"`,
    `set "BAKDIR=${q(o.bakDir)}"`,
    `set "EXEPATH=${q(o.exePath)}"`,
    `set "EXEARGS=${q(o.args || '')}"`,
    `set "OKFLAG=${q(okFlag)}"`,
    `set "STATEFILE=${q(stateFile)}"`,
    `set "FAILEDFILE=${q(failedFile)}"`,
    '',
    'rem 旧进程还在跑就等着，它退出后才允许碰文件',
    ':wait',
    'if not defined OLDPID goto go',
    'tasklist /FI "PID eq %OLDPID%" /NH 2>nul | findstr /R /C:"\\"%OLDPID%\\"" >nul',
    'if errorlevel 1 goto go',
    'timeout /t 2 /nobreak >nul',
    'goto wait',
    '',
    ':go',
    'if exist "%OKFLAG%" del "%OKFLAG%" >nul 2>nul',
    'rem 先备份：同盘 move 是重命名，秒完成；备份没成功就绝不覆盖',
    'if exist "%BAKDIR%" rd /s /q "%BAKDIR%" >nul 2>nul',
    'move /y "%APPDIR%" "%BAKDIR%" >nul 2>nul',
    'if exist "%APPDIR%" goto backupfail',
    'robocopy "%NEWDIR%" "%APPDIR%" /E /NFL /NDL /NJH /NJS /R:1 /W:1 >nul',
    'start "" "%EXEPATH%" %EXEARGS%',
    '',
    `rem 等新版本自己写 ok 标记：最多等 ${wait} 秒`,
    `set /a LEFT=${wait}`,
    ':probe',
    'if exist "%OKFLAG%" goto ok',
    'if %LEFT% LEQ 0 goto rollback',
    'set /a LEFT-=1',
    'timeout /t 1 /nobreak >nul',
    'goto probe',
    '',
    ':ok',
    'del "%OKFLAG%" >nul 2>nul',
    'del "%STATEFILE%" >nul 2>nul',
    'rd /s /q "%BAKDIR%" >nul 2>nul',
    'del "%~f0" >nul 2>nul',
    'exit /b 0',
    '',
    ':rollback',
    'rd /s /q "%APPDIR%" >nul 2>nul',
    'move /y "%BAKDIR%" "%APPDIR%" >nul 2>nul',
    `>"%FAILEDFILE%" echo {"at":"%DATE% %TIME%","to":"${q(o.to)}","reason":"启动失败"}`,
    'start "" "%EXEPATH%" %EXEARGS%',
    'del "%~f0" >nul 2>nul',
    'exit /b 1',
    '',
    ':backupfail',
    'rem 备份没做成说明目录被占用，此时宁可放弃这次升级，也不能覆盖掉唯一的副本',
    `>"%FAILEDFILE%" echo {"at":"%DATE% %TIME%","to":"${q(o.to)}","reason":"备份失败"}`,
    'del "%STATEFILE%" >nul 2>nul',
    'start "" "%EXEPATH%" %EXEARGS%',
    'del "%~f0" >nul 2>nul',
    'exit /b 2',
    '',
  ].join('\r\n');
}

/** 解压：交给系统自带的 PowerShell，避免为了一个 zip 引第三方依赖 */
function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const ps = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ];
    const child = require('child_process').spawn('powershell', ps, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(destDir);
      else reject(new Error(`解压失败（退出码 ${code}）${err ? '：' + err.trim().slice(0, 200) : ''}`));
    });
  });
}

module.exports = {
  REPO,
  DEFAULT_MANIFEST_URL,
  RELEASES_PAGE,
  MAX_CHANGES,
  parseVersion,
  compareVersions,
  pickChanges,
  isSkipped,
  pruneSkipped,
  normalizeManifest,
  humanSize,
  httpGetBuffer,
  fetchManifest,
  sha256File,
  downloadWithFallback,
  statePath,
  readState,
  writeState,
  clearState,
  readFailed,
  writeFailed,
  clearFailed,
  okFlagPath,
  buildUpdateCommand,
  extractZip,
  tempRoot: () => path.join(os.tmpdir(), 'cw-update'),
};
