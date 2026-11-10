'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MAX_FILE = 512 * 1024;
const ALLOWED_FILES = new Set(['manifest.json', 'page.html', 'main.js', 'background.js', 'style.css', 'README.md']);

function pluginsDir(dataDir) {
  const dir = path.join(dataDir, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath(dataDir) {
  return path.join(dataDir, 'plugins-state.json');
}

function storageDir(dataDir) {
  const dir = path.join(dataDir, 'plugin-storage');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function safeId(id) {
  const value = String(id || '').toLowerCase();
  if (!ID_RE.test(value)) throw new Error('插件 ID 只能使用小写字母、数字、横线和下划线');
  return value;
}

function safeKey(key) {
  const value = String(key || '');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(value)) throw new Error('插件存储键不合法');
  return value;
}

function readManifest(folder) {
  const manifest = readJson(path.join(folder, 'manifest.json'), null);
  if (!manifest || typeof manifest !== 'object') throw new Error('缺少有效的 manifest.json');
  const id = safeId(manifest.id);
  return {
    id,
    name: String(manifest.name || id).slice(0, 80),
    version: String(manifest.version || '1.0.0').slice(0, 30),
    author: String(manifest.author || '').slice(0, 80),
    description: String(manifest.description || '').slice(0, 240),
    permissions: Array.isArray(manifest.permissions)
      ? [...new Set(manifest.permissions.map(String).filter((p) => [
        'editor.read', 'editor.write', 'stats.read', 'stats.author', 'ui.editorStat',
      ].includes(p)))]
      : [],
    contributes: {
      navigation: manifest.contributes && manifest.contributes.navigation
        ? { title: String(manifest.contributes.navigation.title || manifest.name || id).slice(0, 20) }
        : null,
      editorStat: !!(manifest.contributes && manifest.contributes.editorStat),
      // 页面原生悬浮球：由插件 iframe 自己绘制，宿主只负责让 iframe 常驻。
      floatingWidget: !!(manifest.contributes && manifest.contributes.floatingWidget),
      // 码字台工具栏入口。宿主目前只给内置「摸鱼码字」接了具体动作，
      // 其它插件声明了也不会长按钮 —— 免得点下去没有任何反应。
      editorButton: manifest.contributes && manifest.contributes.editorButton
        ? {
          label: String(manifest.contributes.editorButton.label || manifest.name || id).slice(0, 12),
          title: String(manifest.contributes.editorButton.title || '').slice(0, 120),
        }
        : null,
    },
  };
}

function readState(dataDir) {
  const state = readJson(statePath(dataDir), null);
  return state && typeof state === 'object' ? state : { enabled: {} };
}

function list(dataDir) {
  const root = pluginsDir(dataDir);
  const state = readState(dataDir);
  // 内置功能的注册表：installBundled 每次启动都会写，用它标出「自带」的那些。
  // 界面上内置功能只允许停用、不允许删除 —— 删了没有重新安装的入口。
  const bundled = readJson(path.join(dataDir, 'bundled-plugins.json'), {});
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // 导入 zip 时用的 .import-XXXX 临时目录；进程中途退出会留下它，
    // 不能把它当成一个「缺少有效 manifest」的坏插件永久显示在功能中心。
    if (entry.name.startsWith('.')) continue;
    try {
      const folder = path.join(root, entry.name);
      const manifest = readManifest(folder);
      if (manifest.id !== entry.name.toLowerCase()) {
        result.push({
          id: entry.name,
          name: entry.name,
          version: '',
          description: '插件目录名必须与 manifest.json 中的 id 一致',
          enabled: false,
          invalid: true,
          builtin: false,
        });
        continue;
      }
      result.push({
        ...manifest,
        enabled: state.enabled[manifest.id] !== false,
        invalid: false,
        builtin: Object.prototype.hasOwnProperty.call(bundled, manifest.id),
      });
    } catch (err) {
      result.push({
        id: entry.name,
        name: entry.name,
        version: '',
        description: String((err && err.message) || err),
        enabled: false,
        invalid: true,
        builtin: Object.prototype.hasOwnProperty.call(bundled, entry.name),
      });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function readText(file, fallback) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE) throw new Error(`${path.basename(file)} 超过 512KB`);
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (fallback != null && err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function get(dataDir, id) {
  const pluginId = safeId(id);
  const folder = path.join(pluginsDir(dataDir), pluginId);
  const manifest = readManifest(folder);
  const state = readState(dataDir);
  if (state.enabled[pluginId] === false) throw new Error('插件已停用');
  return {
    manifest,
    page: readText(path.join(folder, 'page.html'), '<div id="app"></div>'),
    script: readText(path.join(folder, 'main.js'), ''),
    background: readText(path.join(folder, 'background.js'), ''),
    style: readText(path.join(folder, 'style.css'), ''),
  };
}

function setEnabled(dataDir, id, enabled) {
  const pluginId = safeId(id);
  const state = readState(dataDir);
  if (!state.enabled) state.enabled = {};
  state.enabled[pluginId] = !!enabled;
  writeJson(statePath(dataDir), state);
  return !!enabled;
}

function copyPluginFolder(source, target) {
  const entries = fs.readdirSync(source, { withFileTypes: true });
  fs.mkdirSync(target, { recursive: true });
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !ALLOWED_FILES.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const stat = fs.statSync(from);
    total += stat.size;
    if (stat.size > MAX_FILE || total > 2 * 1024 * 1024) throw new Error('插件文件过大');
    fs.copyFileSync(from, path.join(target, entry.name));
  }
}

/**
 * 判断某个内置插件是否需要（重新）安装。
 *
 * **只看版本号是不够的**，这是踩过的坑：
 * 数据目录被清掉（或用户手动删了 plugins 里的文件夹）之后，`bundled-plugins.json`
 * 登记表可能还在（例如从旧备份恢复回来），于是 `registry[id] === manifest.version`
 * 成立、不再复制，可磁盘上其实什么都没有 —— 功能中心变空，
 * 而内置功能又没有「重新安装」入口，用户只能重装整个软件。
 *
 * 判据改成三条任一成立就装：
 *   1. 登记表里没有这个 id（或版本不同）
 *   2. 目标目录里读不出有效的 manifest.json（目录没了 / 文件残缺）
 *   3. 目标目录里的版本与内置版本不一致（软件升级带来新版本插件）
 *
 * @param {string} target 安装目标目录
 * @param {object} manifest 内置插件清单（readManifest 的归一化结果）
 * @param {object} registry 登记表 { id: version }
 */
function needsBundledInstall(target, manifest, registry) {
  if (!registry || registry[manifest.id] !== manifest.version) return true;
  try {
    const installed = readManifest(target);
    return installed.version !== manifest.version;
  } catch (_) {
    // 目录不存在、manifest.json 缺失或损坏 —— 必须重装
    return true;
  }
}

function installBundled(dataDir, bundledRoot) {
  if (!bundledRoot || !fs.existsSync(bundledRoot)) return [];
  const registryPath = path.join(dataDir, 'bundled-plugins.json');
  const registry = readJson(registryPath, {});
  let changed = false;
  const installed = [];
  for (const entry of fs.readdirSync(bundledRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(bundledRoot, entry.name);
    try {
      const manifest = readManifest(source);
      const target = path.join(pluginsDir(dataDir), manifest.id);
      if (!needsBundledInstall(target, manifest, registry)) continue;

      // 目标目录可能是残缺的（登记表说装过、文件却没了）。
      // 先清掉再复制，避免旧残留文件跟新版本混在一起。
      // 插件自己的数据在 plugin-storage 里，删目录不会丢。
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* 删不掉就覆盖 */ }

      copyPluginFolder(source, target);
      installed.push(manifest.id);
      registry[manifest.id] = manifest.version;
      changed = true;
    } catch (err) {
      // 单个内置插件损坏不能影响主程序启动，但要留痕 ——
      // 否则用户只看到「功能中心是空的」，完全没线索。
      console.error(`内置功能 ${entry.name} 安装失败：`, (err && err.message) || err);
    }
  }
  if (changed) writeJson(registryPath, registry);
  return installed;
}

function importFolder(dataDir, source) {
  const manifest = readManifest(source);
  const target = path.join(pluginsDir(dataDir), manifest.id);
  if (fs.existsSync(target)) throw new Error(`插件 ${manifest.id} 已存在，请先删除旧版本`);
  try {
    copyPluginFolder(source, target);
    readManifest(target);
  } catch (err) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw err;
  }
  setEnabled(dataDir, manifest.id, true);
  return manifest;
}

function findZipEnd(buffer) {
  if (buffer.length < 22) throw new Error('不是有效的 ZIP 压缩包');
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('不是有效的 ZIP 压缩包');
}

function readZipEntries(file) {
  const stat = fs.statSync(file);
  if (stat.size > 10 * 1024 * 1024) throw new Error('插件压缩包不能超过 10MB');
  const buffer = fs.readFileSync(file);
  const end = findZipEnd(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (count > 200 || centralOffset >= buffer.length) throw new Error('ZIP 目录异常');
  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > buffer.length) throw new Error('ZIP 文件名损坏');
    const name = buffer.subarray(cursor + 46, nameEnd).toString('utf8').replace(/\\/g, '/');
    if ((flags & 1) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('不支持加密或 ZIP64 插件包');
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor = nameEnd + extraLength + commentLength;
  }
  return { buffer, entries };
}

function inflateZipEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`ZIP 条目损坏：${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length || entry.uncompressedSize > MAX_FILE) throw new Error(`插件文件过大：${entry.name}`);
  const compressed = buffer.subarray(start, end);
  let output;
  if (entry.method === 0) output = Buffer.from(compressed);
  else if (entry.method === 8) output = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_FILE });
  else throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`);
  if (output.length !== entry.uncompressedSize) throw new Error(`ZIP 条目长度不一致：${entry.name}`);
  return output;
}

