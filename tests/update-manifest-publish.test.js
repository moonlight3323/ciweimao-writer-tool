'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildManifest } = require('../tools/publish-update-manifest');
const release = { version: '1.0.5', repo: 'moonlight3323/ciweimao-writer-tool', bytes: 1234,
  sha256: 'a'.repeat(64), date: '2026-11-07', items: ['内置健康助手'] };
test('更新清单链接、字节数、校验和匹配新包，保留历史并去重', () => {
  const result = buildManifest({ version: '1.0.4', changes: [{ version: '1.0.4' }, { version: '1.0.5', items: ['旧说明'] }] }, release);
  assert.equal(result.version, '1.0.5');
  assert.equal(result.sha256, release.sha256);
  assert.equal(result.size, release.bytes);
  // 下载地址必须走 CDN 而非 GitHub Release 直链：
  // 直链会 302 到 objects.githubusercontent.com，该域名国内连不上。
  assert.equal(result.url.length, 4, '应有三个 jsDelivr 域名 + raw 兜底');
  for (const u of result.url) {
    assert.equal(/releases\/download/.test(u), false, `不能再用 Release 直链：${u}`);
    assert.match(u, /ciweimao-writer-tool-v1\.0\.5-app\.zip$/);
    assert.match(u, /update\/assets\//, '更新包要来自仓库里的 update/assets');
  }
  assert.match(result.url[0], /^https:\/\/cdn\.jsdelivr\.net\/gh\//);
  assert.match(result.url[3], /^https:\/\/raw\.githubusercontent\.com\//);
  assert.deepEqual(result.changes.map(entry => entry.version), ['1.0.5', '1.0.4']);
  assert.deepEqual(result.changes[0].items, release.items);
});
test('更新清单禁止倒退到旧版，缺少真实校验数据时不能发布', () => {
  assert.throws(() => buildManifest({ version: '1.0.6' }, release), /禁止.*降级/);
  assert.throws(() => buildManifest({}, { ...release, sha256: '' }), /校验数据无效/);
  assert.throws(() => buildManifest({}, { ...release, bytes: 0 }), /校验数据无效/);
});
