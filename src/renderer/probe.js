'use strict';

/**
 * 页面结构测绘。
 *
 * 后台架构（实测 2026-11-04）：
 *   - 主框架 /homepage?hid=xxx 承载左侧菜单，功能页装进 iframe#div-iframe-view
 *   - 各功能页可直接以 URL 打开，得到无外壳的干净 DOM
 *   - 表单是标准 POST（无签名），字段名直接可读
 *
 * 因此测绘策略：直接按白名单路由逐页访问，绕开首页链接发现——
 * 首页存在 [退出] → /login/loginOut 这类陷阱链接，走过去会注销登录态。
 */

/** 只读功能页白名单（不含任何登出、提交类路径） */
const ROUTES = [
  { path: '/book_manage/view_list', name: '作品列表' },
  { path: '/book_manage/view_chapter_info', name: '章节列表' },
  { path: '/review_manage/manage_tsukkomi', name: '间贴管理' },
  { path: '/review_manage/manage_tsukkomi_reply', name: '间贴回复' },
  { path: '/review_manage/manage_review', name: '书评管理' },
  { path: '/review_manage/speak_reader', name: '禁言回收站' },
  { path: '/review_manage/manage_reader', name: '读者管理' },
  { path: '/review_manage/fans_speak_manage', name: '读者发言管理' },
  { path: '/money_manage/view_buy_new', name: '作品订阅' },
  { path: '/money_manage/view_reader_analysis', name: '读者分析' },
  { path: '/homepage?hid=0', name: '首页主框架' },
];

const ORIGIN = 'https://author.ciweimao.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 在目标页面上下文执行：抽取结构特征。
 * 会被序列化后送进平台页面，内部不得引用外部变量。
 */
function pageProbe() {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const abs = (h) => {
    try { return new URL(h, location.href).href; } catch (_) { return h || ''; }
  };

  const out = {
    url: location.href,
    title: document.title,
    links: [],
    forms: [],
    tables: [],
    iframes: [],
    ids: [],
    headings: [],
    bodySample: '',
  };

  const seen = new Set();
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = abs(a.getAttribute('href'));
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    if (seen.has(href)) return;
    seen.add(href);
    if (out.links.length >= 200) return;
    out.links.push({
      href,
      text: norm(a.textContent).slice(0, 50),
      target: a.getAttribute('target') || '',
    });
  });

  document.querySelectorAll('form').forEach((f) => {
    if (out.forms.length >= 20) return;
    out.forms.push({
      action: abs(f.getAttribute('action') || ''),
      method: (f.getAttribute('method') || 'get').toUpperCase(),
      id: f.id || '',
      cls: (f.className || '').toString().slice(0, 80),
      fields: Array.from(f.querySelectorAll('input,select,textarea')).slice(0, 40).map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        value: String(el.value ?? '').slice(0, 60),
      })),
    });
  });

  document.querySelectorAll('table').forEach((t) => {
    if (out.tables.length >= 12) return;
    // 表头只认 th；老站大量表格没有 thead，第一行是 td 数据
    let headers = Array.from(t.querySelectorAll('thead th')).map((x) => norm(x.textContent));
    if (!headers.filter(Boolean).length) {
      const firstTr = t.querySelector('tr');
      const ths = firstTr ? Array.from(firstTr.querySelectorAll('th')) : [];
      headers = ths.map((x) => norm(x.textContent));
    }
    const firstRow = t.querySelector('tr');
    out.tables.push({
      id: t.id || '',
      cls: (t.className || '').toString().slice(0, 80),
      headers: headers.filter(Boolean).slice(0, 24),
      sampleRow: firstRow
        ? Array.from(firstRow.querySelectorAll('td,th')).slice(0, 20).map((c) => norm(c.textContent).slice(0, 40))
        : [],
      rowCount: t.querySelectorAll('tr').length,
    });
  });

  document.querySelectorAll('iframe').forEach((f) => {
    if (out.iframes.length >= 5) return;
    out.iframes.push({ id: f.id || '', name: f.name || '', src: abs(f.getAttribute('src') || '') });
  });

  Array.from(document.querySelectorAll('[id]')).slice(0, 120).forEach((el) => {
    out.ids.push(el.tagName.toLowerCase() + '#' + el.id);
  });

  document.querySelectorAll('h1,h2,h3,h4').forEach((h) => {
    if (out.headings.length >= 40) return;
    const t = norm(h.textContent);
    if (t) out.headings.push(h.tagName.toLowerCase() + ': ' + t.slice(0, 50));
  });

  try {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg').forEach((e) => e.remove());
    let html = clone.innerHTML.replace(/\s+/g, ' ');
    if (html.length > 30000) html = html.slice(0, 30000) + ' <!--TRUNCATED-->';
    out.bodySample = html;
  } catch (_) {
    out.bodySample = '';
  }

  return out;
}

/**
 * 串行测绘：按白名单逐页访问并落盘。
 * 任何一页跳转到 /login 立即中止，避免继续对着登录页徒劳抓取。
 */
async function collectDiagnostics(onProgress) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const manifest = { generatedAt: new Date().toISOString(), stamp, pages: [], aborted: null };

  const save = (name, data) =>
    window.api.diag.save(`${stamp}__${name}.json`, JSON.stringify(data, null, 2));

  const probe = async (label) => {
    const data = await window.api.browser.evalInPage(`(${pageProbe.toString()})()`);
    await save(label, data);
    return data;
  };

  // 前置：确认已登录
  const curUrl = await window.api.browser.evalInPage('location.href');
  if (/\/login/i.test(curUrl || '')) {
    throw new Error('当前处于未登录状态，请先登录作者后台');
  }

  for (let i = 0; i < ROUTES.length; i += 1) {
    const r = ROUTES[i];
    const seq = String(i + 1).padStart(2, '0');
    if (onProgress) {
      onProgress({ phase: 'navigate', index: i + 1, total: ROUTES.length, label: r.name });
    }

    try {
      await window.api.browser.goto(ORIGIN + r.path);
      await window.api.browser.waitIdle(20000);
      await sleep(700);

      const where = await window.api.browser.evalInPage('location.href');
      if (/\/login/i.test(where || '')) {
        manifest.aborted = `访问 ${r.name} 时被重定向到登录页，登录态已失效`;
        break;
      }

      const data = await probe(`${seq}-${r.name}`);
      manifest.pages.push({ label: `${seq}-${r.name}`, path: r.path, url: data.url, title: data.title });
      if (onProgress) {
        onProgress({ phase: 'done-page', index: i + 1, total: ROUTES.length, label: r.name, ok: true });
      }
    } catch (err) {
      const msg = String((err && err.message) || err);
      manifest.pages.push({ label: `${seq}-${r.name}`, path: r.path, error: msg });
      if (onProgress) {
        onProgress({ phase: 'done-page', index: i + 1, total: ROUTES.length, label: r.name, ok: false });
      }
    }
  }

  await window.api.diag.save(`${stamp}__manifest.json`, JSON.stringify(manifest, null, 2));

  try { await window.api.browser.goto(ORIGIN + '/homepage'); } catch (_) { /* ignore */ }

  return manifest;
}

window.probeApi = { pageProbe, collectDiagnostics, ROUTES };
