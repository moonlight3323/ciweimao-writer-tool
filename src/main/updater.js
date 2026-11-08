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
const DEFAULT_MANIFEST_API_URL = `https://api.github.com/repos/${REPO}/contents/update/latest.json?ref=main`;
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

/**
 * 启动时判断「这次是怎么变成新版本的」。
 *
 * 为什么要分：两种情况对用户的意义完全不同。
 *   - 软件自己提示并安装的自动更新 → 数据本来就该接着用，不该拿一个问题打断用户
 *   - 用户自己去 GitHub 下载完整包、解压到新目录 → 可能是想「换一个干净的版本」，
 *     也可能是想接着用旧数据，猜不出来，必须问
 *
 * @param {{current:string, last:string, autoInstalled:boolean}} o
 *   current      当前运行的版本（app.getVersion()）
 *   last         上次运行时记录的版本（首次运行是空串）
 *   autoInstalled 更新器是否确认这是它自己装上的（installing 状态 + 版本对得上）
 * @returns {{kind:string, direction:string, from:string, to:string}}
 *   kind: first-run | same-version | auto-update | manual-update
 *   direction: up（升级）| down（降级）| same
 */
function decideVersionChange(o) {
  const current = String((o && o.current) || '');
  const last = String((o && o.last) || '');
  const autoInstalled = !!(o && o.autoInstalled);

  if (!last) return { kind: 'first-run', direction: 'same', from: '', to: current };
  if (last === current) return { kind: 'same-version', direction: 'same', from: last, to: current };

  let direction = 'up';
  try {
    direction = compareVersions(current, last) > 0 ? 'up' : 'down';
  } catch (_) {
    // 版本号格式坏了（手改过 package.json）：当成升级处理，仍然问一句更安全
    direction = 'up';
  }

  return {
    kind: autoInstalled ? 'auto-update' : 'manual-update',
    direction,
    from: last,
    to: current,
  };
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
  const headers = Object.assign({
    Accept: 'application/vnd.github.raw+json',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': 'ciweimao-author-tool',
  }, o.headers || {});

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
    const req = lib.get(parsed, { timeout, headers }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (maxRedirect <= 0) {
          reject(new Error('重定向次数过多'));
          return;
        }
        const next = new URL(res.headers.location, parsed).href;
        httpGetBuffer(next, { maxRedirect: maxRedirect - 1, timeout, headers }).then(resolve, reject);
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

/**
 * 流式下载到文件，边下边回报进度。
 *
 * 早先的实现是把整个包读进内存再一次性落盘，代码是简单了，
 * 但进度回调只会在结束时触发一次 —— 界面上就是「一直 0% 然后突然满格」，
 * 用户根本看不出下载是不是在走。包只有 1 MB 出头，网络慢时那几秒最让人心慌。
 */
function httpDownloadToFile(url, destFile, onProgress, opts) {
  const o = opts || {};
  const maxRedirect = o.maxRedirect == null ? 5 : o.maxRedirect;
  const timeout = o.timeout == null ? 120000 : o.timeout;

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
        httpDownloadToFile(next, destFile, onProgress, { maxRedirect: maxRedirect - 1, timeout })
          .then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const ws = fs.createWriteStream(destFile);

      res.on('data', (chunk) => {
        received += chunk.length;
        if (typeof onProgress === 'function') onProgress(received, total);
      });
      res.on('error', (err) => {
        try { ws.destroy(); } catch (_) { /* ignore */ }
        reject(err);
      });
      ws.on('error', (err) => {
        try { res.destroy(); } catch (_) { /* ignore */ }
        reject(err);
      });
      ws.on('finish', () => resolve({ bytes: received, total }));
      res.pipe(ws);
    });

    req.on('timeout', () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

/** GitHub 的分支 raw 地址可能命中数分钟旧缓存；只给清单地址加时间戳，不改发布包 URL。 */
function manifestRequestUrl(url, now) {
  const parsed = new URL(url);
  if (parsed.hostname === 'raw.githubusercontent.com' || parsed.hostname === 'api.github.com') {
    parsed.searchParams.set('_cw', String(now == null ? Date.now() : now));
  }
  return parsed.href;
}

async function fetchManifest(urls, opts) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const errors = [];
  const stamp = Date.now();
  for (const u of list) {
    try {
      const requestUrl = manifestRequestUrl(u, stamp);
      const buf = await httpGetBuffer(requestUrl, opts);
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
 * GitHub Release 的下载域名（objects.githubusercontent.com）在国内经常连不上，
 * 表现就是卡住不动、最后报「请求超时」，用户只看到一句「没能下到更新包」。
 *
 * 这里对官方地址自动补一层镜像，清单里只写官方地址也能走通，发版时少一处要记得改。
 * 镜像在前、官方在后：国内直连基本必然超时，把官方放前面等于先让用户干等一轮。
 * 镜像只是通道 —— 包体仍由清单里的 sha256 校验，被换过就装不上（会换下一个地址重试）。
 */
const MIRRORS = ['https://ghfast.top/'];

/** 已经是「镜像/官方地址」的形态（镜像本身也含一个 http 前缀） */
const WRAPPED_RE = /^https:\/\/[^/]+\/https?:\/\//i;
const RELEASE_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//i;

/**
 * 把清单里的下载地址展开成「镜像 + 原地址」，去重后返回。
 *
 * 清单里已经写过镜像的（旧做法）不会再加一层，避免出现
 * `ghfast.top/https://ghfast.top/…` 这种双前缀。
 */
function expandMirrors(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const out = [];
  const seen = new Set();
  const push = (u) => {
    const v = String(u || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  for (const raw of list) {
    const url = String(raw || '').trim();
    if (!url) continue;
    if (RELEASE_RE.test(url) && !WRAPPED_RE.test(url)) {
      for (const m of MIRRORS) push(m + url);
    }
    push(url);
  }
  return out;
}

/** 单个地址的下载超时：包体只有 1~2 MB，25 秒还没起来就该换源了 */
const DOWNLOAD_TIMEOUT_MS = 25000;

/**
 * 依次尝试清单里的每个地址下载，任一成功且哈希匹配即返回。
 *
 * 哈希只在整个文件落盘后算一次：边下边算看着快，但一旦某个地址中途断流，
 * 已经喂进去的数据没法回退，反而要重下；先落盘再校验，失败就换下一个地址重来。
 */
async function downloadWithFallback(urls, destFile, expectedSha, onProgress) {
  const list = expandMirrors(urls);
  const errors = [];
  fs.mkdirSync(path.dirname(destFile), { recursive: true });

  for (const url of list) {
    try {
      // 边下边落盘，进度回调按已收到的累计字节数上报
      const got = await httpDownloadToFile(url, destFile, onProgress, { timeout: DOWNLOAD_TIMEOUT_MS });
      const sha = await sha256File(destFile);
      if (sha !== String(expectedSha || '').toLowerCase()) {
        errors.push(`${hostOf(url)}：校验不通过`);
        try { fs.unlinkSync(destFile); } catch (_) { /* ignore */ }
        continue;
      }
      return { file: destFile, bytes: got.bytes, url };
    } catch (e) {
      // 报错只带域名：整条 URL 又长又重复（镜像版还带两层），
      // 十几条拼上去会顶满弹窗，用户还是看不出到底卡在哪一步。
      errors.push(`${hostOf(url)}：${e.message}`);
      // 半截文件留着没有意义，还会让下一次校验读到脏数据
      try { if (fs.existsSync(destFile)) fs.unlinkSync(destFile); } catch (_) { /* ignore */ }
    }
  }
  throw new Error(`下载失败（${errors.join('；') || '没有可用地址'}）`);
}

/** 取 URL 的主机名，用于把错误信息说短些 */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch (_) {
    return String(url).slice(0, 40);
  }
}

// -------------------------------------------------------------- 状态机

/** 下载与解压的临时工作目录（系统临时目录下的固定子目录） */
function tempRoot() {
  return path.join(os.tmpdir(), 'cw-update');
}

function statePath(dataDir) { return path.join(dataDir, 'update-state.json'); }function failedPath(dataDir) { return path.join(dataDir, 'update-failed.json'); }
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
  const wait = Number(o.waitSeconds) > 0 ? Math.ceil(Number(o.waitSeconds)) : 60;
  const q = (s) => String(s == null ? '' : s).replace(/"/g, '""');
  const stateFile = statePath(o.dataDir);
  const failedFile = failedPath(o.dataDir);
  const okFlag = okFlagPath(o.dataDir);

  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal enableextensions',
    'setlocal disabledelayedexpansion',
    `set "OLDPID=${o.pid}"`,
    `set "APPDIR=${q(o.appDir)}"`,
    `set "NEWDIR=${q(o.newDir)}"`,
    `set "BAKDIR=${q(o.bakDir)}"`,
    `set "EXEPATH=${q(o.exePath)}"`,
    `set "EXEARGS=${q(o.args || '')}"`,
    `set "OKFLAG=${q(okFlag)}"`,
    `set "STATEFILE=${q(stateFile)}"`,
    `set "FAILEDFILE=${q(failedFile)}"`,
    `set "LOCKFILE=${q(o.lockPath || path.join(tempRoot(), 'run-update.lock'))}"`,
    '',
    'rem 旧进程还在跑就等着，它退出后才允许碰文件',
    'set /a WAITED=0',
    ':wait',
    'if not defined OLDPID goto go',
    'rem 最多等 60 秒：旧进程万一赖着不走，也不能让这个窗口无限循环下去',
    'if %WAITED% GEQ 30 goto busyfail',
    'tasklist /FI "PID eq %OLDPID%" /FO CSV /NH 2>nul | findstr /R /C:"\\"%OLDPID%\\"" >nul',
    'if errorlevel 1 goto go',
    'call :sleep 2',
    'if errorlevel 1 goto sleepfail',
    'set /a WAITED+=1',
    'goto wait',
    '',
    ':go',
    'if exist "%OKFLAG%" del "%OKFLAG%" >nul 2>nul',
    'rem 先备份：同盘 move 是重命名，秒完成；备份没成功就绝不覆盖',
    'if exist "%BAKDIR%" rd /s /q "%BAKDIR%" >nul 2>nul',
    'move /y "%APPDIR%" "%BAKDIR%" >nul 2>nul',
    'if exist "%APPDIR%" goto backupfail',
    'robocopy "%NEWDIR%" "%APPDIR%" /E /NFL /NDL /NJH /NJS /R:1 /W:1 >nul',
    'if errorlevel 8 goto copyfail',
    'start "" "%EXEPATH%" %EXEARGS%',
    '',
    `rem 等新版本自己写 ok 标记：最多等 ${wait} 秒`,
    `set /a LEFT=${wait}`,
    ':probe',
    'if exist "%OKFLAG%" goto ok',
    'if %LEFT% LEQ 0 goto rollback',
    'set /a LEFT-=1',
    'call :sleep 1',
    'if errorlevel 1 goto rollback',
    'goto probe',
    '',
    ':ok',
    'del "%OKFLAG%" >nul 2>nul',
    'del "%STATEFILE%" >nul 2>nul',
    'del "%LOCKFILE%" >nul 2>nul',
    'rd /s /q "%BAKDIR%" >nul 2>nul',
    'rem 当前脚本由下次正常启动清理，执行中不自删',
    'exit /b 0',
    '',
    ':rollback',
    'set "FAILREASON=启动确认超时"',
    'goto restore',
    ':copyfail',
    'set "FAILREASON=复制更新文件失败"',
    ':restore',
    'rd /s /q "%APPDIR%" >nul 2>nul',
    'move /y "%BAKDIR%" "%APPDIR%" >nul 2>nul',
    `>"%FAILEDFILE%" echo {"at":"%DATE% %TIME%","to":"${q(o.to)}","reason":"%FAILREASON%"}`,
    'del "%STATEFILE%" >nul 2>nul',
    'del "%LOCKFILE%" >nul 2>nul',
    'start "" "%EXEPATH%" %EXEARGS%',
    'exit /b 1',
    '',
    ':backupfail',
    'rem 备份没做成说明目录被占用，此时宁可放弃这次升级，也不能覆盖掉唯一的副本',
    `>"%FAILEDFILE%" echo {"at":"%DATE% %TIME%","to":"${q(o.to)}","reason":"备份失败"}`,
    'del "%STATEFILE%" >nul 2>nul',
    'del "%LOCKFILE%" >nul 2>nul',
    'start "" "%EXEPATH%" %EXEARGS%',
    'exit /b 2',
    '',
    ':busyfail',
    `>"%FAILEDFILE%" echo {"at":"%DATE% %TIME%","to":"${q(o.to)}","reason":"旧进程未退出，未替换文件"}`,
    'del "%STATEFILE%" >nul 2>nul',
    'del "%LOCKFILE%" >nul 2>nul',
    'exit /b 3',
    '',
    ':sleepfail',
    `>"%FAILEDFILE%" echo {"at":"%DATE% %TIME%","to":"${q(o.to)}","reason":"后台等待组件不可用，未替换文件"}`,
    'del "%STATEFILE%" >nul 2>nul',
    'del "%LOCKFILE%" >nul 2>nul',
    'start "" "%EXEPATH%" %EXEARGS%',
    'exit /b 4',
    '',
    ':sleep',
    'rem timeout.exe 在无控制台输入时直接失败，使用无需标准输入的等待方式',
    'powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds %~1" >nul 2>nul',
    'exit /b %errorlevel%',
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
  DEFAULT_MANIFEST_API_URL,
  DEFAULT_MANIFEST_URL,
  RELEASES_PAGE,
  MAX_CHANGES,
  MIRRORS,
  expandMirrors,
  DOWNLOAD_TIMEOUT_MS,
  parseVersion,
  compareVersions,
  pickChanges,
  isSkipped,
  pruneSkipped,
  decideVersionChange,
  normalizeManifest,
  humanSize,
  httpGetBuffer,
  manifestRequestUrl,
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
  tempRoot,
};