function importZip(dataDir, file) {
  const { buffer, entries } = readZipEntries(file);
  const manifests = entries.filter((entry) => !entry.name.endsWith('/')
    && (entry.name === 'manifest.json' || entry.name.endsWith('/manifest.json'))
    && !entry.name.startsWith('__MACOSX/'));
  if (manifests.length !== 1) throw new Error('压缩包内必须且只能有一个 manifest.json');
  const manifestName = manifests[0].name;
  const prefix = manifestName.slice(0, manifestName.length - 'manifest.json'.length);
  const selected = entries.filter((entry) => {
    if (entry.name.endsWith('/') || !entry.name.startsWith(prefix)) return false;
    const relative = entry.name.slice(prefix.length);
    return !relative.includes('/') && ALLOWED_FILES.has(relative);
  });
  if (!selected.some((entry) => entry.name.slice(prefix.length) === 'manifest.json')) {
    throw new Error('压缩包内没有可读取的 manifest.json');
  }
  const temp = fs.mkdtempSync(path.join(pluginsDir(dataDir), '.import-'));
  try {
    let total = 0;
    for (const entry of selected) {
      const relative = entry.name.slice(prefix.length);
      const content = inflateZipEntry(buffer, entry);
      total += content.length;
      if (total > 2 * 1024 * 1024) throw new Error('插件解压后不能超过 2MB');
      fs.writeFileSync(path.join(temp, relative), content);
    }
    return importFolder(dataDir, temp);
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

/**
 * 删除插件目录。
 *
 * 内置功能不允许删除：它们没有「重新安装」的入口，删掉就只能重装整个软件。
 * 想让它不起作用请用停用（setEnabled）。这里直接抛错，让界面能显示原因。
 */
function remove(dataDir, id) {
  const pluginId = safeId(id);
  const bundled = readJson(path.join(dataDir, 'bundled-plugins.json'), {});
  if (Object.prototype.hasOwnProperty.call(bundled, pluginId)) {
    throw new Error('内置功能不能删除，只能停用');
  }
  const target = path.join(pluginsDir(dataDir), pluginId);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function uniqueTemplateId(dataDir) {
  const root = pluginsDir(dataDir);
  let id = 'my-writing-plugin';
  let n = 2;
  while (fs.existsSync(path.join(root, id))) id = `my-writing-plugin-${n++}`;
  return id;
}

function createTemplate(dataDir) {
  const id = uniqueTemplateId(dataDir);
  const folder = path.join(pluginsDir(dataDir), id);
  fs.mkdirSync(folder, { recursive: true });
  writeJson(path.join(folder, 'manifest.json'), {
    id,
    name: '我的写作插件',
    version: '1.0.0',
    author: '请填写作者名',
    description: '这是一个可自由修改的插件模板。',
    permissions: ['editor.read'],
  });
  fs.writeFileSync(path.join(folder, 'page.html'), [
    '<section class="card">',
    '  <h1>我的写作插件</h1>',
    '  <p id="status">点击按钮读取当前章节信息。</p>',
    '  <button id="inspect">读取当前章节</button>',
    '</section>',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(folder, 'style.css'), [
    'body { margin: 0; padding: 28px; font: 14px/1.7 system-ui, sans-serif; background: #f7f5ef; color: #2b2620; }',
    '.card { max-width: 680px; margin: 0 auto; padding: 24px; background: white; border: 1px solid #e9e1d2; border-radius: 12px; }',
    'button { padding: 8px 14px; border: 0; border-radius: 7px; background: #f9bf03; cursor: pointer; }',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(folder, 'main.js'), [
    "document.querySelector('#inspect').addEventListener('click', async () => {",
    "  const status = document.querySelector('#status');",
    '  try {',
    '    const chapter = await PluginAPI.editor.getContext();',
    "    status.textContent = chapter ? `《${chapter.bookName}》· ${chapter.title} · ${chapter.words} 字` : '请先在创作中心打开一本书。';",
    '  } catch (error) {',
    '    status.textContent = error.message;',
    '  }',
    '});',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(folder, 'README.md'), '修改 manifest.json、page.html、style.css 和 main.js 后，在功能中心点击“重新加载”。\n', 'utf8');
  setEnabled(dataDir, id, true);
  return { id, folder };
}

function storageFile(dataDir, id) {
  return path.join(storageDir(dataDir), safeId(id) + '.json');
}

function storageGet(dataDir, id, key) {
  const data = readJson(storageFile(dataDir, id), {});
  return data[safeKey(key)];
}

function storageSet(dataDir, id, key, value) {
  const json = JSON.stringify(value);
  // JSON.stringify(undefined / function / symbol) 返回 undefined，
  // 直接交给 Buffer.byteLength 会抛一个和「存储」毫不相干的 TypeError。
  if (json === undefined) throw new Error('插件存储值必须是可序列化的 JSON 数据');
  if (Buffer.byteLength(json, 'utf8') > 256 * 1024) throw new Error('单项插件数据不能超过 256KB');
  const file = storageFile(dataDir, id);
  const data = readJson(file, {});
  data[safeKey(key)] = value;
  writeJson(file, data);
  return true;
}

module.exports = {
  pluginsDir,
  needsBundledInstall,
  installBundled,
  list,
  get,
  setEnabled,
  importFolder,
  importZip,
  remove,
  createTemplate,
  storageGet,
  storageSet,
};
