'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const plugins = require('../src/main/plugins');
const assets = require('../src/main/theme-assets');
const Spec = require('../src/shared/theme-spec');
const Skin = require('../src/shared/theme-skin');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFj8AAAAASUVORK5CYII=', 'base64');
const URL = 'data:image/png;base64,' + PNG.toString('base64');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-skin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), data = path.join(dir, 'data');
  fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
  const manifest = { id: 'test-skin', permissions: ['ui.theme'], contributes: { themes: [
    { id: 'skin-light', base: 'light', variables: { '--bg': '#fafafa' }, background: { image: 'assets/paper.png', opacity: 0.7 },
      branding: { icon: 'assets/paper.png' }, styles: { panel: { background: '#ffffffcc', borderRadius: 20 } } },
    { id: 'skin-dark', base: 'dark', variables: { '--bg': '#111111' }, background: { image: 'assets/paper.png', opacity: 0.5 } },
  ] } };
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(source, 'assets/paper.png'), PNG);
  fs.writeFileSync(path.join(source, 'LICENSE'), 'Test attribution');
  fs.writeFileSync(path.join(source, 'NOTICE'), 'Test notice');
  return { dir, source, data, manifest };
}
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const text = Buffer.from(name), body = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(text.length, 26);
    local.push(header, text, body);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 6);
    index.writeUInt32LE(body.length, 20); index.writeUInt32LE(body.length, 24); index.writeUInt16LE(text.length, 28); index.writeUInt32LE(offset, 42);
    central.push(index, text); offset += header.length + text.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
test('带图片的目录和 ZIP 插件保留资源与署名，并解析为本地图片数据', t => {
  const f = fixture(t);
  const archive = path.join(f.dir, 'skin.zip');
  fs.writeFileSync(archive, zip({ 'pack/manifest.json': JSON.stringify(f.manifest), 'pack/assets/paper.png': PNG,
    'pack/LICENSE': 'Test attribution', 'pack/NOTICE': 'Test notice', 'pack/assets/../../escape.png': PNG }));
  plugins.importZip(f.data, archive);
  const listed = plugins.list(f.data)[0];
  assert.equal(listed.invalid, false);
  assert.equal(listed.contributes.themes[0].background.image, URL);
  assert.equal(listed.contributes.themes[0].branding.icon, URL);
  assert.equal(fs.readFileSync(path.join(f.data, 'plugins/test-skin/LICENSE'), 'utf8'), 'Test attribution');
  assert.equal(fs.existsSync(path.join(f.data, 'plugins/escape.png')), false);
  assert.equal(plugins.get(f.data, 'test-skin').manifest.contributes.themes[0].background.image, URL);
});
test('图片不能越界、伪造类型，缺少资源时导入回滚', t => {
  const f = fixture(t);
  for (const value of ['../private.png', 'assets/../secret.png', 'file:///secret.png', 'https://example.com/a.png', 'assets/script.svg']) assert.throws(() => Spec.image(value));
  assert.throws(() => assets.resolveImage(f.source, 'data:image/png;base64,' + Buffer.from('<html>bad</html>').toString('base64')));
  assert.throws(() => assets.resolveImage(f.source, 'data:image/gif;base64,' + PNG.toString('base64')));
  fs.unlinkSync(path.join(f.source, 'assets/paper.png'));
  assert.throws(() => plugins.importFolder(f.data, f.source));
  assert.equal(fs.existsSync(path.join(f.data, 'plugins/test-skin')), false);
});
test('调色板保存与恢复按主题隔离，拒绝无权限、停用及无效图片，保持原有设置', t => {
  const f = fixture(t); plugins.importFolder(f.data, f.source);
  plugins.configureTheme(f.data, 'test-skin', 'skin-light', { background: { image: URL, opacity: 0.85 },
    branding: { icon: null }, styles: { panel: { borderRadius: 24 } } });
  let recipes = plugins.list(f.data)[0].contributes.themes;
  assert.equal(recipes[0].background.opacity, 0.85); assert.equal(recipes[0].styles.panel.background, '#ffffffcc');
  assert.equal(recipes[0].styles.panel.borderRadius, 24); assert.equal(recipes[1].background.opacity, 0.5);
  assert.equal(recipes[0].branding.icon, null);
  assert.throws(() => plugins.configureTheme(f.data, 'test-skin', 'skin-light', { branding: { icon: 'data:image/png;base64,PGh0bWw+' } }));
  assert.equal(plugins.list(f.data)[0].contributes.themes[0].branding.icon, null);
  assert.throws(() => plugins.configureTheme(f.data, 'test-skin', 'skin-light', { background: { image: 'data:image/png;base64,PGh0bWw+' } }));
  assert.equal(plugins.list(f.data)[0].contributes.themes[0].background.opacity, 0.85);
  assert.throws(() => plugins.configureTheme(f.data, 'test-skin', 'foreign-theme', {}));
  plugins.setEnabled(f.data, 'test-skin', false);
  assert.throws(() => plugins.configureTheme(f.data, 'test-skin', 'skin-light', {}), /停用/);
  plugins.setEnabled(f.data, 'test-skin', true);
  plugins.configureTheme(f.data, 'test-skin', 'skin-light', null);
  assert.equal(plugins.list(f.data)[0].contributes.themes[0].background.opacity, 0.7);
  assert.equal(plugins.list(f.data)[0].contributes.themes[0].branding.icon, URL);
  f.manifest.permissions = []; fs.writeFileSync(path.join(f.data, 'plugins/test-skin/manifest.json'), JSON.stringify(f.manifest));
  assert.throws(() => plugins.configureTheme(f.data, 'test-skin', 'skin-light', {}), /权限/);
});
test('组件换肤只编译支持的视觉属性，拒绝脚本、外部 URL 和隐藏控件的规则', () => {
  const recipe = { id: 'skin-test', base: 'light', variables: { '--bg': '#ffffff' },
    styles: { primaryButton: { borderRadius: 12, gradient: { from: '#aabbcc', to: '#ccbbaa', angle: 125 } } } };
  assert.match(Skin.css(recipe), /\.btn\.primary/); assert.match(Skin.css(recipe), /linear-gradient\(125deg/);
  assert.throws(() => Spec.appearance({ styles: { button: { display: 'none' } } }));
  assert.throws(() => Spec.appearance({ styles: { '#closeDialog': { color: '#ffffff' } } }));
  assert.throws(() => Spec.appearance({ styles: { button: { background: 'url(https://example.com)' } } }));
  assert.throws(() => Spec.appearance({ decorations: [{ id: 'bad-art', image: URL, opacity: 2 }] }));
  assert.throws(() => Spec.appearance({ effects: { bubbles: 'yes' } }));
  assert.throws(() => Spec.appearance({ background: { blur: 999 } }));
});
