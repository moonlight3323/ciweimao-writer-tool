'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const Spec = require('../src/shared/theme-spec');
const plugins = require('../src/main/plugins');

const root = path.join(__dirname, '..');
const manifest = {
  id: 'fixture-theme', name: '主题接口测试夹具', version: '1.0.0', permissions: ['ui.theme'],
  contributes: { themes: [
    { id: 'fixture-light', name: '测试浅色', base: 'light', variables: { '--bg': '#edf4ed' } },
    { id: 'fixture-dark', name: '测试深色', base: 'dark', variables: { '--bg': '#111c18' } },
  ] },
};
const sample = { ...manifest, enabled: true, invalid: false };
const load = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

test('主题切换立即保存时，偏好写入按顺序完成且使用独立快照', async () => {
  const writes = [];
  let release;
  const context = {
    setTimeout, clearTimeout,
    api: { data: {
      read: async () => ({}),
      write: (file, snapshot) => {
        writes.push(snapshot);
        return writes.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(true);
      },
    } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(load('src/renderer/prefs.js'), context);
  await context.Prefs.ready();
  context.Prefs.set('pluginTheme', { pluginId: 'fixture-theme', themeId: 'fixture-light' });
  const first = context.Prefs.flushNow();
  await Promise.resolve();
  context.Prefs.set('pluginTheme', { pluginId: 'fixture-theme', themeId: 'fixture-dark' });
  const second = context.Prefs.flushNow();
  await Promise.resolve();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].pluginTheme.themeId, 'fixture-light');
  release(true);
  await first;
  await second;
  assert.equal(writes[1].pluginTheme.themeId, 'fixture-dark');
});

function environment(prefs = {}, cache = {}) {
  const values = new Map(Object.entries(cache));
  const styles = new Map();
  const listeners = new Map();
  const saved = { ...prefs };
  const context = {
    console,
    document: {
      documentElement: {
        dataset: {},
        style: { setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key) },
        classList: { add() {}, remove() {} },
      },
      getElementById: () => null,
      addEventListener: (name, callback) => {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(callback);
      },
      dispatchEvent: event => { for (const callback of listeners.get(event.type) || []) callback(event); },
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    requestAnimationFrame: callback => callback(),
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    Prefs: { ready: async () => {}, get: (key, fallback) => saved[key] === undefined ? fallback : saved[key],
      set: (key, value) => { saved[key] = value; } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(load('src/shared/theme-spec.js'), context);
  vm.runInContext(load('src/renderer/theme-init.js'), context);
  const firstFrame = { dataset: { ...context.document.documentElement.dataset }, styles: new Map(styles) };
  vm.runInContext(load('src/renderer/dark-tone.js'), context);
  vm.runInContext(load('src/renderer/theme.js'), context);
  return { context, theme: context.Theme, styles, saved, cache: values, firstFrame };
}

test('主题包可以通过原有导入、列举和读取入口注册，旧插件继续可用', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-theme-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sampleRoot = path.join(temporary, 'fixture-source');
  fs.mkdirSync(sampleRoot);
  fs.writeFileSync(path.join(sampleRoot, 'manifest.json'), JSON.stringify(manifest));
  plugins.importFolder(temporary, sampleRoot);
  const listed = plugins.list(temporary).find(item => item.id === 'fixture-theme');
  assert.ok(listed.permissions.includes('ui.theme'));
  assert.equal(listed.contributes.themes.length, 2);
  assert.equal(plugins.get(temporary, listed.id).manifest.contributes.themes[0].variables['--bg'], '#edf4ed');
  plugins.importFolder(temporary, path.join(root, 'plugins-sample/chapter-tools'));
  assert.deepEqual(plugins.list(temporary).find(item => item.id !== listed.id).contributes.themes, []);
});

test('样式配方校验拒绝 CSS 注入、未知变量、重复 ID 和过多主题', () => {
  assert.throws(() => Spec.theme({ id: 'bad-theme', base: 'dark', variables: { '--bg': 'url(https://example.com)' } }));
  assert.throws(() => Spec.variables({ '--bg': '#000;display:none' }));
  assert.throws(() => Spec.variables({ '--writer-size': '0px' }));
  assert.throws(() => Spec.variables({ '--radius': '1000px' }));
  assert.throws(() => Spec.themes([manifest.contributes.themes[0], manifest.contributes.themes[0]]));
  assert.throws(() => Spec.themes(Array(9).fill(manifest.contributes.themes[0])));
  const values = new Map([['--bg', '#123456']]);
  const element = { style: {
    setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key),
  } };
  assert.throws(() => Spec.applyVariables(element, { '--bg': 'red;}' }));
  assert.equal(values.get('--bg'), '#123456', '先整体验证，失败不能留下半套样式');
});

