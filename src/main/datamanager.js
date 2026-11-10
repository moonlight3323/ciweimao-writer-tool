'use strict';

/**
 * 数据备份 / 清除 / 恢复
 *
 * 用途：让「测试完整流程」这件事有个一键往返——清干净、像新用户一样跑一遍，
 * 跑完还能把真实数据放回去。
 *
 * 三条硬规则（改代码前先读）：
 * 1. **备份目录必须在 userData 之外**。备份放 `%APPDATA%\刺猬猫作家助手-数据备份\`，
 *    它是 userData（`%APPDATA%\刺猬猫作家助手\`）的兄弟目录，清除 userData 时不会被连带删掉。
 * 2. **备份先落盘、确认成功，再删原数据**。备份失败就中止，宁可不清。
 * 3. **恢复前先把当前状态再备份一次**，恢复错了还能退回来。
 *
 * 清除范围分成三类，见 resetTargets()：
 *   数据目录内容（作品库 / 敏感词库 / 插件 / 统计快照 / 偏好 / 更新状态）
 *   密码本（vault.js 固定写在 userData/data 下，自定义数据目录时它与数据目录不在一处）
 *   登录态与界面存储（不删的话清完还自动登录着，看不出「新用户」状态）
 */

const fs = require('fs');
const path = require('path');

/** 备份目录名：与 userData 同级 */
const BACKUP_DIR_NAME = '刺猬猫作家助手-数据备份';

function stamp(date) {
  const d = date || new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * 生成不重名的备份目录名。
 *
 * stamp() 只精确到秒，而「清除」和「恢复」都可能在同一秒内连续备份两次
 * （恢复前的安全备份就属于这种），只用时间戳会让后来的覆盖掉先前的，
 * 于是刚备份好的原始数据当场消失。撞名时追加 -2、-3。
 */
function uniqueName(root, base) {
  let name = base;
  for (let i = 2; fs.existsSync(path.join(root, name)); i += 1) {
    name = `${base}-${i}`;
  }
  return name;
}

/**
 * 备份根目录。
 * @param {string} appDataPath  app.getPath('appData')，Windows 上是 %APPDATA%
 */
function backupRoot(appDataPath) {
  return path.join(appDataPath, BACKUP_DIR_NAME);
}

/**
 * 需要清除的目标清单。
 *
 * 返回的是「绝对路径 + 是否整目录删除 + 用什么方式清」的描述，调用方按 kind/via 处理。
 * 做成纯函数是为了能直接单测：改清除范围时必须能一眼看到全貌。
 *
 * `via` 是个关键区分，之前没有它才出的 bug：
 *   'fs'       → 我们自己的 JSON/文件，用 fs 删（这是唯一正确的方式）
 *   'electron' → Chromium 自己的存储目录（Local Storage / Network / Partitions …），
 *                它们被运行中的进程用 LevelDB 打开着，**fs 删一定 EPERM**，
 *                必须走 Electron 的 session.clearStorageData()
 *
 * @param {{dataDir:string, userData:string}} o
 */
function resetTargets(o) {
  const dataDir = path.resolve(o.dataDir);
  const userData = path.resolve(o.userData);
  const targets = [];

  // 1) 数据目录里的全部内容（不删 dataDir 本身，用户可能选了自己的文件夹，
  //    删掉文件夹会让用户以为丢了盘符上的目录）
  targets.push({ scope: 'data', kind: 'contents', via: 'fs', path: dataDir });

  // 2) 密码本：vault.js 写死在 userData/data/vault.json
  const vaultDir = path.join(userData, 'data');
  if (path.resolve(vaultDir) !== dataDir) {
    targets.push({ scope: 'vault', kind: 'contents', via: 'fs', path: vaultDir });
  }

  // 3) 登录态与界面存储。缺哪一个都正常（首次运行还没生成）。
  //    这些全部交给 session API 清，**不要用 fs 删**——它们在运行时是被锁住的，
  //    rmSync 会抛 EPERM「Permission denied: …\Local Storage」，整个清除就此失败。
  //    路径仍然列出来，一是让调用方知道要清哪些会话分区，二是界面上能说清清除范围。
  for (const item of [
    'Partitions',            // persist:ciweimao / persist:miaoyu 登录态分区
    'Local Storage',
    'Session Storage',
    'IndexedDB',
    'Network',               // Cookies 在新版 Electron 里位于 Network 下
    'Cookies',
    'Cookies-journal',
  ]) {
    targets.push({
      scope: 'session',
      kind: 'path',
      via: 'electron',
      path: path.join(userData, item),
    });
  }

  // 4) 「数据保存在哪里」这个选择本身。留着它，重启后不会重新问一遍，
  //    但重启后的数据会直接落回用户之前选的自定义目录 —— 那就不是「第一次拿到软件」了
  targets.push({
    scope: 'storage',
    kind: 'path',
    via: 'fs',
    path: path.join(userData, 'storage-location.json'),
  });

  return targets;
}

/** 需要走文件系统删除的目标（我们自己写的文件），null 安全 */
function fsTargets(targets) {
  return (Array.isArray(targets) ? targets : []).filter((t) => t && t.via !== 'electron');
}

/** 需要走 Electron session API 清理的目标（Chromium 自己的存储） */
function sessionTargets(targets) {
  return (Array.isArray(targets) ? targets : []).filter((t) => t && t.via === 'electron');
}

/** 目录大小（字节）；不存在返回 0 */
function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else {
      try { total += fs.statSync(full).size; } catch (_) { /* 跳过读不到的 */ }
    }
  }
  return total;
}

