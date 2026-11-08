'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { compareVersions } = require('../src/main/updater');

/**
 * 更新包的下载地址。
 *
 * 不能再给 GitHub Release 的直链：它会 302 到 objects.githubusercontent.com，
 * 该域名国内直连不通，用户侧就是「进度条停在 0 KB」。
 * 所有 GitHub 加速镜像也一样，它们都是实时回源那个域名，于是集体 504。
 *
 * jsDelivr 是 CDN 自己回源 GitHub（它的服务器能访问），再分发给用户，
 * 所以只要仓库里有这个包，用户不必能连上 GitHub 也能更新。
 * 三个 jsDelivr 域名 + raw 兜底，字节完全相同，挂在同一个 sha256 上。
 */
function assetUrls(repo, version) {
  const asset = `update/assets/ciweimao-writer-tool-v${version}-app.zip`;
  return [
    `https://cdn.jsdelivr.net/gh/${repo}@main/${asset}`,
    `https://fastly.jsdelivr.net/gh/${repo}@main/${asset}`,
    `https://gcore.jsdelivr.net/gh/${repo}@main/${asset}`,
    `https://raw.githubusercontent.com/${repo}/main/${asset}`,
  ];
}

function buildManifest(previous, { version, repo, bytes, sha256, date, items }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无效的发布版本');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('无效的仓库');
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('更新包校验数据无效');
  if (previous.version && compareVersions(previous.version, version) > 0) throw new Error('禁止将更新清单降级');
  return {
    version, type: 'app', size: bytes, sha256,
    url: assetUrls(repo, version),
    changes: [{ version, date, items }, ...(previous.changes || []).filter(entry => entry.version !== version)].slice(0, 30),
  };
}

async function publish() {
  const version = require('../package.json').version;
  const repo = process.env.GH_REPO;
  const token = process.env.GH_TOKEN;
  if (!token || !repo || process.env.TAG_NAME !== `v${version}`) throw new Error('缺少匹配的 tag 或发布凭据');
  const file = path.join(__dirname, '..', 'release', `ciweimao-writer-tool-v${version}-app.zip`);
  const archive = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
  const notes = fs.readFileSync(path.join(__dirname, '..', 'docs', `更新说明-v${version}.md`), 'utf8');
  const items = notes.split(/\r?\n/).filter(line => line.startsWith('- ')).map(line => line.slice(2));
  const endpoint = `https://api.github.com/repos/${repo}/contents/update/latest.json`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`更新清单发布失败：HTTP ${response.status}`);
    return response.json();
  }
  // 每次都重新读取 sha；主分支并发更新时不能覆盖别人的提交。
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await request(`${endpoint}?ref=main`);
    const previous = JSON.parse(Buffer.from(current.content, 'base64').toString('utf8'));
    const manifest = buildManifest(previous, { version, repo, bytes: archive.length, sha256,
      date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' }), items });
    const content = Buffer.from(JSON.stringify(manifest, null, 2) + '\n').toString('base64');
    const response = await fetch(endpoint, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `release: publish v${version} update manifest [skip ci]`, content, sha: current.sha, branch: 'main' }),
      signal: AbortSignal.timeout(30000) });
    if (response.status === 409 && attempt < 2) continue;
    if (!response.ok) throw new Error(`更新清单写入失败：HTTP ${response.status}`);
    console.log(`已发布更新清单 v${version}：${archive.length} bytes，sha256 ${sha256}`);
    return;
  }
}

if (require.main === module) publish().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildManifest, assetUrls };
