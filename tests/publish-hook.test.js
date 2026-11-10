'use strict';

/**
 * 发布按钮接管（pageHookPublish）的回归测试
 *
 * 盯的是一个真实反馈：「点发布，然后卡住了」。
 *
 * 排查下来是两个缺陷叠在一起：
 *
 * 1. **一次点击发出两个请求。**
 *    接管用的是 `cloneNode(true) + replaceChild`。这能甩掉站点用
 *    addEventListener / jQuery .on 绑的监听，但**内联 onclick 是 DOM 属性，
 *    会被原样复制**。站点这两个按钮正是 `onclick="check_special()"`，
 *    而 check_special 早已被我们覆盖成 doCheck —— 于是点一下跑两遍。
 *    两个请求抢同一个 window.__wbCheckResult：后发的立刻把先发的 done 覆盖成
 *    pending，宿主轮询只认 done/error，界面就再也不会更新。
 *
 * 2. **pending 没有超时兜底。**
 *    同文件里的 pageCheckChapter（主动校验）有 20 秒超时，doCheck 没有。
 *    ajax 一旦挂住（断网、被拦、会话失效但连接不关），状态永远停在 pending，
 *    宿主轮询对 pending 直接 return，用户从头到尾看不到任何反馈。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const adapter = require('../src/adapters/ciweimao.js');

let JSDOM = null;
try {
  // eslint-disable-next-line global-require
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  JSDOM = null;
}
const maybe = JSDOM ? test : test.skip;

const DRAFT_URL = 'https://author.ciweimao.com/book_manage/draft?book_id=100089450';

/**
 * 造一个尽量贴近站点的页面：
 *   - 按钮用内联 onclick 调 check_special / check_badword（这是关键）
 *   - form#myform + #buttonValue 隐藏域
 *   - jQuery 只实现 serialize 与 ajax，ajax 的回调由测试手动触发
 */
function makePage() {
  const html = `<!doctype html><html><body>
    <form id="myform" action="/book_manage/add_chapter" method="post"></form>
    <input type="hidden" id="buttonValue" value="">
    <input type="button" id="dosubmit" value="发布章节" onclick="check_special()">
    <input type="button" id="savedraft" value="保存草稿" onclick="check_badword('savedraft')">
  </body></html>`;

  const dom = new JSDOM(html, {
    // dangerously 才会执行内联 onclick —— outside-only 不执行，
    // 那样「双触发」这个 bug 根本复现不出来，测试会给出假的通过
    runScripts: 'dangerously',
    url: DRAFT_URL,
  });
  const w = dom.window;

  // 接管 setTimeout：可以手动触发超时，不用真等 25 秒
  const timers = [];
  w.setTimeout = (fn, ms) => { timers.push({ fn, ms, cancelled: false }); return timers.length; };
  w.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; };

  // 手动驱动的 ajax 队列
  const queue = [];
  w.jQuery = function () { return { serialize: () => 'a=1' }; };
  w.jQuery.ajax = (opt) => { queue.push(opt); };

  w.eval(adapter.pageSource('pageHookPublish'));

  const fireTimeout = () => {
    timers.filter((t) => !t.cancelled && t.ms >= 20000).forEach((t) => t.fn());
  };
  const click = (id) => w.document.getElementById(id)
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const read = () => w.eval(adapter.pageSource('pageReadCheck'));

  return { w, timers, queue, fireTimeout, click, read };
}

maybe('点一次「发布章节」只提交一次（内联 onclick 必须被摘掉）', () => {
  const p = makePage();
  p.click('dosubmit');
  assert.equal(p.queue.length, 1,
    `点一次应只发一个请求，实际发了 ${p.queue.length} 个`
    + '（cloneNode 复制了内联 onclick，导致 doCheck 跑两遍）');
  assert.equal(p.w.document.getElementById('dosubmit').getAttribute('onclick'), null,
    '克隆节点上的内联 onclick 必须被移除');
});

maybe('连点多次也不会重复提交（防重入）', () => {
  const p = makePage();
  p.click('dosubmit');
  p.click('dosubmit');
  p.click('dosubmit');
  assert.equal(p.queue.length, 1, `连点三次仍应只有 1 个请求，实际 ${p.queue.length}`);
});

