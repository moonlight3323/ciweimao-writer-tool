'use strict';

/**
 * 本机只读数据接口。
 *
 * 给 AI agent（dsh / Claude Code / Cursor 等）读取软件内的数据用。设计上刻意做窄：
 *
 *   1. 只绑 127.0.0.1，局域网访问不到；
 *   2. 每次启动生成随机 token，必须带 Authorization: Bearer <token>；
 *   3. 只允许 GET —— 没有删除、禁言、修改，AI 能读能算，但动不了手；
 *   4. 文件白名单：只读 tsukkomi / stats-snapshots / rank-history / actions-log / library，
 *      密码本（vault.json）、cookie、诊断包一律不在可读范围；
 *   5. 默认关闭，需用户在设置里手动开；关掉即销毁监听。
 *
 * 端口交给系统分配（listen 0），实际端口写进 data/api-endpoint.json，
 * 免得和常见端口打架。MCP 桥就是读这个文件找地址的。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const library = require('./library');
const Reviewer = require('../renderer/reviewer');

const API_VERSION = 1;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 240;

/** 允许读的数据文件（白名单，其他一律拒绝） */
const READABLE = new Set(['tsukkomi.json', 'stats-snapshots.json', 'rank-history.json', 'actions-log.json']);

function createApi(opts) {
  const o = opts || {};
  const getDataDir = o.getDataDir;
  const getVersion = o.getVersion || (() => '0.0.0');

  let server = null;
  let token = '';
  let port = 0;
  let startedAt = 0;
  const hits = [];

  // ---------------------------------------------------------------- 读数据

  const cache = new Map();

  /** 带 mtime 缓存地读 JSON：604KB 的评论文件不必每次重解析 */
  function readData(name) {
    if (!READABLE.has(name)) throw new Error('不允许读取该文件');
    const file = path.join(getDataDir(), name);
    let st = null;
    try { st = fs.statSync(file); } catch (_) { return null; }
    const key = name;
    const hit = cache.get(key);
    if (hit && hit.mtime === st.mtimeMs) return hit.data;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { data = null; }
    cache.set(key, { mtime: st.mtimeMs, data });
    return data;
  }

  function snapshots() {
    const d = readData('stats-snapshots.json');
    return (d && Array.isArray(d.snapshots)) ? d.snapshots : [];
  }

  function comments() {
    const d = readData('tsukkomi.json');
    return (d && Array.isArray(d.items)) ? d.items : [];
  }

  function ranks() {
    const d = readData('rank-history.json');
    return (d && Array.isArray(d.records)) ? d.records : [];
  }

  /** 审查结果按「抓取时间 + 强度」缓存，800 条算一次几毫秒，但没必要每次重算 */
  let reviewCache = { key: '', data: null };

  function reviewed(strict) {
    const items = comments();
    const d = readData('tsukkomi.json') || {};
    const key = `${d.syncedAt || 0}|${items.length}|${strict ? 1 : 0}`;
    if (reviewCache.key === key) return reviewCache.data;
    const r = Reviewer.review(items, { strictNegative: !!strict });
    reviewCache = { key, data: r };
    return r;
  }

  // ---------------------------------------------------------------- 装配

  function booksPayload() {
    const snaps = snapshots();
    const latest = snaps.length ? snaps[snaps.length - 1] : null;
    const byId = new Map();
    if (latest) {
      (latest.books || []).forEach((b) => {
        byId.set(String(b.bookId), {
          bookId: String(b.bookId),
          name: b.name,
          status: b.status,
          words: b.words,
          collects: b.collects,
          totalSubs: b.totalSubs,
          avgSubs: b.avgSubs,
          maxSub: b.maxSub,
          maxSubChapter: b.maxSubChapter,
          newSubs: b.newSubs,
          dailyChase: b.dailyChase,
          day: latest.day,
        });
      });
    }
    // 快照里没有的书，从抓取的评论里补个名字，至少让 AI 知道有这本书
    comments().forEach((c) => {
      const id = String(c.bookId || '');
      if (!id || byId.has(id)) return;
      byId.set(id, { bookId: id, name: c.bookName || ('作品 ' + id), status: '', words: null });
    });
    return { day: latest ? latest.day : null, count: byId.size, books: [...byId.values()] };
  }

  function statsPayload(q) {
    const book = q.get('book') || '';
    const from = q.get('from') || '';
    const to = q.get('to') || '';
    const snaps = snapshots().filter((s) => {
      if (from && s.day < from) return false;
      if (to && s.day > to) return false;
      return true;
    });
    const points = [];
    snaps.forEach((s) => {
      (s.books || []).forEach((b) => {
        if (book && String(b.bookId) !== String(book)) return;
        points.push({
          day: s.day,
          bookId: String(b.bookId),
          name: b.name,
          words: b.words,
          collects: b.collects,
          totalSubs: b.totalSubs,
          newSubs: b.newSubs,
          avgSubs: b.avgSubs,
          dailyChase: b.dailyChase,
          maxSub: b.maxSub,
        });
      });
    });
    points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return {
      from: from || (points[0] && points[0].day) || null,
      to: to || (points.length ? points[points.length - 1].day : null),
      days: new Set(points.map((p) => p.day)).size,
      points,
      note: points.length < 2 ? '快照不足两天，无法计算日间变化；需要软件连续采集几天。' : '',
    };
  }

  function commentsPayload(q) {
    const book = q.get('book') || '';
    const level = q.get('level') || '';
    const kw = (q.get('q') || '').trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, parseInt(q.get('limit') || '50', 10) || 50));
    const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
    const strict = q.get('strict') === '1';

    const r = reviewed(strict);
    let list = r.items || [];
    if (book) list = list.filter((x) => String(x.bookId) === String(book));
    if (level) list = list.filter((x) => x.level === level);
    if (kw) {
      list = list.filter((x) => (String(x.content || '') + ' ' + String(x.nickname || ''))
        .toLowerCase().includes(kw));
    }
    // 有标记的排前面，AI 想找问题评论时不用自己再排
    const rank = { high: 0, mid: 1, none: 2 };
    list = list.slice().sort((a, b) => (rank[a.level] - rank[b.level])
      || String(b.time || '').localeCompare(String(a.time || '')));

    const total = list.length;
    const page = list.slice(offset, offset + limit).map((x) => ({
      id: String(x.id),
      content: x.content,
      nickname: x.nickname,
      time: x.time,
      bookId: String(x.bookId || ''),
      bookName: x.bookName,
      chapterName: x.chapterName,
      paraPos: x.paraPos,
      readerId: String(x.readerId || ''),
      level: x.level,
      score: x.score,
      hits: (x.hits || []).map((h) => ({ ruleId: h.ruleId, name: h.name, matched: h.matched })),
    }));

    return { total, offset, limit, returned: page.length, items: page };
  }

  function summaryPayload(q) {
    const book = q.get('book') || '';
    const strict = q.get('strict') === '1';
    const r = reviewed(strict);
    let items = r.items || [];
    if (book) items = items.filter((x) => String(x.bookId) === String(book));

    const byRule = new Map();
    const byReader = new Map();
    const byDay = new Map();
    const byBook = new Map();
    let high = 0;
    let mid = 0;

    items.forEach((x) => {
      if (x.level === 'high') high += 1;
      if (x.level === 'mid') mid += 1;
      (x.hits || []).forEach((h) => {
        const k = h.ruleId || h.name;
        const cur = byRule.get(k) || { ruleId: h.ruleId, name: h.name, count: 0 };
        cur.count += 1;
        byRule.set(k, cur);
      });
      const rid = String(x.readerId || '');
      if (rid) {
        const cur = byReader.get(rid) || {
          readerId: rid, nickname: x.nickname, total: 0, flagged: 0,
        };
        cur.total += 1;
        if (x.level !== 'none') cur.flagged += 1;
        byReader.set(rid, cur);
      }
      const day = String(x.time || '').slice(0, 10);
      if (day) byDay.set(day, (byDay.get(day) || 0) + 1);
      const bid = String(x.bookId || '');
      if (bid) {
        const cur = byBook.get(bid) || { bookId: bid, bookName: x.bookName, count: 0 };
        cur.count += 1;
        byBook.set(bid, cur);
      }
    });

    const readers = [...byReader.values()]
      .map((x) => Object.assign(x, {
        ratio: x.total ? Number((x.flagged / x.total).toFixed(3)) : 0,
      }))
      .sort((a, b) => b.flagged - a.flagged || b.total - a.total)
      .slice(0, 50);

    return {
      total: items.length,
      high,
      mid,
      clean: items.length - high - mid,
      topRules: [...byRule.values()].sort((a, b) => b.count - a.count).slice(0, 20),
      readers,
      byDay: [...byDay.entries()].map(([day, count]) => ({ day, count }))
        .sort((a, b) => (a.day < b.day ? -1 : 1)),
      byBook: [...byBook.values()].sort((a, b) => b.count - a.count),
    };
  }

  function rankPayload(q) {
    const type = q.get('type') === 'collect' ? 'collect' : 'click';
    const period = q.get('period') === 'month' ? 'month' : 'week';
    const recs = ranks();
    if (!recs.length) return { date: null, items: [] };
    const want = q.get('date') || recs[recs.length - 1].date;
    const rec = recs.find((r) => r.date === want) || recs[recs.length - 1];
    const prev = recs.filter((r) => r.date < rec.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const prevList = (prev && prev[type] && prev[type][period]) || [];
    const prevMap = new Map(prevList.map((x) => [x.title, x]));
    const items = ((rec[type] && rec[type][period]) || []).map((x) => {
      const p = prevMap.get(x.title);
      return {
        rank: x.rank,
        title: x.title,
        author: x.author,
        num: x.num,
        raw: x.raw,
        url: x.url,
        rankDiff: p && p.rank != null && x.rank != null ? p.rank - x.rank : null,
      };
    });
    return {
      date: rec.date,
      comparedWith: prev ? prev.date : null,
      type,
      period,
      items,
    };
  }

  function exportsPayload() {
    const dir = path.join(getDataDir(), 'exports', 'ai');
    if (!fs.existsSync(dir)) return { dir, files: [] };
    const files = fs.readdirSync(dir).map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, bytes: st.size, updatedAt: st.mtimeMs };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
    return { dir, files };
  }

  /** 给 AI 的自助说明：它第一次连上就能知道能问什么 */
  function schemaPayload() {
    return {
      api: 'ciweimao-author-tool',
      apiVersion: API_VERSION,
      appVersion: getVersion(),
      readOnly: true,
      note: '全部只读。没有删除、禁言或任何写操作。时间一律为本地时区字符串。',
      auth: 'Authorization: Bearer <token>，token 见软件「设置 → AI 接入」',
      endpoints: [
        { path: '/v1/books', desc: '作品列表与最新指标', params: [] },
        {
          path: '/v1/stats',
          desc: '按天的时间序列（字数/收藏/订阅/均订）',
          params: ['book=书号', 'from=YYYY-MM-DD', 'to=YYYY-MM-DD'],
        },
        {
          path: '/v1/comments',
          desc: '评论列表，带审查分与命中规则',
          params: ['book=', 'level=high|mid|none', 'q=关键词', 'limit<=200', 'offset=', 'strict=1'],
        },
        {
          path: '/v1/comments/summary',
          desc: '评论聚合：规则分布、按读者、按天、按书',
          params: ['book=', 'strict=1'],
        },
        { path: '/v1/rank', desc: '平台榜单（四个榜）', params: ['type=click|collect', 'period=week|month', 'date='] },
        { path: '/v1/library', desc: '已归档正文的书目', params: [] },
        { path: '/v1/chapters', desc: '某本书的章节目录（不含正文）', params: ['book=书号'] },
        { path: '/v1/chapters/text', desc: '章节正文；单章或区间', params: ['book=书号', 'index=章号', 'from=', 'to='] },
        { path: '/v1/exports', desc: '已生成的 AI 素材包文件', params: [] },
      ],
    };
  }

  // ---------------------------------------------------------------- 路由

  const routes = {
    '/v1/health': () => ({
      ok: true,
      appVersion: getVersion(),
      apiVersion: API_VERSION,
      uptimeMs: Date.now() - startedAt,
      books: booksPayload().count,
      comments: comments().length,
      snapshots: snapshots().length,
      rankDays: ranks().length,
    }),
    '/v1/schema': schemaPayload,
    '/v1/books': booksPayload,
    '/v1/stats': statsPayload,
    '/v1/comments': commentsPayload,
    '/v1/comments/summary': summaryPayload,
    '/v1/rank': rankPayload,
    '/v1/library': () => ({ books: library.listBooks(getDataDir()) }),
    '/v1/chapters': (q) => {
      const book = q.get('book');
      if (!book) throw badRequest('缺少 book 参数');
      const toc = library.getBookToc(getDataDir(), book);
      if (!toc) return { book, chapters: [], note: '这本书还没有归档正文，先在软件里做一次章节导出。' };
      return toc;
    },
    '/v1/chapters/text': (q) => {
      const book = q.get('book');
      if (!book) throw badRequest('缺少 book 参数');
      const from = q.get('from');
      const to = q.get('to');
      if (from || to) {
        const r = library.getChapterRange(getDataDir(), book, from || to, to || from);
        return r || { book, note: '这本书还没有归档正文。' };
      }
      const idx = q.get('index');
      if (!idx) throw badRequest('缺少 index（或用 from/to 取区间）');
      const r = library.getChapter(getDataDir(), book, idx);
      return r || { book, index: Number(idx), note: '没有这一章，或这本书还没归档正文。' };
    },
    '/v1/exports': exportsPayload,
  };

  function badRequest(msg) {
    const e = new Error(msg);
    e.status = 400;
    return e;
  }

  function rateLimited() {
    const now = Date.now();
    while (hits.length && now - hits[0] > RATE_WINDOW_MS) hits.shift();
    if (hits.length >= RATE_MAX) return true;
    hits.push(now);
    return false;
  }

  function send(res, status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      // 不给跨源头：浏览器里的第三方网页读不到这些数据
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
  }

  function authorized(req, url) {
    const h = String(req.headers.authorization || '');
    const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const qToken = url.searchParams.get('token') || '';
    const given = bearer || qToken;
    if (!given || !token) return false;
    // 定长比较，避免逐字符试探
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (_) {
      return send(res, 400, { error: 'bad url' });
    }

    if (req.method !== 'GET') {
      return send(res, 405, { error: '只支持 GET（接口是只读的）' });
    }
    if (!authorized(req, url)) {
      return send(res, 401, {
        error: '未授权',
        hint: '需要 Authorization: Bearer <token>；token 在软件「设置 → AI 接入」里',
      });
    }
    if (rateLimited()) {
      return send(res, 429, { error: '请求太频繁，请稍后再试' });
    }

    const fn = routes[url.pathname];
    if (!fn) {
      return send(res, 404, { error: '没有这个接口', list: Object.keys(routes) });
    }
    try {
      const out = fn(url.searchParams);
      return send(res, 200, out);
    } catch (err) {
      return send(res, err.status || 500, { error: String((err && err.message) || err) });
    }
  }

  // ---------------------------------------------------------------- 生命周期

  function endpointPath() {
    return path.join(getDataDir(), 'api-endpoint.json');
  }

  function writeEndpoint() {
    const info = {
      port,
      token,
      url: `http://127.0.0.1:${port}`,
      pid: process.pid,
      appVersion: getVersion(),
      apiVersion: API_VERSION,
      startedAt,
    };
    try {
      fs.mkdirSync(getDataDir(), { recursive: true });
      fs.writeFileSync(endpointPath(), JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (_) { /* 写不了也不影响服务本身 */ }
    return info;
  }

  // listen 还没回回调时，server 已经同步赋值、port 还是 0。
  // 这时第二次 start() 若直接走 `if (server) return status()`，
  // 会返回 { running:true, port:0, url:'' } 的假状态。缓存住 pending Promise，
  // 并发调用拿到的是同一次启动结果。
  let starting = null;

  function start() {
    if (server) return Promise.resolve(status());
    if (starting) return starting;
    token = crypto.randomBytes(24).toString('hex');
    startedAt = Date.now();

    const pending = new Promise((resolve, reject) => {
      const srv = http.createServer(handler);
      server = srv;
      srv.on('error', (err) => {
        if (server === srv) server = null;
        reject(err);
      });
      // 只监听回环地址，局域网内其他机器连不上
      srv.listen(0, '127.0.0.1', () => {
        port = srv.address().port;
        writeEndpoint();
        resolve(status());
      });
    });
    starting = pending;
    pending.then(
      () => { if (starting === pending) starting = null; },
      () => { if (starting === pending) starting = null; },
    );
    return pending;
  }

  function stop() {
    const s = server;
    server = null;
    port = 0;
    token = '';
    try { fs.rmSync(endpointPath(), { force: true }); } catch (_) { /* ignore */ }
    if (!s) return Promise.resolve({ running: false });
    return new Promise((resolve) => s.close(() => resolve({ running: false })));
  }

  function status() {
    return {
      running: !!server,
      port,
      token,
      url: port ? `http://127.0.0.1:${port}` : '',
      startedAt,
      endpointFile: endpointPath(),
      readOnly: true,
    };
  }

  return { start, stop, status, endpointPath };
}

module.exports = { createApi, API_VERSION };
