'use strict';

const fs = require('fs');
const path = require('path');
const Spec = require('../shared/theme-spec');
const ASSET = /^assets\/[A-Za-z0-9][A-Za-z0-9_-]*\.(png|jpe?g|webp|gif)$/i;

function mime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return 'gif';
  throw new Error('主题图片内容无效，仅支持 PNG、JPEG、WebP、GIF');
}

function resolveImage(folder, value) {
  if (value === null) return null;
  Spec.image(value);
  let buffer;
  let expected;
  if (ASSET.test(value)) {
    const file = path.join(folder, value);
    const parent = fs.realpathSync(folder) + path.sep;
    const resolved = fs.realpathSync(file);
    if (!resolved.startsWith(parent)) throw new Error('主题图片超出插件目录');
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > Spec.IMAGE_LIMIT) throw new Error('主题图片不能超过 8MB');
    buffer = fs.readFileSync(resolved);
    expected = path.extname(value).slice(1).toLowerCase().replace('jpg', 'jpeg');
  } else {
    const comma = value.indexOf(',');
    expected = value.slice(11, value.indexOf(';'));
    buffer = Buffer.from(value.slice(comma + 1), 'base64');
    if (buffer.length > Spec.IMAGE_LIMIT) throw new Error('主题图片不能超过 8MB');
  }
  if (mime(buffer) !== expected) throw new Error('主题图片格式与文件类型不一致');
  return 'data:image/' + expected + ';base64,' + buffer.toString('base64');
}

function settingsPath(dataDir, id) {
  return path.join(dataDir, 'plugin-theme-settings', id + '.json');
}

function settings(dataDir, id) {
  try {
    const file = settingsPath(dataDir, id);
    if (fs.statSync(file).size > 24 * 1024 * 1024) return {};
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_) { return {}; }
}

function hydrate(folder, recipes, overrides = {}) {
  return recipes.map(base => {
    let recipe = base;
    try { recipe = Spec.merge(base, overrides[base.id]); } catch (_) { /* 损坏的个人设置回到主题默认值 */ }
    const resolved = { ...recipe };
    if (recipe.background && recipe.background.image) {
      resolved.background = { ...recipe.background, image: resolveImage(folder, recipe.background.image) };
    }
    if (recipe.branding?.icon) resolved.branding = { ...recipe.branding, icon: resolveImage(folder, recipe.branding.icon) };
    if (recipe.decorations) resolved.decorations = recipe.decorations.map(item => ({
      ...item, image: item.image ? resolveImage(folder, item.image) : null,
    }));
    return resolved;
  });
}

function configure(dataDir, folder, manifest, themeId, options) {
  const base = manifest.contributes.themes.find(item => item.id === themeId);
  if (!base) throw new Error('只能设置本插件声明的主题');
  const saved = settings(dataDir, manifest.id);
  if (options === null) delete saved[themeId];
  else {
    const clean = Spec.appearance(options);
    let previous = {};
    try { previous = Spec.appearance(saved[themeId] || {}); } catch (_) { /* restore a damaged override */ }
    const next = { ...previous, ...clean };
    for (const key of ['variables', 'background', 'branding', 'effects']) {
      if (previous[key] || clean[key]) next[key] = { ...previous[key], ...clean[key] };
    }
    if (previous.styles || clean.styles) {
      next.styles = { ...previous.styles };
      for (const [slot, style] of Object.entries(clean.styles || {})) next.styles[slot] = { ...next.styles[slot], ...style };
    }
    saved[themeId] = next;
    // Resolve before saving: invalid files or spoofed image data must not replace a working setting.
    hydrate(folder, [base], { [themeId]: next });
  }
  const content = JSON.stringify(saved);
  if (Buffer.byteLength(content) > 24 * 1024 * 1024) throw new Error('主题设置中的图片总量过大，请使用较小的图片');
  const file = settingsPath(dataDir, manifest.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', content, 'utf8');
  fs.renameSync(file + '.tmp', file);
  return true;
}

module.exports = { ASSET, mime, resolveImage, settings, hydrate, configure };
