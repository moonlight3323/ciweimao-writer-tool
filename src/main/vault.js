'use strict';

/**
 * 本地密码本
 *
 * 安全设计（写之前先定规则）：
 * 1. 密码只用 Electron 的 safeStorage 加密后落盘 —— Windows 上底层是 DPAPI，
 *    密钥由当前 Windows 账户派生。把这个 json 文件拷到别的机器/别的账户，
 *    解不开，等于一串乱码。
 * 2. **解密只发生在主进程**，而且只为「往登录页里填」这一件事服务：
 *    密码从磁盘 → 主进程内存 → 平台页面，全程不回到应用界面（渲染进程）。
 *    界面拿到的永远是剪掉密码的条目（list 只返回 id/账号/备注）。
 * 3. 只有当前页面确实是 author.ciweimao.com/login 才允许填入或抓取，
 *    防止把凭据填到别的站点的输入框里。
 * 4. 账号名不加密（界面要显示它，加密了也没有意义），密码一定是密文。
 */

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vaultOrder = require('./vault-order');

const FILE = 'vault.json';

function vaultFile() {
  return path.join(app.getPath('userData'), 'data', FILE);
}

/** 系统加密是否可用（Windows 上基本恒为 true，服务端/精简环境可能为 false） */
function available() {
  try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}

/**
 * 读取密码本。
 *
 * 只有「文件不存在」才能当成空库。其他读取错误（EBUSY / EACCES / EPERM，
 * 常见于杀软或同步盘短暂占用）必须往上抛：save() 是基于 read() 的结果
 * 写回整份文件的，把读失败当成空库会让用户新存一条密码时，
 * **静默覆盖掉之前所有记录**。
 *
 * JSON 损坏时先把坏文件改名留档，再返回空库 —— 这样至少还能继续用，
 * 坏文件也没有被覆盖，用户仍有手工恢复的机会。
 */
function read() {
  let text;
  try {
    text = fs.readFileSync(vaultFile(), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { version: 1, items: [] };
    throw new Error(`密码本读取失败（${(err && err.code) || '未知错误'}），为避免覆盖原有记录已中止`);
  }
  try {
    const raw = JSON.parse(text);
    if (raw && Array.isArray(raw.items)) return raw;
  } catch (_) { /* 落到下面按损坏处理 */ }

  const backup = `${vaultFile()}.corrupt-${Date.now()}`;
  try { fs.renameSync(vaultFile(), backup); }
  catch (err) {
    throw new Error(`密码本文件已损坏且无法备份（${(err && err.code) || '未知错误'}），已中止以免覆盖`);
  }
  return { version: 1, items: [] };
}

function write(data) {
  const f = vaultFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

/**
 * 对外（渲染进程）可见的字段，**永远不含密码**。
 * 实现放在 vault-order.js：那边不依赖 electron，可以直接跑测试。
 */
const redact = vaultOrder.redact;

/**
 * 排序规则：先按作者名分组，组内按最近使用。见 vault-order.js 的注释。
 */
function list() {
  return vaultOrder.sortItems(read().items).map(redact);
}

function encrypt(plain) {
  if (!available()) {
    throw new Error('系统加密不可用（safeStorage 未就绪），出于安全考虑不保存密码');
  }
  return safeStorage.encryptString(String(plain)).toString('base64');
}

function decrypt(b64) {
  if (!available()) throw new Error('系统加密不可用，无法读取密码');
  const buf = Buffer.from(String(b64 || ''), 'base64');
  return safeStorage.decryptString(buf);
}

/**
 * 新增或更新一条。同一「登录方式 + 账号」视为同一条，覆盖旧密码。
 * @param {{mode:string, username:string, password:string, label?:string}} item
 */
function save(item) {
  const mode = item.mode === 'email' ? 'email' : 'account';
  const username = String(item.username || '').trim();
  const password = String(item.password || '');
  if (!username) throw new Error('账号不能为空');
  if (!password) throw new Error('密码不能为空');

  const data = read();
  const now = new Date().toISOString();
  const found = data.items.find((x) => x.mode === mode && x.username === username);

  if (found) {
    found.secret = encrypt(password);
    found.updatedAt = now;
    found.lastUsedAt = now;
    if (item.label) found.label = String(item.label).slice(0, 40);
    if (item.authorName) found.authorName = String(item.authorName).slice(0, 40);
    write(data);
    return redact(found);
  }

  const rec = {
    id: crypto.randomUUID(),
    label: String(item.label || username).slice(0, 40),
    mode,
    username,
    secret: encrypt(password),
    // 保存时通常还没有作者名（登录前），留空等登录成功后再绑
    authorName: String(item.authorName || '').slice(0, 40),
    updatedAt: now,
    lastUsedAt: now,
  };
  data.items.push(rec);
  write(data);
  return redact(rec);
}

function remove(id) {
  const data = read();
  const before = data.items.length;
  data.items = data.items.filter((x) => x.id !== id);
  if (data.items.length === before) return false;
  write(data);
  return true;
}

/**
 * 取出明文凭据。**仅供主进程内部使用**，不要通过 IPC 返回给渲染进程。
 */
function reveal(id) {
  const rec = read().items.find((x) => x.id === id);
  if (!rec) return null;
  return {
    id: rec.id,
    mode: rec.mode || 'account',
    username: rec.username,
    password: decrypt(rec.secret),
  };
}

function markUsed(id) {
  const data = read();
  const rec = data.items.find((x) => x.id === id);
  if (!rec) return;
  rec.lastUsedAt = new Date().toISOString();
  write(data);
}

/**
 * 绑定作者名：这条账号登录过之后，把后台里的作者名记下来。
 *
 * 为什么要单独一个动作而不是塞进 save()：作者名只有登录成功之后才拿得到，
 * 而 save() 发生在登录之前（用户在登录页填好就存了）。
 *
 * @returns {object|null} 更新后的对外字段；记录不存在返回 null
 */
function bindAuthor(id, authorName) {
  const name = String(authorName || '').trim().slice(0, 40);
  if (!name) return null;
  const data = read();
  const rec = data.items.find((x) => x.id === id);
  if (!rec) return null;
  if (rec.authorName === name) return redact(rec);
  rec.authorName = name;
  rec.authorBoundAt = new Date().toISOString();
  write(data);
  return redact(rec);
}

/**
 * 按作者名找记录：用于「登录后自动认领」和界面上的快速选择。
 * @returns {object|null} 对外字段（不含密码）
 */
function findByAuthor(authorName) {
  const name = String(authorName || '').trim();
  if (!name) return null;
  const rec = read().items.find((x) => String(x.authorName || '').trim() === name);
  return rec ? redact(rec) : null;
}

/**
 * 取最近一次填入的记录 id。
 *
 * 登录成功后要把它绑定作者名，但那一刻页面上可能同时开着好几个账号的 cookie，
 * 唯一可靠的线索就是「刚刚用哪条记录填的」。
 */
function lastFilledId() {
  const items = read().items;
  let best = null;
  for (const it of items) {
    if (!it.lastUsedAt) continue;
    if (!best || String(it.lastUsedAt) > String(best.lastUsedAt)) best = it;
  }
  return best ? best.id : '';
}

const api = {
  available, list, save, remove, reveal, markUsed, vaultFile,
  bindAuthor, findByAuthor, lastFilledId,
};

if (typeof module === 'object' && module.exports) module.exports = api;
