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
 * 返回的是「绝对路径 + 是否整目录删除」的描述，调用方按 kind 处理。
 * 做成纯函数是为了能直接单测：改清除范围时必须能一眼看到全貌。
 *
 * @param {{dataDir:string, userData:string}} o
 */
function resetTargets(o) {
  const dataDir = path.resolve(o.dataDir);
  const userData = path.resolve(o.userData);
  const targets = [];

  // 1) 数据目录里的全部内容（不删 dataDir 本身，用户可能选了自己的文件夹，
  //    删掉文件夹会让用户以为丢了盘符上的目录）
  targets.push({ scope: 'data', kind: 'contents', path: dataDir });

  // 2) 密码本：vault.js 写死在 userData/data/vault.json
  const vaultDir = path.join(userData, 'data');
  if (path.resolve(vaultDir) !== dataDir) {
    targets.push({ scope: 'vault', kind: 'contents', path: vaultDir });
  }

  // 3) 登录态与界面存储。缺哪一个都正常（首次运行还没生成），删的时候忽略不存在
  for (const item of [
    'Partitions',            // persist:ciweimao 登录态分区
    'Local Storage',
    'Session Storage',
    'IndexedDB',
    'Network',               // Cookies 在新版 Electron 里位于 Network 下
    'Cookies',
    'Cookies-journal',
  ]) {
    targets.push({ scope: 'session', kind: 'path', path: path.join(userData, item) });
  }

  // 4) 「数据保存在哪里」这个选择本身。留着它，重启后不会重新问一遍，
  //    但重启后的数据会直接落回用户之前选的自定义目录 —— 那就不是「第一次拿到软件」了
  targets.push({
    scope: 'storage',
    kind: 'path',
    path: path.join(userData, 'storage-location.json'),
  });

  return targets;
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

/** 递归复制；目标已存在则合并覆盖 */
function copyTree(from, to) {
  let copied = 0;
  fs.mkdirSync(to, { recursive: true });
  let entries;
  try { entries = fs.readdirSync(from, { withFileTypes: true }); }
  catch (_) { return 0; }
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copied += copyTree(src, dst);
    } else if (entry.isSymbolicLink()) {
      // Chromium 的缓存里可能有符号链接，按文件复制即可
      try { fs.copyFileSync(src, dst); copied += 1; } catch (_) { /* 忽略锁住的缓存文件 */ }
    } else {
      try { fs.copyFileSync(src, dst); copied += 1; } catch (_) { /* 被占用的文件跳过 */ }
    }
  }
  return copied;
}

/** 把目标清单里的内容复制进备份目录，返回 { files, bytes, manifest } */
function createBackup(root, targets, meta) {
  const name = uniqueName(root, stamp());
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });

  const parts = [];
  let files = 0;
  for (const t of targets) {
    if (!fs.existsSync(t.path)) continue;
    // 备份里按 scope 分文件夹，恢复时不必再猜原始位置
    const dst = path.join(dir, t.scope);
    if (t.kind === 'contents') {
      files += copyTree(t.path, dst);
      parts.push({ scope: t.scope, kind: t.kind, from: t.path });
    } else {
      // 单个路径：目录就整棵复制，文件就复制文件
      const st = fs.statSync(t.path);
      if (st.isDirectory()) {
        files += copyTree(t.path, dst);
      } else {
        fs.mkdirSync(dst, { recursive: true });
        try { fs.copyFileSync(t.path, path.join(dst, path.basename(t.path))); files += 1; }
        catch (_) { /* 忽略 */ }
      }
      parts.push({ scope: t.scope, kind: t.kind, from: t.path });
    }
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
 */
function restoreBackup(root, name, targets, meta) {
  const dir = path.join(root, name);
  if (!fs.existsSync(dir)) throw new Error('备份不存在，可能已被手动删除');
  const manifestPath = path.join(dir, 'backup.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (_) { throw new Error('备份清单损坏，无法确认内容'); }

  // 恢复前先给当前状态留一份
  const safety = createBackup(root, targets, { reason: 'restore-pre' });

  let files = 0;
  for (const part of manifest.parts || []) {
    const key = part.scope;
    const src = path.join(dir, key);
    if (!fs.existsSync(src)) continue;
    // 空目录也算存在，但没内容就不用管
    const dst = part.from;
    if (part.kind === 'contents') {
      fs.mkdirSync(dst, { recursive: true });
      files += copyTree(src, dst);
    } else {
      // 路径型：备份里是「同名目录或文件」，还原回去
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        files += copyTree(src, dst);
      } else {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try { fs.copyFileSync(src, dst); files += 1; } catch (_) { /* 忽略 */ }
      }
    }
  }
  return { files, safetyBackup: safety.name, restoredFrom: name };
}

/**
 * 执行清除。
 * @param {Array} targets resetTargets() 的结果
 * @param {{skip?:string[]}} opts skip 里的 scope 不删（例如只清数据、保留登录态）
 */
function reset(targets, opts) {
  const skip = new Set((opts && opts.skip) || []);
  const removed = [];
  for (const t of targets) {
    if (skip.has(t.scope)) continue;
    if (!fs.existsSync(t.path)) continue;
    if (t.kind === 'contents') {
      // 只清内容、保留目录本身
      for (const name of fs.readdirSync(t.path)) {
        const full = path.join(t.path, name);
        try {
          fs.rmSync(full, { recursive: true, force: true });
          removed.push(full);
        } catch (err) {
          // 清不掉通常是文件被占用（另一个实例在跑）：报错而不是假装成功
          throw new Error(`无法删除 ${full}：${err.message}`);
        }
      }
    } else {
      try {
        fs.rmSync(t.path, { recursive: true, force: true });
        removed.push(t.path);
      } catch (err) {
        throw new Error(`无法删除 ${t.path}：${err.message}`);
      }
    }
  }
  return removed;
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