/**
 * 递归复制；目标已存在则合并覆盖。
 *
 * failures 传入数组时，任何复制失败都会记进去（路径 + 原因），而不是静默跳过。
 * 备份流程靠它判断「这份备份到底完不完整」——文件被杀软/同步盘短暂锁住时，
 * 静默跳过会让调用方以为备份成功，随后删掉原数据，造成不可逆的丢稿。
 */
function copyTree(from, to, failures) {
  let copied = 0;
  try { fs.mkdirSync(to, { recursive: true }); }
  catch (err) {
    if (failures) failures.push({ path: to, message: err.message });
    return 0;
  }
  let entries;
  try { entries = fs.readdirSync(from, { withFileTypes: true }); }
  catch (err) {
    if (failures) failures.push({ path: from, message: err.message });
    return 0;
  }
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copied += copyTree(src, dst, failures);
    } else {
      // 符号链接也按文件复制（Chromium 缓存里可能有）
      try { fs.copyFileSync(src, dst); copied += 1; }
      catch (err) { if (failures) failures.push({ path: src, message: err.message }); }
    }
  }
  return copied;
}

/** 把目标清单里的内容复制进备份目录，返回 manifest */
function createBackup(root, targets, meta) {
  const name = uniqueName(root, stamp());
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });

  const parts = [];
  const failures = [];
  let files = 0;
  for (const t of targets) {
    if (!fs.existsSync(t.path)) continue;
    // 备份里按 scope 分文件夹，恢复时不必再猜原始位置
    const dst = path.join(dir, t.scope);
    if (t.kind === 'contents') {
      files += copyTree(t.path, dst, failures);
      parts.push({ scope: t.scope, kind: t.kind, from: t.path, single: false });
    } else {
      // 单个路径：目录就整棵复制，文件就复制文件。
      // single 必须落进 manifest —— 恢复时只看「备份里是目录还是文件」会分不清
      // 「一个目录」和「一个被复制进目录里的单文件」，v1.1.0 的恢复 bug 就出在这。
      const st = fs.statSync(t.path);
      if (st.isDirectory()) {
        files += copyTree(t.path, dst, failures);
        parts.push({ scope: t.scope, kind: t.kind, from: t.path, single: false });
      } else {
        fs.mkdirSync(dst, { recursive: true });
        try { fs.copyFileSync(t.path, path.join(dst, path.basename(t.path))); files += 1; }
        catch (err) { failures.push({ path: t.path, message: err.message }); }
        parts.push({ scope: t.scope, kind: t.kind, from: t.path, single: true });
      }
    }
  }

  // 规则 2：备份不完整就不算成功。半份备份比没有更危险 ——
  // 调用方会以为「已经备份好了」，接着把原数据删掉。
  if (failures.length) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    const sample = failures.slice(0, 3).map((f) => f.path).join('、');
    throw new Error(`备份未完成：${failures.length} 个文件无法复制（${sample}）。`
      + '通常是杀毒软件或同步盘正在占用这些文件，请稍后重试；数据没有被删除。');
  }

  const manifest = {
    name,
    createdAt: new Date().toISOString(),
    files,
    bytes: dirSize(dir),
    reason: (meta && meta.reason) || '',
    parts,
  };
  fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/** 列出所有备份，新的在前 */