test('主题选择保留原内置偏好，停用、移除或损坏时恢复并清理变量', async () => {
  const env = environment({ theme: 'pink', darkTone: 'blue' });
  await env.theme.boot();
  env.theme.registerPlugins([sample]);
  env.styles.set('--writer-size', '21px');
  env.theme.applyPlugin('fixture-theme', 'fixture-dark');
  assert.equal(env.context.document.documentElement.dataset.theme, 'dark');
  assert.equal(env.saved.theme, 'pink');
  assert.equal(env.styles.get('--bg'), '#111c18');
  assert.equal(env.theme.pluginThemes('fixture-theme').length, 2);
  env.theme.registerPlugins([{ ...sample, enabled: false }]);
  assert.equal(env.theme.current().pluginTheme, null);
  assert.equal(env.context.document.documentElement.dataset.theme, 'pink');
  assert.equal(env.styles.has('--bg'), false);
  assert.equal(env.styles.get('--writer-size'), '21px');
  assert.equal(env.saved.pluginTheme, null);
  assert.equal(env.cache.has(Spec.CACHE_KEY), false);
  env.theme.registerPlugins([sample]);
  env.theme.applyPlugin('fixture-theme', 'fixture-light');
  env.theme.registerPlugins([]);
  assert.equal(env.theme.current().pluginTheme, null);
});

test('主题在重启首帧和偏好恢复后保持一致，缓存丢失也能从数据目录恢复', async () => {
  const first = environment({ theme: 'light' });
  await first.theme.boot();
  first.theme.registerPlugins([sample]);
  first.theme.applyPlugin('fixture-theme', 'fixture-light');
  const second = environment(first.saved, Object.fromEntries(first.cache));
  assert.equal(second.firstFrame.styles.get('--bg'), '#edf4ed');
  await second.theme.boot();
  second.theme.registerPlugins([sample]);
  assert.deepEqual(plain(second.theme.current().pluginTheme), { pluginId: 'fixture-theme', themeId: 'fixture-light' });
  const withoutCache = environment(first.saved);
  await withoutCache.theme.boot();
  withoutCache.theme.registerPlugins([sample]);
  assert.equal(withoutCache.styles.get('--bg'), '#edf4ed');
  withoutCache.theme.set('dark');
  assert.equal(withoutCache.theme.current().pluginTheme, null);
  assert.equal(withoutCache.context.document.documentElement.dataset.theme, 'dark');
  assert.equal(withoutCache.styles.has('--bg'), false);
});

test('其他数据目录及损坏的主题缓存会回退，不能继续使用失效主题', async () => {
  const recipe = manifest.contributes.themes[0];
  const cache = { [Spec.CACHE_KEY]: JSON.stringify({ pluginId: 'fixture-theme', themeId: recipe.id, recipe }) };
  const env = environment({ theme: 'dark' }, cache);
  await env.theme.boot();
  env.theme.registerPlugins([sample]);
  assert.equal(env.theme.current().pluginTheme, null);
  assert.equal(env.context.document.documentElement.dataset.theme, 'dark');
  assert.equal(env.styles.has('--bg'), false);
  const corrupt = environment({}, {
    [Spec.CACHE_KEY]: JSON.stringify({ pluginId: 'fixture-theme', themeId: recipe.id,
      recipe: { ...recipe, variables: { '--bg': 'url(javascript:alert(1))' } } }),
  });
  assert.equal(corrupt.firstFrame.styles.size, 0);
});

test('插件 API 只允许前台且有权限的插件应用自身声明的主题', async () => {
  const env = environment({ theme: 'light' });
  await env.theme.boot();
  env.theme.registerPlugins([sample]);
  const app = load('src/renderer/app.js');
  const permission = app.slice(app.indexOf('function requirePluginPermission('), app.indexOf('async function handlePluginRequest('));
  const handler = app.slice(app.indexOf('async function handlePluginRequest('), app.indexOf("window.addEventListener('message'", app.indexOf('async function handlePluginRequest(')));
  env.context.pluginItems = [sample];
  vm.runInContext(permission + handler, env.context);
  const runtime = { kind: 'page', plugin: { ...sample, manifest: sample } };
  await assert.rejects(env.context.handlePluginRequest({ ...runtime, kind: 'background' }, 'theme.apply', { themeId: 'fixture-light' }), /主动/);
  await assert.rejects(env.context.handlePluginRequest({ ...runtime, plugin: { ...sample, manifest: { permissions: [] } } },
    'theme.apply', { themeId: 'fixture-light' }), /权限/);
  await assert.rejects(env.context.handlePluginRequest(runtime, 'theme.apply', { themeId: 'foreign-theme' }), /未安装/);
  await env.context.handlePluginRequest(runtime, 'theme.apply', { themeId: 'fixture-light' });
  assert.equal(env.styles.get('--bg'), '#edf4ed');
  const foreign = { kind: 'page', plugin: { id: 'other-plugin', manifest: { permissions: ['ui.theme'] } } };
  env.context.pluginItems.push({ id: 'other-plugin', enabled: true });
  await assert.rejects(env.context.handlePluginRequest(foreign, 'theme.reset'), /本插件/);
  await env.context.handlePluginRequest(runtime, 'theme.reset');
  assert.equal(env.styles.has('--bg'), false);
});