maybe('站点迟迟不回时，25 秒后落到 error 而不是一直 pending', () => {
  // 宿主轮询只处理 done / error，pending 是直接跳过的。
  // 没有这个超时，ajax 一挂住界面就永远没反应 —— 这就是「卡住」。
  const p = makePage();
  p.click('dosubmit');
  assert.equal(p.read().phase, 'pending', '刚点下去应是 pending');

  p.fireTimeout();
  const r = p.read();
  assert.equal(r.phase, 'error', '超时后必须变成 error，让宿主能提示出来');
  assert.match(r.error, /没有响应|超时/, '提示要说明是超时');
});

maybe('超时后重试，旧请求的迟到回调不能污染新结果', () => {
  const p = makePage();
  p.click('dosubmit');
  p.fireTimeout();

  p.click('dosubmit');                       // 用户点重试
  assert.equal(p.queue.length, 2, '重试应发出第二个请求');
  assert.equal(p.read().phase, 'pending', '重试后重新进入等待');

  // 旧请求这时才回来，它已经过期，不能覆盖新一轮的状态
  p.queue[0].success({ suggestion: 'error', msg: '上一轮的过期错误' });
  const r = p.read();
  assert.equal(r.phase, 'pending', '旧请求的回调必须被丢弃');
  assert.equal(r.msg, '', '旧请求的消息不能出现');
});

maybe('成功后把结果备份进 sessionStorage，页面跳走宿主仍能读到', () => {
  // 站点在 suggestion=pass 时自己跳转，页面一卸载 __wbCheckResult 就没了。
  // 宿主 1.2 秒轮询一次，很可能还没读到就跳没了 —— 侧栏便一直停在
  // 「已填入后台」，用户以为没发出去，又点一遍，站点就报重复提交。
  const p = makePage();
  p.click('dosubmit');
  p.queue[0].success({
    suggestion: 'pass',
    msg: '发布成功',
    url: 'https://author.ciweimao.com/book_manage/chapter?chapter_id=123',
  });

  const bak = p.w.sessionStorage.getItem('__wbCheckResult');
  assert.ok(bak, '成功结果必须备份到 sessionStorage');
  const parsed = JSON.parse(bak);
  assert.equal(parsed.phase, 'done');
  assert.equal(parsed.suggestion, 'pass', '宿主要靠它判断「已提交成功」');

  // 清掉内存里的那份，模拟「页面已经跳走」，宿主仍应读得到
  p.w.__wbCheckResult = null;
  const r = p.read();
  assert.equal(r.phase, 'done', '页面跳转后宿主仍要能读到结果');
  assert.equal(r.suggestion, 'pass');
  assert.equal(r.fromStorage, true, '要能看出这是从备份里捞回来的');
});

maybe('清掉结果时连 sessionStorage 一起清，避免下一章读到旧结果', () => {
  const p = makePage();
  p.click('dosubmit');
  p.queue[0].success({ suggestion: 'pass', url: 'https://author.ciweimao.com/x?chapter_id=1' });
  p.w.eval(adapter.pageSource('pageClearCheck'));
  assert.equal(p.w.sessionStorage.getItem('__wbCheckResult'), null);
  assert.equal(p.read().phase, 'idle', '清完应是 idle，不是把旧结果又读一遍');
});

maybe('站点改版成无 id 的 button 时，按文字仍能接管', () => {
  // 只认 id 的隐患：站点哪天换成 <button>发布章节</button>，接管会整个失效，
  // 而且是静默失效 —— 用户点的是站点原生按钮，我们收不到任何结果。
  const html = `<!doctype html><html><body>
    <form id="myform"></form>
    <input type="hidden" id="buttonValue" value="">
    <button class="btn btn-warning">发布章节</button>
    <button class="btn btn-info">保存草稿</button>
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: DRAFT_URL });
  const w = dom.window;
  let calls = 0;
  w.jQuery = () => ({ serialize: () => 'a=1' });
  w.jQuery.ajax = () => { calls += 1; };

  const r = w.eval(adapter.pageSource('pageHookPublish'));
  assert.equal(r.buttons, 2, '两个按钮都该靠文字认出来');

  w.document.querySelectorAll('button')[0]
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(calls, 1, '点「发布章节」应走我们的校验');
});

maybe('一个按钮都接管不到时，明确报 buttons=0 让界面提示', () => {
  // 宁可让界面说「没认出发布按钮」，也不能静默 ——
  // 静默失败在用户眼里就是「点了没反应」。
  const html = `<!doctype html><html><body>
    <form id="myform"></form>
    <input type="hidden" id="buttonValue" value="">
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: DRAFT_URL });
  const w = dom.window;
  w.jQuery = () => ({ serialize: () => 'a=1' });

  const r = w.eval(adapter.pageSource('pageHookPublish'));
  assert.equal(r.buttons, 0, '没有按钮时必须报 0，不能假装成功');
});