function listBackups(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_) { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8')); }
    catch (_) { continue; }
    if (!manifest || !manifest.name) continue;
    out.push({ ...manifest, path: dir });
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

/**
 * 从备份恢复。
 *
 * 恢复前会先把当前状态再备份一份（reason 标记 restore-pre），
 * 所以「恢复错了」也能退回到操作前。
 *
 * 「恢复」是覆盖语义：先清掉目标目录里备份中不存在的旧文件，再复制。
 * 只合并不清理的话，备份之后新增/改名的书会留在盘上但不在索引里，
 * 既占空间又会让用户看到「恢复完成但数据对不上」。
 *
 * targets 需要传完整清单（含 via=electron 的会话目录），这样清空数据目录时
 * 才能跳过 Chromium 正在占用的 Local Storage / Network。备份本身仍只包含
 * 用户数据（会话目录有几十 MB 缓存且恢复后也要重新登录）。
 */
function restoreBackup(root, name, targets, meta) {
  const safeName = String(name || '').trim();
  if (!safeName || safeName !== path.basename(safeName) || safeName === '.' || safeName === '..') {
    throw new Error('备份名称不合法');
  }
  const dir = path.join(root, safeName);
  if (!fs.existsSync(dir)) throw new Error('备份不存在，可能已被手动删除');
  const manifestPath = path.join(dir, 'backup.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (_) { throw new Error('备份清单损坏，无法确认内容'); }

  const allTargets = Array.isArray(targets) ? targets : [];
  const userTargets = allTargets.filter((t) => t && t.via !== 'electron' && t.scope !== 'session');
  const sessionPaths = allTargets
    .filter((t) => t && t.via === 'electron')
    .map((t) => path.resolve(t.path));

  // 恢复前先给当前状态留一份
  const safety = createBackup(root, userTargets, { reason: 'restore-pre' });

  const failures = [];
  let files = 0;
  for (const part of manifest.parts || []) {
    const key = part.scope;
    const src = path.join(dir, key);
    if (!fs.existsSync(src)) continue;
    const dst = part.from;
    const st = fs.statSync(src);

    if (part.kind === 'contents') {
      try { fs.mkdirSync(dst, { recursive: true }); }
      catch (err) { failures.push({ path: dst, message: err.message }); continue; }

      // 覆盖语义：先清空目标目录（跳过 Chromium 占用的会话目录）
      let names = [];
      try { names = fs.readdirSync(dst); }
      catch (err) { failures.push({ path: dst, message: err.message }); }
      for (const entry of names) {
        const full = path.join(dst, entry);
        if (coversSessionDir(full, sessionPaths)) continue;
        try { fs.rmSync(full, { recursive: true, force: true }); }
        catch (err) { failures.push({ path: full, message: err.message }); }
      }
      files += copyTree(src, dst, failures);
      continue;
    }

    /*
     * 单文件目标。
     * v1.1.1 起 manifest 里有 single 标记；v1.1.0 生成的旧备份没有这个字段，
     * 而当时唯一的文件型目标就是 storage-location.json，所以按 scope 兜底。
     */
    const single = part.single === true || part.scope === 'storage' || !st.isDirectory();
    if (single) {
      const fileName = path.basename(dst);
      const fileSrc = st.isDirectory() ? path.join(src, fileName) : src;
      if (!fs.existsSync(fileSrc)) continue;
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        // v1.1.0 的错误恢复会把这里建成一个同名目录，先清掉再写文件
        if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) {
          fs.rmSync(dst, { recursive: true, force: true });
        }
        fs.copyFileSync(fileSrc, dst);
        files += 1;
      } catch (err) {
        failures.push({ path: dst, message: err.message });
      }
    } else {
      try { fs.mkdirSync(dst, { recursive: true }); }
      catch (err) { failures.push({ path: dst, message: err.message }); continue; }
      files += copyTree(src, dst, failures);
    }
  }

  if (failures.length) {
    const sample = failures.slice(0, 3).map((f) => f.path).join('、');
    throw new Error(`恢复未完成：${failures.length} 个文件无法写入（${sample}）。`
      + `恢复前的状态已备份为 ${safety.name}，可以重试。`);
  }

  return { files, safetyBackup: safety.name, restoredFrom: safeName };
}

