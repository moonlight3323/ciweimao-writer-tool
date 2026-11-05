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

const FILE = 'vault.json';

function vaultFile() {
  return path.join(app.getPath('userData'), 'data', FILE);
}

/** 系统加密是否可用（Windows 上基本恒为 true，服务端/精简环境可能为 false） */
function available() {
  try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(vaultFile(), 'utf8'));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch (_) { /* 不存在或损坏都当成空 */ }
  return { version: 1, items: [] };
}

function write(data) {
  const f = vaultFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

/** 对外（渲染进程）可见的字段，永远不含密码 */
function redact(it) {
  return {
    id: it.id,
    label: it.label || it.username,
    mode: it.mode || 'account',
    username: it.username,
    updatedAt: it.updatedAt,
    lastUsedAt: it.lastUsedAt || '',
  };
}

function list() {
  return read().items
    .slice()
    .sort((a, b) => String(b.lastUsedAt || b.updatedAt || '').localeCompare(String(a.lastUsedAt || a.updatedAt || '')))
    .map(redact);
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
    write(data);
    return redact(found);
  }

  const rec = {
    id: crypto.randomUUID(),
    label: String(item.label || username).slice(0, 40),
    mode,
    username,
    secret: encrypt(password),
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

const api = { available, list, save, remove, reveal, markUsed, vaultFile };

if (typeof module === 'object' && module.exports) module.exports = api;
