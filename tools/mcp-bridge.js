#!/usr/bin/env node
'use strict';

/**
 * MCP 桥：把 MCP 的 tools/call 转成本机只读 HTTP 请求。
 *
 * 为什么不直接在软件里跑 MCP server：
 *   MCP 的 stdio 传输要求客户端能拉起一个子进程并独占它的 stdin/stdout。
 *   让 agent 去启动 GUI 版 Electron 代价太大（会弹窗、慢、还可能抢单实例锁）。
 *   所以这里做一个几十 KB 的小进程，只负责转发；GUI 那边提供 HTTP。
 *
 * 运行方式（不要求用户装 Node）：便携包里的 Electron 可执行文件能以 Node 模式运行本脚本：
 *   ELECTRON_RUN_AS_NODE=1 "<安装目录>\刺猬猫作家助手.exe" "…\resources\app\tools\mcp-bridge.js"
 *
 * 重要：stdout 只能出现 JSON-RPC 消息。所有日志一律走 stderr。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'ciweimao-author-tool', version: '1.0.0' };

/** 找软件写下的接口地址与 token */
function readEndpoint() {
  const candidates = [];
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  candidates.push(path.join(appData, 'ciweimao-author-tool', 'data', 'api-endpoint.json'));
  if (process.env.CW_ENDPOINT_FILE) candidates.unshift(process.env.CW_ENDPOINT_FILE);

  for (const f of candidates) {
    try {
      const info = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (info && info.port && info.token) return info;
    } catch (_) { /* 继续找下一个 */ }
  }
  return null;
}

function getJson(endpoint, pathname, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    });
    const url = `http://127.0.0.1:${endpoint.port}${pathname}${qs.toString() ? '?' + qs.toString() : ''}`;
    const req = http.get(url, {
      headers: { Authorization: 'Bearer ' + endpoint.token },
      timeout: 15000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('返回内容不是 JSON')); }
        } else {
          let msg = buf;
          try { msg = JSON.parse(buf).error || buf; } catch (_) { /* 原样 */ }
          reject(new Error(`HTTP ${res.statusCode}：${msg}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

const TOOLS = [
  {
    name: 'ciweimao_books',
    description: '列出所有作品及最新一天的指标（字数、收藏、总订阅、均订、单章最高订阅）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    path: '/v1/books',
  },
  {
    name: 'ciweimao_stats',
    description: '按天的时间序列，用于做趋势与表格。可按书号与日期区间过滤。注意快照不足两天时无法算日间变化。',
    inputSchema: {
      type: 'object',
      properties: {
        book: { type: 'string', description: '书号；不填则返回所有书' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
      },
      additionalProperties: false,
    },
    path: '/v1/stats',
  },
  {
    name: 'ciweimao_comments',
    description: '评论列表，带审查分与命中规则。默认按风险从高到低排序。',
    inputSchema: {
      type: 'object',
      properties: {
        book: { type: 'string', description: '书号' },
        level: { type: 'string', enum: ['high', 'mid', 'none'], description: '只看某个风险等级' },
        q: { type: 'string', description: '在内容与昵称里搜关键词' },
        limit: { type: 'number', description: '返回条数，最大 200，默认 50' },
        offset: { type: 'number', description: '跳过条数，用于翻页' },
        strict: { type: 'string', description: '传 1 表示用严格审查（把负面评价也算进来）' },
      },
      additionalProperties: false,
    },
    path: '/v1/comments',
  },
  {
    name: 'ciweimao_comment_summary',
    description: '评论聚合统计：规则命中分布、需要看的原文、发言最多的读者、按天与按书分布。问「评论区在骂什么」时先调这个。',
    inputSchema: {
      type: 'object',
      properties: {
        book: { type: 'string', description: '书号' },
        strict: { type: 'string', description: '传 1 用严格审查' },
      },
      additionalProperties: false,
    },
    path: '/v1/comments/summary',
  },
  {
    name: 'ciweimao_rank',
    description: '平台榜单：点击榜 / 收藏榜，周榜或月榜，前 10 名，带与前一日的名次变化与书页链接。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['click', 'collect'], description: 'click=点击榜，collect=收藏榜' },
        period: { type: 'string', enum: ['week', 'month'], description: '周榜或月榜' },
        date: { type: 'string', description: '看哪一天，默认最新' },
      },
      additionalProperties: false,
    },
    path: '/v1/rank',
  },
  {
    name: 'ciweimao_library',
    description: '已归档正文的书目列表（书号、书名、章数、总字数）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    path: '/v1/library',
  },
  {
    name: 'ciweimao_chapters',
    description: '某本书的章节目录（只有标题与字数，不含正文）。',
    inputSchema: {
      type: 'object',
      properties: { book: { type: 'string', description: '书号' } },
      required: ['book'],
      additionalProperties: false,
    },
    path: '/v1/chapters',
  },
  {
    name: 'ciweimao_chapter_text',
    description: '取章节正文。单章用 index，连续多章用 from/to。做剧情汇总时建议一次取 5–10 章，避免一次塞太多。',
    inputSchema: {
      type: 'object',
      properties: {
        book: { type: 'string', description: '书号' },
        index: { type: 'number', description: '单章章号' },
        from: { type: 'number', description: '起始章号' },
        to: { type: 'number', description: '结束章号' },
      },
      required: ['book'],
      additionalProperties: false,
    },
    path: '/v1/chapters/text',
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const NO_ENDPOINT = [
  '没有找到本机接口。',
  '',
  '请先在「刺猬猫作家助手」里：设置 → AI 接入 → 打开「允许本机 AI 读取数据」，',
  '然后再让 agent 重试。',
].join('\n');

async function handleTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error('没有这个工具：' + name);

  const ep = readEndpoint();
  if (!ep) throw new Error(NO_ENDPOINT);

  const params = Object.assign({}, args || {});
  const data = await getJson(ep, tool.path, params);
  const text = JSON.stringify(data, null, 2);
  // 单次返回过长时截断并提示分页，避免把模型上下文撑爆
  const MAX = 60000;
  if (text.length > MAX) {
    return {
      content: [{
        type: 'text',
        text: text.slice(0, MAX) + `\n\n…（已截断，共 ${text.length} 字符。请用 limit/offset 或更小的 from/to 区间分批取）`,
      }],
    };
  }
  return { content: [{ type: 'text', text }] };
}

async function onMessage(msg) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized') return; // 通知，无需回应
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await handleTool(name, args);
      return reply(id, result);
    } catch (err) {
      return reply(id, {
        content: [{ type: 'text', text: String((err && err.message) || err) }],
        isError: true,
      });
    }
  }

  if (id !== undefined) fail(id, -32601, '未实现的方法：' + method);
}

// ---- stdio：按行读取 JSON-RPC ----

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      process.stderr.write('[mcp-bridge] 收到非 JSON 内容，已忽略\n');
      continue;
    }
    Promise.resolve(onMessage(msg)).catch((err) => {
      process.stderr.write('[mcp-bridge] 处理失败：' + err.message + '\n');
    });
  }
});

process.stdin.on('end', () => process.exit(0));

process.stderr.write('[mcp-bridge] 已启动，等待 JSON-RPC\n');