/* ------------------------------------------------------------------ 反馈必须看得见
 *
 * 上面那些修的是「为什么结果出不来」，这一段修的是「结果出来了但看不到」。
 * 用户的第二份反馈很关键：**章节其实已经发出去了**，只是点完按钮界面一动不动。
 * 查下来的直接原因是反馈被内嵌网页盖住了 —— 右下角那个 #publishToast 住在
 * #content 里，而后台页面是原生 WebContentsView，压在 #content 之上。
 */

maybe('站点不给 url 时，兜底跳到章节管理页（不然页面一动不动）', () => {
  // 站点返回 { suggestion: 'pass' } 但 url 为空，旧代码什么都不做：
  // 章节已经建好了，界面却停在新建章节页原样不动 —— 用户只会再点一次。
  const html = `<!doctype html><html><body>
    <form id="myform" action="/book_manage/add_chapter" method="post">
      <input type="hidden" name="book_id" value="100089450">
    </form>
    <input type="hidden" id="buttonValue" value="">
    <input type="button" id="dosubmit" value="发布章节" onclick="check_special()">
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: DRAFT_URL });
  const w = dom.window;
  const queue = [];
  w.jQuery = function () { return { serialize: () => 'a=1' }; };
  w.jQuery.ajax = (opt) => { queue.push(opt); };

  w.eval(adapter.pageSource('pageHookPublish'));
  w.document.getElementById('dosubmit')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));

  // 站点说通过，但没给 url
  queue[0].success({ suggestion: 'pass', msg: '发布成功' });
  const r = w.eval(adapter.pageSource('pageReadCheck'));

  assert.equal(r.suggestion, 'pass');
  assert.equal(r.navTo, '/book_manage/view_chapter_info?book_id=100089450',
    '没有 url 时必须自己拼章节管理页，否则界面看起来和没点一样');
  w.close(); // 关掉待触发的 60ms 跳转定时器，免得 jsdom 打「navigation 未实现」
});

maybe('站点给了 url 时优先用它，不要覆盖成兜底地址', () => {
  const p = makePage();
  p.click('dosubmit');
  p.queue[0].success({ suggestion: 'pass', url: 'https://author.ciweimao.com/book_manage/x?chapter_id=9' });
  assert.equal(p.read().navTo, 'https://author.ciweimao.com/book_manage/x?chapter_id=9');
});

test('发布结果必须有「顶栏」这条通道（内嵌网页盖不到的地方）', () => {
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');

  const statusAt = html.indexOf('id="pubStatus"');
  const contentAt = html.indexOf('id="content"');
  const topbarAt = html.indexOf('class="topbar"');
  const toastAt = html.indexOf('id="publishToast"');

  assert.ok(statusAt > 0, '顶栏必须有 #pubStatus 状态条');
  assert.ok(topbarAt > 0 && statusAt > topbarAt, '#pubStatus 要放在顶栏里');
  assert.ok(statusAt < contentAt,
    '#pubStatus 必须在 #content 之前 —— #content 会被原生视图整个盖住');
  // 这一条记录了「为什么需要两条通道」：toast 在 #content 里面
  assert.ok(toastAt > contentAt, '右下角 toast 在 #content 内，正是被盖住的那个');

  const pub = fs.readFileSync(path.join(root, 'src/renderer/publish.js'), 'utf8');
  assert.ok(/function setStatus\(/.test(pub), 'publish.js 要有 setStatus');
  // 三处最关键的节点都要走顶栏，缺一处就会出现「这条消息又看不见了」
  const onPub = pub.slice(pub.indexOf('async function onPublished'), pub.indexOf('async function onPublished') + 500);
  assert.ok(/setStatus\(/.test(onPub), 'onPublished 要写顶栏（成功结果）');
  const notice = pub.slice(pub.indexOf('async function notice('), pub.indexOf('async function notice(') + 400);
  assert.ok(/setStatus\(/.test(notice), 'notice 要写顶栏（错误结果）');
});

test('侧栏不再提供发布入口，只走网页上的「发布章节」', () => {
  // 用户明确要求：把敏感词侧栏的发布功能去掉，只留网页按钮。
  // 侧栏代发时站点的确认弹窗 / 报错 / 跳转全被绕开，作者在页面上看不到任何变化；
  // 两套入口并存还容易重复提交。
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const sideHtml = fs.readFileSync(path.join(root, 'src/renderer/side.html'), 'utf8');
  const sideJs = fs.readFileSync(path.join(root, 'src/renderer/side.js'), 'utf8');
  const pub = fs.readFileSync(path.join(root, 'src/renderer/publish.js'), 'utf8');

  assert.equal(/id="btnPsPublish"/.test(sideHtml), false, '侧栏不该再有「发布这一章」');
  assert.equal(/id="btnBwForce"/.test(sideHtml), false, '侧栏不该再有「直接提交」');
  assert.equal(/btnPsPublish/.test(sideJs), false, 'side.js 不该再绑「发布这一章」');
  assert.equal(/btnBwForce/.test(sideJs), false, 'side.js 不该再绑「直接提交」');
  assert.equal(/c\.type === 'publish'/.test(pub), false, 'publish.js 不该再处理 publish 命令');
  assert.equal(/c\.type === 'force'/.test(pub), false, 'publish.js 不该再处理 force 命令');
});

test('页面求值必须带超时，否则轮询会被一次挂起的调用拖死', () => {
  // 页面跳转时 executeJavaScript 可能永远不 resolve（旧文档已销毁、新文档没就绪）。
  // 而发布轮询有 pollBusy 闸门：一次挂住就再也不查，界面从此没有任何反馈。
  // 1.1.1 起超时收进 runPageScript，发布 / 编辑 / 校验三条路共用同一份实现。
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');

  const helper = main.slice(main.indexOf('function runPageScript'),
    main.indexOf('function runPageScript') + 700);
  assert.ok(/executeJavaScript/.test(helper), '仍要真的执行脚本');
  assert.ok(/Promise\.race/.test(helper), '必须用 Promise.race 兜一个超时');
  assert.ok(/页面响应超时/.test(helper), '超时要给看得懂的错误');
  assert.ok(/clearTimeout/.test(helper), '计时器要清掉，否则进程拖着不退出');

  const start = main.indexOf("ipcMain.handle('browser:eval'");
  assert.ok(start > 0, '应能找到 browser:eval');
  const body = main.slice(start, start + 700);
  assert.ok(/runPageScript\(/.test(body), 'browser:eval 必须走带超时的实现');
  assert.ok(/timeoutMs/.test(body), '超时时间要能由调用方指定');

  const calls = (main.match(/runPageScript\(/g) || []).length;
  assert.ok(calls >= 3, `发布、编辑、校验三条路都该走 runPageScript，实际 ${calls} 处`);

  const pub = fs.readFileSync(path.join(root, 'src/renderer/publish.js'), 'utf8');
  assert.ok(/evalInPage\(code,\s*timeoutMs\s*\|\|\s*8000\)/.test(pub),
    'evalPage 要把超时传下去');
  assert.ok(/pageReadCheck',\s*undefined,\s*3000/.test(pub),
    '轮询本身要用更短的超时，一个周期内必须回来');
});

maybe('点下去页面里立刻出现「正在提交」，不用等宿主轮询', () => {
  // 宿主顶栏那条最少要等一拍轮询（1.2 秒）才亮，而作者点完视线还在按钮上 ——
  // 这一拍的空档就是「点了没反应」。所以在站点页面里直接画一条。
  const p = makePage();
  p.click('dosubmit');

  const tip = p.w.document.getElementById('__wbCheckToast');
  assert.ok(tip, '点完必须立刻有页面内提示');
  assert.ok(/正在提交/.test(tip.textContent), `提示文案应说明在提交，实际：${tip.textContent}`);
});

maybe('结果出来后页面内提示跟着换，并带上结论', () => {
  const p = makePage();
  p.click('dosubmit');
  p.queue[0].success({ suggestion: 'pass', msg: '发布成功', url: '/book_manage/x?chapter_id=1' });

  const tip = p.w.document.getElementById('__wbCheckToast');
  assert.ok(/发布成功/.test(tip.textContent), `成功应换成成功文案，实际：${tip.textContent}`);
});

maybe('站点拒绝时，页面内提示如实带出原因', () => {
  const p = makePage();
  p.click('dosubmit');
  p.queue[0].success({ suggestion: 'error', msg: '正文不足 100 字' });

  const tip = p.w.document.getElementById('__wbCheckToast');
  assert.ok(/正文不足 100 字/.test(tip.textContent),
    `原因不能吞掉，实际：${tip.textContent}`);
});