/**
 * 判断要删的路径是否「覆盖了某个会话目录」。
 *
 * 用在清数据目录的时候：万一用户把「数据保存位置」选成了 userData 根目录，
 * 清它的内容就又会撞上 Local Storage / Network 这些被 Chromium 锁住的目录，
 * 于是同一条 EPERM 事故换个入口复现。这里提前跳过。
 */
function coversSessionDir(targetPath, sessionPaths) {
  const t = path.resolve(targetPath);
  for (const sp of sessionPaths) {
    if (t === sp) return true;
    // t 是会话目录的祖先（删 t 等于连带删会话目录）
    if (sp.startsWith(t + path.sep)) return true;
  }
  return false;
}

/**
 * 执行清除（只负责文件系统部分）。
 *
 * 之所以只清 `via !== 'electron'` 的目标：Chromium 的 Local Storage / Network /
 * Partitions 在运行期被进程占用，rmSync 必定 EPERM。早期版本在这里抛错，
 * 结果「清除所有数据」一点就弹
 *   `无法删除 …\Local Storage: EPERM, Permission denied`
 * 整个功能等于不可用。会话数据改由调用方用 session.clearStorageData() 清。
 *
 * 单个目标删不掉不再中断整轮：收集到 failed 里一起返回，由调用方决定怎么报。
 * 这样「一个缓存文件被占用」不会把已经清掉的其它数据变成一场空。
 *
 * @param {Array} targets resetTargets() 的结果
 * @param {{skip?:string[]}} opts skip 里的 scope 不删（例如只清数据、保留登录态）
 * @returns {{removed:string[], failed:Array<{path:string,message:string}>, skipped:string[]}}
 */
function reset(targets, opts) {
  const skip = new Set((opts && opts.skip) || []);
  const removed = [];
  const failed = [];
  const skipped = [];

  // 会话目录的绝对路径：清任何目录内容时都要避开它们
  const sessionPaths = (Array.isArray(targets) ? targets : [])
    .filter((t) => t && t.via === 'electron')
    .map((t) => path.resolve(t.path));

  for (const t of targets) {
    if (!t) continue;
    // 会话数据交给 Electron，文件系统碰不得
    if (t.via === 'electron') { skipped.push(t.scope); continue; }
    if (skip.has(t.scope)) { skipped.push(t.scope); continue; }
    if (!fs.existsSync(t.path)) continue;

    if (t.kind === 'contents') {
      // 只清内容、保留目录本身
      let names = [];
      try { names = fs.readdirSync(t.path); }
      catch (err) { failed.push({ path: t.path, message: err.message }); continue; }
      for (const name of names) {
        const full = path.join(t.path, name);
        // 数据目录正好把 userData 圈进来时，跳过里面的会话目录
        if (coversSessionDir(full, sessionPaths)) continue;
        try {
          fs.rmSync(full, { recursive: true, force: true });
          removed.push(full);
        } catch (err) {
          failed.push({ path: full, message: err.message });
        }
      }
    } else {
      try {
        fs.rmSync(t.path, { recursive: true, force: true });
        removed.push(t.path);
      } catch (err) {
        failed.push({ path: t.path, message: err.message });
      }
    }
  }

  return { removed, failed, skipped };
}

/** 人类可读体积，与更新器里的口径保持一致 */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

module.exports = {
  BACKUP_DIR_NAME,
  backupRoot,
  resetTargets,
  fsTargets,
  sessionTargets,
  coversSessionDir,
  dirSize,
  copyTree,
  createBackup,
  listBackups,
  restoreBackup,
  reset,
  humanSize,
  stamp,
  uniqueName,
};
