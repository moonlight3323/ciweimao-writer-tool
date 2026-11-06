'use strict';

/**
 * 界面测试：敏感词库面板（设置页）+ 收集提示条（侧栏）。
 *
 * 关于运行环境：本机既装不上 Electron 运行时（二进制下载被网络挡住），
 * 也无法启动 Chrome/Edge（进程被环境拦截，和打包后的 exe 起不来是同一原因）。
 * 但这套界面逻辑只依赖 DOM 与 window.api 的形状，不依赖 Electron 特性，
 * 所以用 jsdom 载入**真实的 HTML + 真实的脚本**，只把 api 换成桩 —— 测的是同一份代码。
 *
 * 桩的返回结构照抄 src/main/badwordlib.js 与 preload 的真实签名：
 *   list()  → [{ w, hits, first, last, submitted, submittedAt }]
 *   stats() → { total, submittable, submitted }
 *   add()   → { added, merged }
 *
 * 运行：node tools/ui-wordlib.js
 */

const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.error('需要 jsdom：在项目根执行 `npm install --no-save jsdom` 后重试');
  process.exit(2);
}

const FIXTURES = path.join(__dirname, 'fixtures');

/** 把 `<script src>` 内联、去掉样式表：jsdom 无需再发请求，DOM 与脚本仍是真实的 */
function buildHtml(file) {
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/gi, '');
  html = html.replace(/<script\s+src="([^"]+)"\s*><\/script>/gi, (m, src) => {
    const p = path.resolve(path.dirname(file), src);
    const code = fs.readFileSync(p, 'utf8');
    return `<script>\n${code}\n</script>`;
  });
  return html;
}

/** 等页面把断言结果写进 #result（页面里用 setTimeout 等异步渲染落地） */
async function waitResult(dom, timeoutMs) {
  const limit = Date.now() + (timeoutMs || 4000);
  while (Date.now() < limit) {
    const el = dom.window.document.getElementById('result');
    const raw = el && el.textContent ? el.textContent.trim() : '';
    if (raw) {
      try { return JSON.parse(raw); } catch (_) { /* 还没写完 */ }
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

async function runPage(file, scene, beforeParse) {
  const html = buildHtml(path.join(FIXTURES, file));
  // scene 必须走 URL：页面用 location.search 选场景，不带就是默认那一个，
  // 会导致每个用例都在跑同一组断言（看起来全绿，其实什么都没测）。
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `http://localhost/?scene=${encodeURIComponent(scene || 'render')}`,
    pretendToBeVisual: true,
    beforeParse(window) {
      if (beforeParse) beforeParse(window);
    },
  });
  const result = await waitResult(dom);
  dom.window.close();
  return result;
}

async function main() {
  const cases = [
    { label: '设置面板 · 渲染与统计', file: 'wordlib-page.html', scene: 'render' },
    { label: '设置面板 · 按命中次数降序', file: 'wordlib-page.html', scene: 'sort' },
    { label: '设置面板 · 单字词折叠', file: 'wordlib-page.html', scene: 'single' },
    { label: '设置面板 · 空态', file: 'wordlib-page.html', scene: 'empty' },
    { label: '设置面板 · 超过 200 条', file: 'wordlib-page.html', scene: 'many' },
    { label: '设置面板 · 订阅开关写入', file: 'wordlib-page.html', scene: 'toggle' },
    {
      label: '设置面板 · 重建后状态保持',
      file: 'wordlib-page.html',
      scene: 'toggle-read',
      // 上一轮把 subscribeWordlib 写进了 localStorage，这里原样带过去
      before: (w) => w.localStorage.setItem('ui-prefs', JSON.stringify({ subscribeWordlib: true })),
    },
    { label: '侧栏 · 一次性收集提示', file: 'side-page.html', scene: 'hint' },
  ];

  let total = 0;
  let failed = 0;
  const lines = [];

  for (const c of cases) {
    const result = await runPage(c.file, c.scene, c.before);
    if (!result) {
      total += 1;
      failed += 1;
      lines.push(`✗ ${c.label}：页面没有产出结果`);
      continue;
    }
    for (const chk of result.checks) {
      total += 1;
      if (chk.ok) {
        lines.push(`✓ ${c.label} → ${chk.name}`);
      } else {
        failed += 1;
        lines.push(`✗ ${c.label} → ${chk.name}`);
        lines.push(`    实际：${String(chk.got).slice(0, 160)}`);
      }
    }
  }

  console.log(`运行环境：jsdom ${require('jsdom/package.json').version}（真实 DOM + 真实脚本 + 桩数据）\n`);
  console.log(lines.join('\n'));
  console.log(`\n共 ${total} 项，通过 ${total - failed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试运行失败：', e && e.message);
  process.exit(2);
});
