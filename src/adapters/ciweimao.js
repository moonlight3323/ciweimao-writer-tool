/**
 * 刺猬猫作者后台 · 页面解析适配层
 *
 * 约定：本文件中的 extract* 函数会被 toString() 序列化后送往平台页面上下文执行。
 * 因此它们**只能依赖浏览器 DOM 与该函数自身的局部变量**，不得闭包引用模块作用域。
 *
 * 站点改版时，理论上只需修改本文件。
 */
(function (root) {
  'use strict';

  /** 文本规范化 */
  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** 取元素下第一个非空文本节点（用于 h5 里的昵称、操作区里的时间） */
  function firstTextNode(el) {
    if (!el) return '';
    for (var i = 0; i < el.childNodes.length; i += 1) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && norm(n.textContent)) return norm(n.textContent);
    }
    return '';
  }

  /** 从 URL 中取查询参数 */
  function qp(url, key) {
    var m = String(url || '').match(new RegExp('[?&]' + key + '=([^&#]+)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * 提取间贴（段评）列表。
   * 结构：div#tsukkomi<ID> > ul > li > h5.mail-title + p.fold
   * 正文就在 p.fold 里（该 class 名为 fold，但并非折叠，实测即正文）。
   */
  function extractTsukkomi() {
    function normx(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

    function firstTextNodeX(el) {
      if (!el) return '';
      for (var i = 0; i < el.childNodes.length; i += 1) {
        var n = el.childNodes[i];
        if (n.nodeType === 3 && normx(n.textContent)) return normx(n.textContent);
      }
      return '';
    }

    function qpx(url, key) {
      var m = String(url || '').match(new RegExp('[?&]' + key + '=([^&#]+)'));
      return m ? decodeURIComponent(m[1]) : '';
    }

    var out = [];
    var nodes = document.querySelectorAll('div[id^="tsukkomi"]');

    for (var i = 0; i < nodes.length; i += 1) {
      var div = nodes[i];
      var id = div.id.replace(/^tsukkomi/, '');
      if (!/^\d+$/.test(id)) continue;

      var contentEl = div.querySelector('p.fold');
      var h5 = div.querySelector('h5.mail-title');
      var titleA = h5 ? h5.querySelector('a.paragraph') : null;
      var op = h5 ? h5.querySelector('span.mail-operate') : null;
      var meta = div.querySelector('ul.dropdown-menu[data-reader-id]');

      // 章节信息形如 "#书名 / 第12章 xxx / 第 42 段#"
      var titleRaw = normx(titleA ? titleA.textContent : '').replace(/^#+|#+$/g, '');
      var parts = titleRaw.split('/').map(normx);
      var bookName = parts[0] || '';
      var chapterName = parts[1] || '';
      var paraPos = parts[2] || '';

      var delA = null;
      var speakA = null;
      var topA = null;
      var links = div.querySelectorAll('a[href]');
      for (var j = 0; j < links.length; j += 1) {
        var href = links[j].getAttribute('href') || '';
        if (href.indexOf('delete_tsukkomi') >= 0) delA = links[j];
        else if (href.indexOf('speak_tsukkomi') >= 0) speakA = links[j];
        else if (href.indexOf('set_top_tsukkomi') >= 0) topA = links[j];
      }

      var delHref = delA ? delA.href : '';
      var speakHref = speakA ? speakA.href : '';

      out.push({
        id: 'tsukkomi:' + id,
        platformId: id,
        kind: 'tsukkomi',
        content: normx(contentEl ? contentEl.textContent : ''),
        nickname: firstTextNodeX(h5),
        time: firstTextNodeX(op),
        bookName: bookName,
        chapterName: chapterName,
        paraPos: paraPos,
        chapterId: qpx(titleA ? titleA.href : '', 'chapter_id') || qpx(delHref, 'chapter_id'),
        bookId: qpx(delHref, 'book_id'),
        readerId: meta ? (meta.getAttribute('data-reader-id') || '') : qpx(speakHref, 'speak'),
        isTop: !!div.querySelector('a[href*="set_top_tsukkomi"]') && normx(div.textContent).indexOf('取消置顶') >= 0,
        actions: { delete: delHref, speak: speakHref, top: topA ? topA.href : '' },
      });
    }
    return out;
  }

  /** 提取分页信息：当前页 / 末页 / 总条数提示 */
  function extractPager() {
    function normx(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
    var res = { current: 1, total: 1, hasNext: false };

    var cur = document.querySelector('.pagination .active a, .pagination li.active a');
    if (cur && /^\d+$/.test(normx(cur.textContent))) res.current = parseInt(normx(cur.textContent), 10);

    var best = 1;
    var anchors = document.querySelectorAll('a[href*="page="]');
    for (var i = 0; i < anchors.length; i += 1) {
      var m = (anchors[i].getAttribute('href') || '').match(/[?&]page=(\d+)/);
      if (m) {
        var p = parseInt(m[1], 10);
        if (p > best) best = p;
      }
    }
    res.total = best;
    res.hasNext = res.current < best;
    return res;
  }

  /**
   * 提取普通书评（作品评论区）。
   *
   * 作者后台的书评与间贴都以 h5.mail-title 为标题节点，但书评页的
   * 外层 id 不始终稳定。因此先用标题节点定位，再从操作链接里取评论/读者编号。
   * 返回字段与 extractTsukkomi 对齐，让审查引擎能同时处理两种评论。
   */
  function extractReview() {
    function normx(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
    function qpx(url, key) {
      var m = String(url || '').match(new RegExp('[?&]' + key + '=([^&#]+)'));
      return m ? decodeURIComponent(m[1]) : '';
    }
    function firstText(el) {
      if (!el) return '';
      for (var n = 0; n < el.childNodes.length; n += 1) {
        if (el.childNodes[n].nodeType === 3 && normx(el.childNodes[n].textContent)) {
          return normx(el.childNodes[n].textContent);
        }
      }
      return '';
    }
    var out = [];
    var titles = document.querySelectorAll('h5.mail-title');
    for (var i = 0; i < titles.length; i += 1) {
      var h5 = titles[i];
      var scope = h5.closest('li') || h5.parentElement || h5;
      var contentEl = scope.querySelector('p.fold, .review-content, .reply-content, p');
      if (!contentEl) {
        var sib = h5.nextElementSibling;
        while (sib && !normx(sib.textContent)) sib = sib.nextElementSibling;
        contentEl = sib;
      }
      var content = normx(contentEl ? contentEl.textContent : '');
      if (!content) continue;

      var links = scope.querySelectorAll('a[href]');
      var reviewId = '';
      var readerId = '';
      var bookId = '';
      var actions = { delete: '', speak: '', top: '', hide: '', transparent: false };
      for (var j = 0; j < links.length; j += 1) {
        var href = links[j].href || links[j].getAttribute('href') || '';
        var text = normx(links[j].textContent);
        reviewId = reviewId || qpx(href, 'review_id') || qpx(href, 'id');
        readerId = readerId || qpx(href, 'speak') || qpx(href, 'reader_id');
        bookId = bookId || qpx(href, 'book_id');
        if (/\u53d6\u6d88\u7f6e\u9876|\u7f6e\u9876/.test(text)) actions.top = href;
        else if (/\u5220\u9664|\u79fb\u9664/.test(text)) actions.delete = href;
        else if (/\u7981\u8a00|\u89e3\u7981/.test(text)) actions.speak = href;
        else if (/\u9690\u85cf|\u5c4f\u853d/.test(text)) actions.hide = href;
        else if (/\u900f\u660e/.test(text)) actions.transparent = true;
      }
      var meta = scope.querySelector('[data-reader-id]');
      readerId = readerId || (meta ? meta.getAttribute('data-reader-id') : '');
      var op = h5.querySelector('span.mail-operate');
      var rawId = reviewId || (readerId + ':' + content.slice(0, 40)) || String(i + 1);
      out.push({
        id: 'review:' + rawId,
        platformId: reviewId,
        kind: 'review',
        content: content.slice(0, 4000),
        nickname: firstText(h5) || normx(h5.textContent).split(' ')[0],
        time: firstText(op),
        bookId: bookId,
        bookName: '',
        chapterName: '',
        paraPos: '',
        chapterId: '',
        readerId: readerId,
        isTop: /\u53d6\u6d88\u7f6e\u9876/.test(normx(scope.textContent)),
        actions: actions,
      });
    }
    return out;
  }

  /** 以后台读者管理的查询表单只读查询粉丝值。 */
  async function queryFanValue(args) {
    function normx(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
    var o = args || {};
    var nickname = String(o.nickname || '').trim();
    if (!nickname) return { ok: false, error: '缺少读者昵称' };
    var body = new URLSearchParams();
    body.set('subItem', 'all');
    body.set('book_id', String(o.bookId || ''));
    body.set('content', nickname);
    body.set('select_book', '查看');
    body.set('condition', 'on');
    body.set('tabType', 'fans');
    var res = await fetch('/review_manage/manage_reader', {
      method: 'POST', credentials: 'include', body: body,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    var html = await res.text();
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var levelEl = doc.querySelector('.reader-info p.level');
    var fanEl = doc.querySelector('.info-box.fans');
    var text = normx(fanEl ? fanEl.textContent : '');
    var m = text.replace(/,/g, '').match(/([\d.]+)\s*(\u4e07)?/);
    var value = null;
    if (m) value = Math.round(parseFloat(m[1]) * (m[2] ? 10000 : 1));
    return {
      ok: !!fanEl,
      status: res.status,
      value: value,
      fansText: text,
      level: normx(levelEl ? levelEl.textContent : ''),
    };
  }

  /** 提取作品列表（book_manage/view_list） */
  function extractBooks() {
    function normx(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
    var out = [];
    var rows = document.querySelectorAll('table tr');
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var links = row.querySelectorAll('a[href*="book_id="]');
      if (!links.length) continue;
      var bookId = '';
      for (var j = 0; j < links.length; j += 1) {
        var m = (links[j].getAttribute('href') || '').match(/book_id=(\d+)/);
        if (m) { bookId = m[1]; break; }
      }
      if (!bookId) continue;
      var cells = row.querySelectorAll('td');
      var texts = [];
      for (var k = 0; k < cells.length; k += 1) texts.push(normx(cells[k].innerText));
      out.push({ bookId: bookId, cells: texts });
    }
    return out;
  }

  /** 提取左侧作品下拉框（各功能页通用） */
  function extractBookOptions() {
    var sel = document.querySelector('select');
    var out = [];
    if (!sel) return out;
    var opts = sel.querySelectorAll('option');
    for (var i = 0; i < opts.length; i += 1) {
      var v = opts[i].getAttribute('value') || '';
      if (/^\d{6,}$/.test(v)) out.push({ bookId: v, name: opts[i].textContent.trim() });
    }
    return out;
  }

  /**
   * 作品列表指标：/book_manage/view_list
   * 每行 td 结构：[0]复选框 [1]封面+总收藏 [2]书名 [3]编辑 [4]总字数 [5]最新章节 [6]状态 [7]操作
   */
  function extractBookStats() {
    function num(s) {
      var m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\d+/);
      return m ? parseInt(m[0], 10) : null;
    }
    var out = [];
    var rows = document.querySelectorAll('table tbody tr');
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var cb = row.querySelector('input[data-id]');
      var bookId = cb ? cb.getAttribute('data-id') : '';
      if (!bookId) continue;
      var tds = row.querySelectorAll('td');
      var collectEl = row.querySelector('span.collect');
      var nameEl = tds[2] ? tds[2].querySelector('a') : null;
      out.push({
        bookId: bookId,
        name: nameEl ? nameEl.textContent.trim() : (tds[2] ? tds[2].textContent.trim() : ''),
        collects: collectEl ? num(collectEl.textContent) : null,
        words: tds[4] ? num(tds[4].textContent) : null,
        latestChapter: tds[5] ? tds[5].textContent.replace(/\s+/g, ' ').trim() : '',
        status: tds[6] ? tds[6].textContent.trim() : '',
      });
    }
    return out;
  }

  /**
   * 订阅指标：/money_manage/view_buy_new?book_id=X
   * .subscribe-msg .msg-box 内 p 是标签、h3 是数值、.msg-compare 内 b 是比前一天
   * 总订阅在 .subscribe-chart h2
   */
  function extractSubscribeStats() {
    function normx(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
    function num(s) {
      var m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      return m ? parseFloat(m[0]) : null;
    }

    var res = {
      bookId: '',
      newSubs: null,
      newSubsPct: null,
      avgSubs: null,
      avgSubsPct: null,
      dailyChase: null,
      dailyChasePct: null,
      maxSub: null,
      maxSubChapter: '',
      totalSubs: null,
    };

    var sel = document.querySelector('select#book_id');
    if (sel) res.bookId = sel.value;

    var boxes = document.querySelectorAll('.subscribe-msg .msg-box');
    for (var i = 0; i < boxes.length; i += 1) {
      var box = boxes[i];
      var labelEl = box.querySelector('p');
      var valEl = box.querySelector('h3');
      var cmpEl = box.querySelector('.msg-compare');
      var label = normx(labelEl ? labelEl.textContent : '');
      var value = num(valEl ? valEl.textContent : '');

      var cmpB = cmpEl ? cmpEl.querySelector('b') : null;
      var cmpPct = cmpB ? num(cmpB.textContent) : null;
      var cmpDown = cmpB ? /compare-down/.test(cmpB.className || '') : false;

      if (label.indexOf('新增订阅') >= 0) {
        res.newSubs = value;
        res.newSubsPct = cmpPct;
      } else if (label.indexOf('章节均订') >= 0) {
        res.avgSubs = value;
        res.avgSubsPct = cmpPct;
      } else if (label.indexOf('日均追订') >= 0) {
        res.dailyChase = value;
        res.dailyChasePct = cmpPct;
      } else if (label.indexOf('单章最高订阅') >= 0) {
        res.maxSub = value;
        res.maxSubChapter = cmpEl ? normx(cmpEl.textContent) : '';
      }
    }

    var h2 = document.querySelector('.subscribe-chart h2');
    if (h2) res.totalSubs = num(h2.textContent);

    return res;
  }

  /**
   * 首页全勤/月更新：/homepage 的 table.msg-table
   * td：[0]书名 [1]本月截止昨日更新 [2]更新天数 [3]全勤天数 [4]缺勤天数 [5]上月半年奖 [6]半年奖总额
   */
  function extractHomeStats() {
    function normx(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
    function num(s) {
      var m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\d+/);
      return m ? parseInt(m[0], 10) : null;
    }
    var out = [];
    var table = document.querySelector('table.msg-table');
    if (!table) return out;
    var todayText = normx(document.body.innerText).match(/今天是[^星]*/);
    var rows = table.querySelectorAll('tbody tr');
    for (var i = 0; i < rows.length; i += 1) {
      var tds = rows[i].querySelectorAll('td');
      if (tds.length < 5) continue;
      out.push({
        name: normx(tds[0].textContent).replace(/[《》]/g, ''),
        monthWords: tds[1] ? normx(tds[1].textContent) : '',
        monthWordsNum: tds[1] ? num(tds[1].textContent) : null,
        updateDays: tds[2] ? num(tds[2].textContent) : null,
        fullDays: tds[3] ? normx(tds[3].textContent) : '',
        missDays: tds[4] ? num(tds[4].textContent) : null,
        platformToday: todayText ? todayText[0] : '',
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- 章节导出
  //
  // 这一组与上面的 extract* 分工不同：
  //   fetchHtml            → 在平台页面上下文执行，只负责把 HTML 取回来（自带登录态）
  //   parse*               → 纯函数，接收 HTML 文本，在渲染进程里用 DOMParser 解析
  //
  // 之所以把解析搬到渲染进程：渲染进程同样是浏览器环境，解析结果可以直接渲染到界面；
  // 而且解析函数不依赖页面上下文，改版时拿一份历史 HTML 就能离线复现与验证。
  // 解析层仍然是「站点改版只改这里」。

  /** 取回页面 HTML（在平台页面上下文执行） */
  async function fetchHtml(args) {
    var url = String((args && args.url) || '');
    var absolute = new URL(url, location.href).href;
    var res = await fetch(absolute, {
      credentials: 'include',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    var html = await res.text();
    // 后台掉登录时不是 302，而是回一段几十字节的跳转脚本（HTTP 仍是 200），
    // 只看 res.url 会把它当成「页面结构变了」，白折腾一圈。
    var needLogin = /location\.href\s*=\s*['"][^'"]*login/i.test(html)
      || (html.length < 6000 && /inputAccount|J_ChangeLoginType/.test(html));
    return { ok: res.ok, status: res.status, url: res.url, html: html, needLogin: needLogin };
  }

  /** 相对路径 → 绝对 URL；base 缺失时原样返回 */
  function absUrl(href, base) {
    try { return new URL(href, base || undefined).href; } catch (e) { return String(href || ''); }
  }

  /**
   * 取章节详情片段（在平台页面上下文执行）。
   *
   * 这是站点自己用的接口：章节列表页点了某一章后，
   * 会用 $.post 请求它，把返回的 HTML 塞进 #chapter_detail。
   * 只读语义（detail_show），不修改任何数据。
   */
  async function fetchChapterDetail(args) {
    var o = args || {};
    var body = 'book=' + encodeURIComponent(String(o.bookId || ''))
      + '&chapter=' + encodeURIComponent(String(o.chapterId || ''));
    var res = await fetch(new URL('/book_manage/get_chapter_detail_show', location.href).href, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'text/html, */*; q=0.01',
      },
      body: body,
    });
    var html = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, html: html };
  }

  var CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  /** 中文数字 → 整数（章节号量级，支持「二十三」「一百零五」） */
  function cnToInt(s) {
    var total = 0;
    var section = 0;
    var num = 0;
    for (var i = 0; i < s.length; i += 1) {
      var c = s.charAt(i);
      if (CN_DIGIT[c] != null) { num = CN_DIGIT[c]; }
      else if (c === '十') { section += (num || 1) * 10; num = 0; }
      else if (c === '百') { section += (num || 1) * 100; num = 0; }
      else if (c === '千') { section += (num || 1) * 1000; num = 0; }
      else if (c === '万') { total += (section + num) * 10000; section = 0; num = 0; }
      else return null;
    }
    return total + section + num;
  }

  /** 从章节标题里取章节序号，取不到返回 null */
  function chapterNo(title) {
    var t = String(title || '');
    var m = t.match(/第\s*(\d{1,5})\s*[章节回话]/);
    if (m) return parseInt(m[1], 10);
    m = t.match(/第\s*([零〇一二两三四五六七八九十百千万]{1,8})\s*[章节回话]/);
    if (m) {
      var n = cnToInt(m[1]);
      if (n != null) return n;
    }
    return null;
  }

  var ACTION_WORD = /^(编辑|修改|删除|查看|预览|复制|下架|置顶|取消置顶|发布|撤回|详情|操作|章纲|设置)$/;
  var STATUS_WORD = /^(已发布|草稿|未发布|审核中|定时发布|已下架|待审核|已锁定)$/;

  /**
   * 解析章节列表页。
   * @param {string} html  /book_manage/view_chapter_info 的 HTML
   * @param {string} baseUrl 该页的最终 URL（用于把相对链接转成绝对链接）
   * @returns {{chapters:Array, maxPage:number, pageLinks:Object, hint:string, docTitle:string}}
   */
  function parseChapterList(html, baseUrl) {
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var base = baseUrl || '';
    var chapters = [];
    var byId = {};

    function normText(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

    // ── A. 实际结构（2026-11-05 用真实页面核对过）────────────────────
    // 章节号挂在 li 的 chapter 属性上，链接是 javascript:;，
    // 所以「按链接里的 chapter_id 找」在本页永远找不到东西。
    //   <li class="chapter_detail_show" chapter="110207757" book="100358490" division="100617654">
    //     <a href="javascript:;"><p>第95章 标题</p><span class="label"></span>
    //       <h5>共2117字<span>2023-04-19 04:15:46</span></h5></a></li>
    var attrNodes = doc.querySelectorAll('li[chapter]');
    for (var n = 0; n < attrNodes.length; n += 1) {
      var node = attrNodes[n];
      var cid = String(node.getAttribute('chapter') || '').trim();
      if (!/^\d+$/.test(cid) || byId[cid]) continue;

      var pEl = node.querySelector('p');
      var h5El = node.querySelector('h5');
      var labelEl = node.querySelector('span.label');
      var rawTitle = normText(pEl ? pEl.textContent : node.textContent);
      // 没有 p 时整段会带出「共2117字 时间」，按「共」截断
      if (!pEl) {
        var cutIdx = rawTitle.indexOf('共');
        if (cutIdx > 0) rawTitle = rawTitle.slice(0, cutIdx).trim();
      }

      var h5Text = normText(h5El ? h5El.textContent : '');
      var wmA = h5Text.match(/([\d,]{1,9})\s*字/);
      var timeEl = h5El ? h5El.querySelector('span') : null;

      // 所属卷名（多卷本导出时用于分组提示）
      var volName = '';
      var volLi = node.parentNode;
      var guard = 0;
      while (volLi && volLi.nodeType === 1 && guard < 8
             && String(volLi.className || '').indexOf('submenu') < 0) {
        volLi = volLi.parentNode;
        guard += 1;
      }
      if (volLi && volLi.nodeType === 1) {
        var va = volLi.querySelector('a.division_show');
        if (va && va.firstChild && va.firstChild.nodeType === 3) {
          volName = normText(va.firstChild.textContent);
        }
      }

      byId[cid] = true;
      chapters.push({
        chapterId: cid,
        title: rawTitle || ('第 ' + cid + ' 章'),
        words: wmA ? parseInt(wmA[1].replace(/,/g, ''), 10) : null,
        status: normText(labelEl ? labelEl.textContent : ''),
        time: normText(timeEl ? timeEl.textContent : ''),
        volume: volName,
        url: '',
        seq: null,
      });
    }

    // ── B. 兜底：别的页面形态，链接里带 chapter_id ─────────────────
    var rows = doc.querySelectorAll('tr, li');

    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var links = row.querySelectorAll('a[href]');
      var picked = null;
      var pickedLen = -1;

      for (var j = 0; j < links.length; j += 1) {
        var a = links[j];
        var href = a.getAttribute('href') || '';
        var m = href.match(/chapter_id=(\d+)/);
        if (!m) continue;
        var txt = String(a.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt.length > pickedLen) {
          pickedLen = txt.length;
          // 只用「看」的链接：动作类链接即使只 GET 也可能改状态，一律不碰
          picked = { id: m[1], text: txt, href: href };
        }
      }
      if (!picked) continue;
      if (byId[picked.id]) continue;
      byId[picked.id] = true;

      var titleText = picked.text;
      var cells = row.querySelectorAll('td');
      var cellTexts = [];
      for (var c = 0; c < cells.length; c += 1) {
        cellTexts.push(String(cells[c].textContent || '').replace(/\s+/g, ' ').trim());
      }

      // 最长链接就是「编辑」这类动作词时，标题改从单元格里找
      if (!titleText || ACTION_WORD.test(titleText)) {
        titleText = '';
        for (var c2 = 0; c2 < cellTexts.length; c2 += 1) {
          var ct = cellTexts[c2];
          if (!ct || ct.length < 2) continue;
          if (/^[\d,.\s]+$/.test(ct)) continue;
          if (ACTION_WORD.test(ct) || STATUS_WORD.test(ct)) continue;
          titleText = ct;
          break;
        }
      }

      var rowText = String(row.textContent || '').replace(/\s+/g, ' ').trim();
      var sm = rowText.match(/(已发布|草稿|未发布|审核中|定时发布|已下架|待审核|已锁定)/);

      var seqNo = null;
      for (var s = 0; s < cellTexts.length; s += 1) {
        if (/^\d{1,4}$/.test(cellTexts[s]) && parseInt(cellTexts[s], 10) > 0) {
          seqNo = parseInt(cellTexts[s], 10);
          break;
        }
      }

      // 字数：优先认「2340 字」这种带单位的；后台也可能只给个纯数字单元格，
      // 那就取除序号列之外最大的那个纯数字。
      var wm = rowText.match(/([\d,]{1,9})\s*字/);
      var words = wm ? parseInt(wm[1].replace(/,/g, ''), 10) : null;
      if (words == null) {
        for (var s2 = 0; s2 < cellTexts.length; s2 += 1) {
          var ctv = cellTexts[s2].replace(/,/g, '');
          if (!/^\d{1,9}$/.test(ctv)) continue;
          var nv = parseInt(ctv, 10);
          if (nv === seqNo) continue;
          if (words == null || nv > words) words = nv;
        }
      }

      // 只信任明确安全的后台路径，其余一律由调用方按 book_id + chapter_id 重新拼
      var editUrl = '';
      var rawHref = picked.href;
      if (/\/book_manage\/(draft|mod_chapter|chapter_info|view_chapter)/i.test(rawHref)
        && !/delete|del_|remove|drop|top_|speak|ban|blacklist|publish|submit|off_|down_/i.test(rawHref)) {
        editUrl = absUrl(rawHref, base);
      }

      chapters.push({
        chapterId: picked.id,
        title: titleText || ('第 ' + picked.id + ' 章'),
        words: words,
        status: sm ? sm[1] : '',
        url: editUrl,
        seq: seqNo,
      });
    }

    // 后台可能按更新时间倒序排列，正文要按章节顺序导出
    if (chapters.length > 1) {
      var last = chapters.length - 1;
      var n1 = chapterNo(chapters[0].title);
      var n2 = chapterNo(chapters[last].title);
      var desc = false;
      if (n1 != null && n2 != null) desc = n1 > n2;
      else if (chapters[0].seq != null && chapters[last].seq != null) desc = chapters[0].seq > chapters[last].seq;
      if (desc) chapters.reverse();
    }
    for (var k = 0; k < chapters.length; k += 1) chapters[k].index = k + 1;

    // 分页：优先用页面自己生成的链接，避免猜 URL 规则
    var maxPage = 1;
    var pageLinks = {};
    var anchors = doc.querySelectorAll('a[href]');
    for (var p = 0; p < anchors.length; p += 1) {
      var ph = anchors[p].getAttribute('href') || '';
      var pm = ph.match(/[?&]page=(\d+)/);
      if (!pm) continue;
      var pn = parseInt(pm[1], 10);
      if (pn > maxPage) maxPage = pn;
      if (pn >= 2) pageLinks[pn] = absUrl(ph, base);
    }
    // 少数页面用下拉框跳页。判据要严：页面上还有「删除理由」这类
    // 只有 5 个数字选项的下拉框，放宽了就会把它当成 4 页。
    var selects = doc.querySelectorAll('select');
    for (var q = 0; q < selects.length; q += 1) {
      var sid = (String(selects[q].id || '') + ' '
        + String(selects[q].getAttribute('name') || '') + ' '
        + String(selects[q].className || '')).toLowerCase();
      var opts = selects[q].querySelectorAll('option');
      var nums = [];
      for (var r = 0; r < opts.length; r += 1) {
        var ov = String(opts[r].getAttribute('value') || '').trim();
        if (/^\d+$/.test(ov)) nums.push(parseInt(ov, 10));
      }
      // 名字像页码，或者选项多到只有分页才可能，才认
      if (!/page|pag/.test(sid) && nums.length < 8) continue;
      for (var r2 = 0; r2 < nums.length; r2 += 1) {
        if (nums[r2] > maxPage && nums[r2] < 5000) maxPage = nums[r2];
      }
    }

    var bodyText = String((doc.body && doc.body.textContent) || '');
    var hint = '';
    // 列表页标题形如「共1卷，97章」
    var hm = bodyText.match(/共\s*(\d+)\s*卷\s*[，,]?\s*(\d+)\s*章/);
    if (hm) hint = '共 ' + hm[1] + ' 卷 ' + hm[2] + ' 章';
    else {
      hm = bodyText.match(/共\s*(\d+)\s*(章|条)/);
      if (hm) hint = '共 ' + hm[1] + ' ' + hm[2];
    }

    // 页面上当前作品号：老页面是 select，章节列表页是隐藏域 show_book_id
    var pageBookId = '';
    var bookInput = doc.querySelector('input[name="show_book_id"], input#show_book_id, input[name="book_id"]');
    if (bookInput) {
      var bv = String(bookInput.value || '');
      if (/^\d{5,}$/.test(bv)) pageBookId = bv;
    }
    if (!pageBookId) {
      var sels = doc.querySelectorAll('select');
      for (var b = 0; b < sels.length; b += 1) {
        var sid = String(sels[b].id || '') + ' ' + String(sels[b].getAttribute('name') || '');
        if (!/book/i.test(sid)) continue;
        var sv = String(sels[b].value || '');
        if (/^\d{5,}$/.test(sv)) { pageBookId = sv; break; }
      }
    }

    return {
      chapters: chapters,
      maxPage: maxPage,
      pageLinks: pageLinks,
      hint: hint,
      pageBookId: pageBookId,
      docTitle: doc.title || '',
    };
  }

  /** 解析作品清单，来源可以是作品列表页，也可以是任意带作品下拉框的后台页 */
  function parseBookList(html, baseUrl) {
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var out = [];
    var seen = {};

    function push(id, name, cover) {
      if (!id || !/^\d{5,}$/.test(id)) return;
      if (seen[id]) return;
      var nm = String(name || '').replace(/[《》]/g, '').replace(/\s+/g, ' ').trim();
      if (!nm) nm = id;
      seen[id] = true;
      out.push({ bookId: id, name: nm, cover: cover || '' });
    }

    /** 从一行里挑出封面图：优先懒加载属性，排除图标类资源，相对路径补成绝对 */
    function pickCover(row) {
      var imgs = row.querySelectorAll('img');
      for (var n = 0; n < imgs.length; n += 1) {
        var raw = String(
          imgs[n].getAttribute('data-src')
          || imgs[n].getAttribute('data-original')
          || imgs[n].getAttribute('src')
          || ''
        ).trim();
        if (!raw) continue;
        if (/icon|logo|avatar|sprite|blank\.|spacer/i.test(raw)) continue;
        if (/^data:/i.test(raw)) continue;
        if (!/^(https?:)?\/\//i.test(raw)) {
          try {
            raw = new URL(raw, baseUrl || location.href).href;
          } catch (_) {
            continue;
          }
        } else if (raw.indexOf('//') === 0) {
          raw = 'https:' + raw;
        }
        return raw;
      }
      return '';
    }

    var rows = doc.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var cb = row.querySelector('input[data-id]');
      var id = cb ? String(cb.getAttribute('data-id') || '') : '';
      if (!id) {
        var links0 = row.querySelectorAll('a[href*="book_id="]');
        for (var j = 0; j < links0.length; j += 1) {
          var m0 = String(links0[j].getAttribute('href') || '').match(/book_id=(\d{5,})/);
          if (m0) { id = m0[1]; break; }
        }
      }
      if (!id) continue;

      var name = '';
      var links = row.querySelectorAll('a[href]');
      for (var k = 0; k < links.length; k += 1) {
        var t = String(links[k].textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > name.length && !ACTION_WORD.test(t)) name = t;
      }
      if (!name) {
        var cells = row.querySelectorAll('td');
        for (var c = 0; c < cells.length; c += 1) {
          var ct = String(cells[c].textContent || '').replace(/\s+/g, ' ').trim();
          if (ct.length >= 2 && !/^[\d,.]+$/.test(ct)) { name = ct; break; }
        }
      }
      push(id, name, pickCover(row));
    }

    // 下拉框兜底：几乎所有功能页左上角都有作品选择
    var opts = doc.querySelectorAll('option');
    for (var o = 0; o < opts.length; o += 1) {
      var v = String(opts[o].getAttribute('value') || '').trim();
      if (/^\d{5,}$/.test(v)) push(v, opts[o].textContent);
    }

    return out;
  }

  /** 把编辑器里的内容还原成纯文本：br/p 转换行，标签剥离，实体解码 */
  function toPlainText(raw) {
    var s = String(raw == null ? '' : raw);
    if (!s.trim()) return '';
    if (!/<[a-z!\/][^>]*>/i.test(s)) {
      return s.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
    }
    var wrapped = '<div id="__cw_root">' + s.replace(/<br\s*\/?>/gi, '\n') + '</div>';
    var doc = new DOMParser().parseFromString(wrapped, 'text/html');
    var root = doc.getElementById('__cw_root');
    if (!root) return '';
    var blocks = root.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,blockquote,section,article');
    for (var i = 0; i < blocks.length; i += 1) {
      blocks[i].appendChild(doc.createTextNode('\n'));
    }
    var text = String(root.textContent || '');
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 从一段没有语义标记的 HTML 里挑出「正文容器」。
   *
   * 章节详情片段不带 textarea，也没法预知它用什么 class，只能按文本量收窄：
   * 从 body 开始，每层挑文本量最大、且仍占父级一半以上的那个子元素，一路往下走。
   *
   * 关键限制：**只往「还有子元素」的节点里走**。
   * 否则两段正文里较长的那一段会被单独挑中，导出时只剩第一段——
   * 段落是叶子节点，走到它就说明已经到位了。
   */
  function dominantBlock(doc) {
    var best = doc.body || doc.documentElement;
    if (!best) return null;

    for (var depth = 0; depth < 14; depth += 1) {
      var kids = best.children || [];
      var curLen = String(best.textContent || '').trim().length;
      var pick = null;
      var pickLen = 0;
      for (var i = 0; i < kids.length; i += 1) {
        if (!kids[i].children || kids[i].children.length < 1) continue;
        var len = String(kids[i].textContent || '').trim().length;
        if (len > curLen * 0.5 && len > pickLen) { pick = kids[i]; pickLen = len; }
      }
      if (!pick) break;
      best = pick;
    }

    var junk = best.querySelectorAll('script, style, button, .btn, .label, .operate, .pagination');
    for (var j = 0; j < junk.length; j += 1) {
      if (junk[j].parentNode) junk[j].parentNode.removeChild(junk[j]);
    }
    return best;
  }

  /**
   * 解析章节编辑页 / 章节详情片段，取出标题与正文。
   * 兼容四种形态：单 textarea、同名多 textarea 分段、contenteditable 富文本、
   * 以及完全没有编辑控件、正文散落在普通 div 里的详情片段。
   * @param {string} html
   * @param {Object} opts { fallbackTitle }
   */
  function parseChapterContent(html, opts) {
    var o = opts || {};
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var res = { title: '', content: '', note: '', fields: [], needLogin: false, docTitle: doc.title || '' };

    var docTitle = String(doc.title || '');
    if (/登录/.test(docTitle) && doc.querySelector('#login-form, .login-form, form[action*="login"]')) {
      res.needLogin = true;
      return res;
    }

    // 标题
    var inputs = doc.querySelectorAll('input[name], input[id]');
    var loose = '';
    for (var i = 0; i < inputs.length; i += 1) {
      var el = inputs[i];
      var tag = String(el.getAttribute('name') || '') + ' ' + String(el.id || '');
      var v = String(el.value || '').replace(/\s+/g, ' ').trim();
      if (!v || v.length > 120) continue;
      if (/chapter_?name|chapter_?title|chaptertitle|chaptername/i.test(tag)) { res.title = v; break; }
      if (!loose && /\b(title|name)\b/i.test(tag)) loose = v;
    }
    if (!res.title) res.title = loose || String(o.fallbackTitle || '');

    // 正文候选：textarea 优先
    var areas = [];
    var tas = doc.querySelectorAll('textarea');
    for (var t = 0; t < tas.length; t += 1) {
      var ta = tas[t];
      var val = ta.value == null ? ta.textContent : ta.value;
      val = String(val == null ? '' : val);
      areas.push({
        name: String(ta.getAttribute('name') || ''),
        id: String(ta.id || ''),
        len: val.length,
        value: val,
        order: t,
      });
    }
    res.fields = areas.map(function (a) { return { name: a.name, id: a.id, len: a.len }; });

    var NOTE_RE = /(note|remark|say|speak|author_?word|afterword)/i;
    var BODY_RE = /(content|chapter|body|text|para|section|article|zhengwen|main)/i;

    var isNote = function (a) { return NOTE_RE.test(a.name + ' ' + a.id); };
    var withText = areas.filter(function (a) { return a.len > 0 && a.value.trim(); });

    var notes = withText.filter(isNote).sort(function (a, b) { return b.len - a.len; });
    if (notes.length) res.note = toPlainText(notes[0].value);

    var bodyFields = withText.filter(function (a) { return !isNote(a) && BODY_RE.test(a.name + ' ' + a.id); });
    if (!bodyFields.length) bodyFields = withText.filter(function (a) { return !isNote(a); });
    if (!bodyFields.length) bodyFields = withText.slice();

    bodyFields.sort(function (a, b) { return b.len - a.len; });

    var content = '';
    if (bodyFields.length) {
      var top = bodyFields[0];
      var same = bodyFields.filter(function (a) { return a.name && a.name === top.name; });
      if (same.length > 1 && same.length === bodyFields.length) {
        // 一段一个 textarea 的分段式编辑器，按 DOM 顺序拼回去
        same.sort(function (a, b) { return a.order - b.order; });
        content = same.map(function (a) { return a.value; }).join('\n\n');
      } else {
        content = top.value;
      }
    }

    // 富文本编辑器：正文不在 textarea 里
    var hasEditorField = areas.length > 0;
    if (!String(content).trim()) {
      var eds = doc.querySelectorAll('[contenteditable="true"], [contenteditable=""], .edui-body, .ProseMirror, .ql-editor');
      var best = null;
      var bestLen = 0;
      for (var e = 0; e < eds.length; e += 1) {
        var txt = String(eds[e].textContent || '').trim();
        if (txt.length > bestLen) { bestLen = txt.length; best = eds[e]; }
      }
      if (best && bestLen > 0) content = best.innerHTML || best.textContent;
    }

    // 详情片段：没有任何编辑控件，正文是普通 DOM
    if (!String(content).trim() && !hasEditorField) {
      var block = dominantBlock(doc);
      if (block) content = block.innerHTML || block.textContent;
    }

    res.content = toPlainText(content);
    return res;
  }

  // ---------------------------------------------------------------- 登录页
  //
  // 登录页实测结构（/login）：
  //   #login-form > .J_ChangeLoginType > li[data-type=account|email]
  //   账号页签：#inputAccount(name=account) + #inputAccountPasswd(name=account-passwd)
  //   邮箱页签：#inputEmail(name=email)     + #inputPasswd(name=passwd)
  // 两个页签是同一张表单，靠 .hide 切换，所以填之前必须先切到对应页签。
  //
  // 这两个函数在平台页面上下文执行，凭据由主进程直接注入，不经过应用界面。

  function _loginFieldShown(el) {
    if (!el) return false;
    var st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return (r.width > 0 || r.height > 0) && st.opacity !== '0';
  }

  /** 只填入，不提交：极验拖动必须本人完成，自动提交还会白白消耗试错次数 */
  async function fillLoginForm(args) {
    var o = args || {};
    var mode = o.mode === 'email' ? 'email' : 'account';

    function shown(el) {
      if (!el) return false;
      var st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      var r = el.getBoundingClientRect();
      return (r.width > 0 || r.height > 0) && st.opacity !== '0';
    }

    function setVal(el, v) {
      if (!el) return false;
      var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    /*
     * 1) 切到对应登录方式：直接改 class，不调用站点页签的 click()。
     *
     * 实测（2026-11）点页签会阻塞页面 JS：click() 里的站点逻辑一执行，
     * executeJavaScript 就再也不 resolve，界面一直停在「填入中」直到超时。
     * 两个页签本来就是同一张表单，靠 .type-account / .type-email 的 hide 类
     * 切换；这里按同样结构直接切，效果一致且不会触发站点那段逻辑。
     */
    var wantEmail = mode === 'email';
    /*
     * 注意页面上 .type-account / .type-email 各有多个节点（账号、密码是
     * 两个独立的 form-group），只改第一个会把密码那一组留在 hide 里，
     * 结果账号填上了、密码框还是空的。这里必须全部一起切。
     */
    var accountPanes = document.querySelectorAll('.type-account');
    var emailPanes = document.querySelectorAll('.type-email');
    var i;
    for (i = 0; i < accountPanes.length; i += 1) accountPanes[i].classList.toggle('hide', wantEmail);
    for (i = 0; i < emailPanes.length; i += 1) emailPanes[i].classList.toggle('hide', !wantEmail);
    var accountTab = document.querySelector('.J_ChangeLoginType li[data-type="account"]');
    var emailTab = document.querySelector('.J_ChangeLoginType li[data-type="email"]');
    if (accountTab) accountTab.classList.toggle('active', !wantEmail);
    if (emailTab) emailTab.classList.toggle('active', wantEmail);
    var typeInput = document.getElementById('author_login_type');
    if (typeInput) typeInput.value = wantEmail ? 'email' : 'account';

    // 2) 定位输入框：已知 id → name → 当前可见的第一个同类输入框
    function pick(ids, names, type) {
      var a;
      var b;
      var c;
      for (a = 0; a < ids.length; a += 1) {
        var el = document.getElementById(ids[a]);
        if (el && shown(el)) return el;
      }
      for (b = 0; b < names.length; b += 1) {
        var list = document.querySelectorAll('input[name="' + names[b] + '"]');
        for (c = 0; c < list.length; c += 1) if (shown(list[c])) return list[c];
      }
      var all = document.querySelectorAll('input[type="' + type + '"]');
      for (c = 0; c < all.length; c += 1) if (shown(all[c])) return all[c];
      return null;
    }

    var userEl = mode === 'email'
      ? pick(['inputEmail'], ['email'], 'text')
      : pick(['inputAccount'], ['account'], 'text');
    var passEl = mode === 'email'
      ? pick(['inputPasswd'], ['passwd'], 'password')
      : pick(['inputAccountPasswd'], ['account-passwd'], 'password');

    var okUser = setVal(userEl, String(o.username || ''));
    var okPass = setVal(passEl, String(o.password || ''));
    if (passEl) { try { passEl.focus(); } catch (e) { /* ignore */ } }

    return {
      ok: okUser && okPass,
      mode: mode,
      filledUser: okUser,
      filledPass: okPass,
    };
  }

  /**
   * 读出登录页当前输入的内容（供主进程直接加密保存）。
   * 返回值只送到主进程，不进应用界面。
   */
  function readLoginForm() {
    function shown(el) {
      if (!el) return false;
      var st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      var r = el.getBoundingClientRect();
      return (r.width > 0 || r.height > 0) && st.opacity !== '0';
    }

    // 以「哪个账号框可见」为准，比 active class 更可靠
    var mode = 'account';
    var emailBox = document.getElementById('inputEmail');
    if (emailBox && shown(emailBox)) mode = 'email';

    var u = document.getElementById(mode === 'email' ? 'inputEmail' : 'inputAccount');
    var p = document.getElementById(mode === 'email' ? 'inputPasswd' : 'inputAccountPasswd');

    return {
      mode: mode,
      username: u ? String(u.value || '').trim() : '',
      password: p ? String(p.value || '') : '',
    };
  }

  // ============================================================ 执行动作
  //
  // 这一段的函数会带着 payload 被注入平台页面执行，因此同样不能引用模块作用域。
  //
  // 安全铁律：
  // 1. 只允许 review_manage 下的三个动作路径，else 一律拒绝；
  // 2. 编号必须是纯数字，URL 由数字拼装，杜绝把任意地址塞进来；
  // 3. 只发「删一条 / 禁言一个人」的最小请求，不做批量循环——
  //    批量由界面逐条驱动，任何一条失败都能立刻停下。

  /** 站内表单式请求：与页面自己提交表单等价，自带 cookie 与 referer */
  function execPost(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body,
      redirect: 'follow',
    }).then(function (r) {
      return r.text().then(function (html) {
        return { ok: r.ok, status: r.status, url: r.url, html: html };
      });
    });
  }

  function execGet(path) {
    return fetch(path, { credentials: 'same-origin', redirect: 'follow' })
      .then(function (r) {
        return r.text().then(function (html) {
          return { ok: r.ok, status: r.status, url: r.url, html: html };
        });
      });
  }

  /**
   * 响应是不是被重定向到了登录页。
   *
   * 这一条必须查：登录态过期时，删除请求会 302 到 /login，
   * 登录页里当然找不到这条间贴——不查就会把「没登录」误判成「删成功」。
   */
  function isLoginResponse(url, html) {
    if (/\/login(\/|$|\?)/i.test(String(url || ''))) return true;
    var h = String(html || '');
    return /id=["']inputAccount["']/.test(h) || /J_ChangeLoginType/.test(h);
  }

  /** 页面里是否还存在这条间贴（删除是否真的生效） */
  function hasTsukkomi(html, id) {
    return new RegExp('id=["\']?tsukkomi' + id + '["\'\\s>]').test(String(html || ''));
  }

  /**
   * 删除一条间贴。
   * 表单结构来自真实页面：
   *   <form action="/review_manage/delete_tsukkomi?book_id=&page=&chapter_id=" method="post">
   *     <input name="tsukkomi_id[]" value="...">
   */
  function execDeleteTsukkomi(payload) {
    var p = payload || {};
    var id = String(p.tsukkomiId || '');
    var bookId = String(p.bookId || '');
    var chapterId = String(p.chapterId || '0') || '0';
    if (!/^\d{3,}$/.test(id)) return Promise.resolve({ ok: false, error: '间贴编号不合法，已中止' });
    if (!/^\d+$/.test(bookId)) return Promise.resolve({ ok: false, error: '作品编号不合法，已中止' });
    if (!/^\d+$/.test(chapterId)) chapterId = '0';

    var path = '/review_manage/delete_tsukkomi?book_id=' + bookId
      + '&page=1&chapter_id=' + chapterId;

    return execPost(path, 'tsukkomi_id[]=' + encodeURIComponent(id))
      .then(function (r) {
        if (isLoginResponse(r.url, r.html)) {
          return { ok: false, needLogin: true, status: r.status, error: '登录态已失效，删除没有执行' };
        }
        var still = hasTsukkomi(r.html, id);
        return {
          ok: r.ok && !still,
          status: r.status,
          stillThere: still,
          bytes: r.html.length,
          note: still ? '请求已完成，但页面上仍能找到这条间贴' : '请求已完成，列表里已不存在这条间贴',
        };
      })
      .catch(function (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      });
  }

  /**
   * 禁言读者。
   * 真实链接：/review_manage/speak_tsukkomi?speak=<读者ID>&tsukkomi_id=..&book_id=..&page=1&set_value=0&chapter_id=..
   * 站点自己的确认文案是「确定要禁止此读者在你所有作品的间贴言论吗」，
   * 也就是说它是跨作品生效的，等同拉黑。
   */
  function execMuteReader(payload) {
    var p = payload || {};
    var readerId = String(p.readerId || '');
    var tsukkomiId = String(p.tsukkomiId || '0') || '0';
    var bookId = String(p.bookId || '');
    var chapterId = String(p.chapterId || '0') || '0';
    if (!/^\d{2,}$/.test(readerId)) return Promise.resolve({ ok: false, error: '读者编号不合法，已中止' });
    if (!/^\d+$/.test(bookId)) return Promise.resolve({ ok: false, error: '作品编号不合法，已中止' });
    if (!/^\d+$/.test(chapterId)) chapterId = '0';
    if (!/^\d+$/.test(tsukkomiId)) tsukkomiId = '0';

    var path = '/review_manage/speak_tsukkomi?speak=' + readerId
      + '&tsukkomi_id=' + tsukkomiId
      + '&book_id=' + bookId
      + '&page=1&set_value=0&chapter_id=' + chapterId;

    return execGet(path)
      .then(function (r) {
        if (isLoginResponse(r.url, r.html)) {
          return { ok: false, needLogin: true, status: r.status, error: '登录态已失效，禁言没有执行' };
        }
        return { ok: r.ok && r.status < 400, status: r.status, bytes: r.html.length };
      })
      .catch(function (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      });
  }

  /** 复核：这条间贴是否还在（以章节筛选的列表为准，比全书列表可靠） */
  function verifyTsukkomi(payload) {
    var p = payload || {};
    var id = String(p.tsukkomiId || '');
    var bookId = String(p.bookId || '');
    var chapterId = String(p.chapterId || '0') || '0';
    if (!/^\d{3,}$/.test(id) || !/^\d+$/.test(bookId)) {
      return Promise.resolve({ ok: false, error: '参数不合法' });
    }
    var path = '/review_manage/manage_tsukkomi?book_id=' + bookId + '&chapter_id=' + chapterId;
    return execGet(path)
      .then(function (r) {
        if (isLoginResponse(r.url, r.html)) {
          return { ok: false, needLogin: true, present: null, status: r.status };
        }
        var present = hasTsukkomi(r.html, id);
        return { ok: r.ok, present: present, status: r.status };
      })
      .catch(function (e) { return { ok: false, present: null, error: String((e && e.message) || e) }; });
  }

  /** 复核：读者是否已进禁言回收站 */
  function verifyMuted(payload) {
    var p = payload || {};
    var readerId = String(p.readerId || '');
    if (!/^\d{2,}$/.test(readerId)) return Promise.resolve({ ok: false, error: '参数不合法' });
    return execGet('/review_manage/speak_reader')
      .then(function (r) {
        if (isLoginResponse(r.url, r.html)) {
          return { ok: false, needLogin: true, muted: null, status: r.status };
        }
        var hit = new RegExp('data-readerid=["\']?' + readerId + '["\'\\s>]').test(r.html);
        return { ok: r.ok, muted: hit, status: r.status };
      })
      .catch(function (e) { return { ok: false, muted: null, error: String((e && e.message) || e) }; });
  }

  // ============================================================ 作者信箱小红点
  //
  // 未读标记与「展开」的 DOM 都没有在真实页面上验证过（要登录），
  // 所以这里不猜接口，而是复刻人的动作：点「展开」，站点自己会把这条标成已读。
  // 扫描结果会连同整页 HTML 一起落到诊断目录，对不上时按真实结构再改。

  /**
   * 这个元素是不是「未读红点」。
   *
   * 信箱页实测结构（diagnostics/inbox-before.html + resources/css/cms_screen.css）：
   *   <p class="dot ">          已读：没有任何尺寸规则，撑满整行、高度 0
   *   <p class="dot mail-dot">  未读：7x7 红圆，.mailbox ul li .mail-dot{width:7px;…background:#f90707}
   * 站点自己的脚本判断「有红点」用的就是 hasClass("mail-dot")。
   *
   * 因此分两条路：
   *   1) 带明确未读标记（mail-dot / unread / …）→ 直接算，不看几何尺寸，
   *      免得站点哪天把它改成 display:none 又认不出来。
   *   2) 只有通用 dot 类 → 必须真渲染成小尺寸才算，避免把「已读占位」当红点。
   */
  function inboxIsDot(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'PATH' || tag === 'SVG') return false;

    var cls = '';
    if (typeof el.className === 'string') cls = el.className;
    else if (el.getAttribute) cls = el.getAttribute('class') || '';
    cls = ' ' + String(cls).replace(/[\t\n\r]+/g, ' ') + ' ';

    // 1) 明确的未读标记
    if (/(^|[\s_-])(mail-dot|unread|is-new|newmsg|new_msg|red-dot|reddot)([\s_-]|$)/i.test(cls)) return true;

    // 2) 通用 dot：按几何与颜色判定
    if (!/(^|[\s_-])dot([\s_-]|$)/i.test(cls)) return false;

    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || !r.width || !r.height) return false;
    if (r.width > 16 || r.height > 16) return false;

    var bg = '';
    try { bg = getComputedStyle(el).backgroundColor || ''; } catch (e2) { bg = ''; }
    var m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      var rr = parseInt(m[1], 10), gg = parseInt(m[2], 10), bb = parseInt(m[3], 10);
      if (rr > 150 && gg < 100 && bb < 100) return true;
    }
    return false;
  }

  function inboxDots() {
    var all = document.querySelectorAll('div, span, i, em, b, p, a, img');
    var out = [];
    for (var i = 0; i < all.length; i += 1) {
      if (inboxIsDot(all[i])) out.push(all[i]);
    }
    return out;
  }

  /** 统计某个容器里有几个「展开 / 收起」按钮 */
  function inboxExpandCount(node) {
    var candidates = node.querySelectorAll('a, button, span');
    var n = 0;
    for (var i = 0; i < candidates.length; i += 1) {
      var t = String(candidates[i].textContent || '').replace(/\s+/g, '');
      if (t === '展开' || t === '收起') n += 1;
    }
    return n;
  }

  /**
   * 取某个「展开」按钮所在的行。
   *
   * 信箱页实测结构（一行 = div > ul，里面三个 li）：
   *   li.mail-check > input.subSelect[data-id]   消息号，行的唯一标识
   *   li > img
   *   li > (p.dot[.mail-dot], h5.mail-title > a.green.open「展开」, p.content)
   *
   * ⚠️ 上一版在这里只扫 span/i/em/div 找红点，而红点是 <p class="dot">，
   * 于是永远找不到行，一路走到列表层（同层 10 个展开）才收手返回 null。
   * 连锁后果：自动模式无行可点 → 退回逐行展开 → 去重键退化成按钮小片段的文本
   * （同一时间戳的多条被判成同一条）→ 只点开两条、还都是已读的。
   *
   * 现在的判据：
   *   向上找「只含一个展开/收起按钮」的容器（到了列表层就收手）；
   *   优先返回带 [data-id] 的那一层（拿消息号当行标识，最稳）；
   *   实在没有 data-id，就退回最小的单按钮容器。
   */
  function inboxRowOf(el) {
    var node = el;
    var smallest = null;
    for (var d = 0; d < 10 && node && node.parentElement; d += 1) {
      node = node.parentElement;

      var r = null;
      try { r = node.getBoundingClientRect(); } catch (e) { r = null; }
      if (!r || r.height < 36) continue;

      var buttons = inboxExpandCount(node);
      if (buttons > 1) break;          // 已经到列表层
      if (buttons === 0) continue;

      if (!smallest) smallest = node;
      if (node.querySelector('[data-id]')) return node;
    }
    return smallest;
  }

  /** 行内有没有未读红点 */
  function inboxUnreadDot(row) {
    if (!row) return null;
    var inner = row.querySelectorAll('*');
    for (var i = 0; i < inner.length; i += 1) {
      if (inboxIsDot(inner[i])) return inner[i];
    }
    return null;
  }

  /**
   * 行的唯一标识。
   * 不能用按钮所在小片段的文本——同一次结算的多条消息时间戳一样，会被当成同一条。
   */
  function inboxRowKey(row) {
    if (!row) return '';
    var idEl = row.querySelector('[data-id]');
    if (idEl) return 'id:' + idEl.getAttribute('data-id');
    return 'txt:' + String(row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  /** 页面里所有「展开 / 收起」按钮 */
  function inboxExpandButtons() {
    var out = [];
    var all = document.querySelectorAll('a, button, span');
    for (var i = 0; i < all.length; i += 1) {
      var t = String(all[i].textContent || '').replace(/\s+/g, '');
      if (t === '展开' || t === '收起') out.push(all[i]);
    }
    return out;
  }

  /** 扫描：有多少红点、多少可展开的行、是否还有下一页 */
  function inboxScan() {
    var dots = inboxDots();
    var buttons = inboxExpandButtons();
    var rows = 0;
    for (var i = 0; i < buttons.length; i += 1) {
      if (inboxRowOf(buttons[i])) rows += 1;
    }

    // 分页：优先用页面自己的链接
    var maxPage = 1;
    var curPage = 1;
    var nextUrl = '';
    var anchors = document.querySelectorAll('a[href]');
    for (var j = 0; j < anchors.length; j += 1) {
      var href = anchors[j].getAttribute('href') || '';
      var m = href.match(/[?&]page=(\d+)/);
      if (!m) continue;
      var n = parseInt(m[1], 10);
      if (n > maxPage) maxPage = n;
      var cls = String(anchors[j].className || '');
      if (/active|current|on\b/i.test(cls) && n >= 1) curPage = n;
    }
    var activeLi = document.querySelector('.pagination li.active, .pagination .active');
    if (activeLi) {
      var at = String(activeLi.textContent || '').replace(/\s+/g, '');
      if (/^\d+$/.test(at)) curPage = parseInt(at, 10);
    }
    for (var q = 0; q < anchors.length; q += 1) {
      var h2 = anchors[q].getAttribute('href') || '';
      var m2 = h2.match(/[?&]page=(\d+)/);
      if (m2 && parseInt(m2[1], 10) === curPage + 1) {
        try { nextUrl = new URL(h2, location.href).href; } catch (e) { nextUrl = ''; }
        break;
      }
    }

    return {
      url: location.href,
      dots: dots.length,
      expands: buttons.length,
      rows: rows,
      curPage: curPage,
      maxPage: maxPage,
      nextUrl: nextUrl,
      title: document.title,
    };
  }

  /**
   * 清除当前页的小红点：逐行点「展开」。
   * @param {Object} opts { mode: 'auto'|'all', maxRows }
   *   auto —— 只点带红点的行
   *   all  —— 全部行都点一遍（红点认不出来时的兜底）
   */
  function inboxClear(opts) {
    var o = opts || {};
    var mode = o.mode === 'all' ? 'all' : 'auto';
    var maxRows = Math.min(o.maxRows || 60, 200);

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    var before = inboxDots().length;
    var prev = before;
    var clicked = 0;
    var seenText = {};
    var failed = [];
    var stalled = 0;

    // 上一轮（比如 auto 没认出来）留下的标记要清掉，否则这次一个都点不到
    var stale = inboxExpandButtons();
    for (var st = 0; st < stale.length; st += 1) stale[st].removeAttribute('data-wb-done');

    function pick() {
      var buttons = inboxExpandButtons();
      for (var i = 0; i < buttons.length; i += 1) {
        var b = buttons[i];
        if (b.getAttribute('data-wb-done') === '1') continue;
        var t = String(b.textContent || '').replace(/\s+/g, '');
        if (t === '收起') { b.setAttribute('data-wb-done', '1'); continue; }
        // auto 模式只点「这一行确实有未读红点」的；已经读过的行不去碰
        if (mode === 'auto' && !inboxUnreadDot(inboxRowOf(b))) continue;
        return b;
      }
      return null;
    }

    async function run() {
      // 上一次「停止」留下的旗标不能带到这一次，否则一开始就退出
      try { window.__wbInboxStop = false; } catch (e) { /* ignore */ }
      var stopped = false;

      for (var step = 0; step < maxRows; step += 1) {
        // 主界面点了「停止」：在这里断，粒度是「一行」，最多再等一次点击后的 2 秒
        if (window.__wbInboxStop) { stopped = true; break; }
        var btn = pick();
        if (!btn) break;
        var row = inboxRowOf(btn) || btn.parentElement;
        // 去重键用消息号（data-id）；不能用按钮小片段的文本——
        // 同一批结算的多条消息时间戳完全一样，会被误判成同一条而跳过
        var label = inboxRowKey(row);
        if (seenText[label]) {
          // 同一行第二轮还没消掉，别在原地打转
          btn.setAttribute('data-wb-done', '1');
          continue;
        }
        seenText[label] = true;
        btn.setAttribute('data-wb-done', '1');

        try { btn.click(); } catch (e) { /* 站点用 jQuery 绑的事件，click() 同样能触发 */ }
        clicked += 1;

        // 停滞判据要跟「上一步的数量」比，跟最初的数量比会一直误判为有进展
        var nowDots = prev;
        for (var w = 0; w < 6; w += 1) {
          await sleep(350);
          nowDots = inboxDots().length;
          if (nowDots < prev) break;
        }
        if (nowDots >= prev) {
          stalled += 1;
          if (stalled >= 4) {
            failed.push('连续 4 行点击后红点没有减少，已停止');
            break;
          }
        } else {
          stalled = 0;
        }
        prev = nowDots;
      }
      var after = inboxDots().length;
      return {
        ok: after < before || (before === 0 && clicked > 0),
        before: before,
        after: after,
        clicked: clicked,
        mode: mode,
        stopped: stopped,
        failed: failed,
        url: location.href,
      };
    }

    return run();
  }

  // ------------------------------------------------------------ 上传章节（新建章节页）
  //
  // 页面结构（2026-11 实测 author.ciweimao.com/book_manage/draft?book_id=xxx）：
  //   form#myform  action=/book_manage/add_chapter  method=post
  //   正文      KindEditor 实例挂在 window.editor，#description 是它的同步目标
  //   章名      input#chapter_title
  //   所属卷    input[name=division_id]（隐藏），可选项在 .volume-wrap a[data-division]
  //   定时发布  #destroy 勾选后启用 #online_time（格式 Y-m-d H:i）
  //   按钮      input#dosubmit（发布章节）/ input#savedraft（保存草稿）
  //   敏感词    发布前 POST add_chapter 校验，返回 {suggestion, msg, url, hint_words}
  //
  // 站点自己的流程（check_special → check_badword）会弹确认框；我们不走它，
  // 而是直接发同一个请求拿 JSON，这样才能把 hint_words 带回本地做高亮与替换。

  /** 读新建章节页的当前状态：表单在不在、有哪些卷、当前填了什么 */
  function pageChapterState() {
    var form = document.getElementById('myform');
    var ed = window.editor;
    var volNodes = document.querySelectorAll('.volume-wrap a[data-division], .dropdown-menu a[data-division]');
    var vols = [];
    var seen = {};
    for (var i = 0; i < volNodes.length; i += 1) {
      var id = volNodes[i].getAttribute('data-division') || '';
      if (!id || seen[id]) continue;
      seen[id] = 1;
      vols.push({ id: id, name: String(volNodes[i].textContent || '').replace(/\s+/g, ' ').trim() });
    }

    var html = '';
    try { html = ed && ed.html ? ed.html() : ''; } catch (e) { html = ''; }
    var descEl = document.getElementById('description');

    function val(id) {
      var el = document.getElementById(id);
      return el ? String(el.value == null ? '' : el.value) : '';
    }

    return {
      ok: !!form,
      hasForm: !!form,
      hasEditor: !!ed,
      url: location.href,
      title: val('chapter_title'),
      bookName: val('book_name'),
      bookId: (document.querySelector('input[name=book_id]') || {}).value || '',
      divisionId: (document.querySelector('input[name=division_id]') || {}).value || '',
      volumes: vols,
      authorSay: val('author_say'),
      scheduleOn: !!(document.getElementById('destroy') && document.getElementById('destroy').checked),
      scheduleAt: val('online_time'),
      wordCount: String((document.getElementById('word_count_tag') || {}).textContent || '').trim(),
      htmlLen: html.length,
      textareaLen: descEl ? String(descEl.value || '').length : 0,
      // 编辑器里已经有多少内容：用来判断「页面被自动存过草稿」还是真的空白
      editorEmpty: !ed || !String(html).replace(/<[^>]+>|\s|&nbsp;/g, ''),
    };
  }

  /**
   * 把本地章节填进新建章节页。
   * @param {Object} args { title, html, divisionId, authorSay, schedule }
   *   schedule 传 'Y-m-d H:i' 表示定时发布，传 '' 表示立即发布，不传则不动当前设置
   */
  function pageFillChapter(args) {
    var a = args || {};
    var form = document.getElementById('myform');
    if (!form) return { ok: false, error: '页面里找不到章节表单（可能不是新建章节页）' };
    var ed = window.editor;
    var applied = [];

    if (a.title !== undefined) {
      var t = document.getElementById('chapter_title');
      if (t) { t.value = String(a.title); applied.push('title'); }
    }

    if (a.divisionId) {
      var d = document.querySelector('input[name=division_id]');
      if (d) d.value = String(a.divisionId);
      var links = document.querySelectorAll('.volume-wrap a[data-division]');
      for (var i = 0; i < links.length; i += 1) {
        if (links[i].getAttribute('data-division') === String(a.divisionId)) {
          var sp = document.querySelector('.volume-btn span:first-child');
          if (sp) sp.textContent = String(links[i].textContent || '').replace(/\s+/g, ' ').trim();
        }
      }
      applied.push('volume');
    }

    if (a.html !== undefined) {
      if (!ed) return { ok: false, error: '页面里的编辑器还没初始化完成，稍等再试' };
      var html = String(a.html);
      try {
        ed.html(html);
        ed.sync();
      } catch (e) {
        return { ok: false, error: '写入编辑器失败：' + String((e && e.message) || e) };
      }
      // 站点同步目标叫 #description（pageChapterState 里也是读它）；
      // #desc_content 是旧版留下的猜测，两个都试一下，优先真实目标。
      var desc = document.getElementById('description') || document.getElementById('desc_content');
      if (desc) desc.innerHTML = html;
      if (typeof check_description === 'function') {
        try { check_description(); } catch (e2) { /* 字数刷新失败不影响正文 */ }
      }
      applied.push('body');
    }

    if (a.authorSay !== undefined) {
      var as = document.getElementById('author_say');
      if (as) { as.value = String(a.authorSay); applied.push('authorSay'); }
    }

    if (a.schedule !== undefined) {
      var cb = document.getElementById('destroy');
      var ot = document.getElementById('online_time');
      if (cb && ot) {
        if (a.schedule) {
          cb.checked = true;
          // 先触发一次 click 让站点初始化日期控件，它会把输入框清空，所以赋值放在后面
          try { cb.click(); } catch (e3) { /* ignore */ }
          ot.value = String(a.schedule);
          try { if (window.jQuery) window.jQuery('#online_time').val(String(a.schedule)); } catch (e4) { /* ignore */ }
        } else {
          if (cb.checked) { cb.checked = false; try { cb.click(); } catch (e5) { /* ignore */ } }
        }
        applied.push('schedule');
      }
    }

    var after = '';
    try { after = ed && ed.html ? ed.html() : ''; } catch (e6) { after = ''; }

    return {
      ok: true,
      applied: applied,
      title: (document.getElementById('chapter_title') || {}).value || '',
      htmlLen: after.length,
      wordCount: String((document.getElementById('word_count_tag') || {}).textContent || '').trim(),
      scheduleOn: !!(document.getElementById('destroy') && document.getElementById('destroy').checked),
      scheduleAt: (document.getElementById('online_time') || {}).value || '',
    };
  }

  /**
   * 提交前的校验，等价于站点 check_badword 里的那个 ajax。
   * 返回服务器的原始判定：pass（通过并已保存）/ error（拒绝）/ 其它（有疑似敏感词）。
   */
  function pageCheckChapter(args) {
    var a = args || {};
    var form = document.getElementById('myform');
    if (!form) return Promise.resolve({ ok: false, error: '页面里找不到章节表单' });

    var ed = window.editor;
    if (ed && ed.sync) { try { ed.sync(); } catch (e0) { /* 同步失败下面的长度会体现出来 */ } }

    var buttonValue = a.buttonValue === 'savedraft' ? 'savedraft' : 'dosubmit';
    var bv = document.getElementById('buttonValue');
    if (bv) bv.value = buttonValue;

    return new Promise(function (resolve) {
      var settled = false;
      function finish(v) { if (!settled) { settled = true; resolve(v); } }

      // 站点这个接口正常 2 秒内回；20 秒还没回基本是掉线，早点把控制权还给界面
      setTimeout(function () {
        finish({ ok: false, error: '提交校验超时（20 秒无响应），请检查后台是否还在登录状态' });
      }, 20000);

      try {
        var $jq = window.jQuery || window.$;
        $jq.ajax({
          url: 'https://author.ciweimao.com/book_manage/add_chapter',
          type: 'post',
          data: $jq('#myform').serialize(),
          dataType: 'json',
          success: function (data) {
            finish({
              ok: true,
              buttonValue: buttonValue,
              suggestion: String((data && data.suggestion) || ''),
              msg: String((data && data.msg) || ''),
              url: String((data && data.url) || ''),
              hintWords: String((data && data.hint_words) || ''),
              raw: data,
            });
          },
          error: function (xhr) {
            var body = '';
            try { body = String((xhr && xhr.responseText) || '').slice(0, 400); } catch (e) { body = ''; }
            var needLogin = /inputAccount|J_ChangeLoginType|\/login/i.test(body);
            finish({
              ok: false,
              needLogin: needLogin,
              error: needLogin
                ? '后台登录已失效，请重新登录后再投递'
                : '提交校验失败（HTTP ' + ((xhr && xhr.status) || '?') + '）',
            });
          },
        });
      } catch (e) {
        finish({ ok: false, error: '发起校验请求失败：' + String((e && e.message) || e) });
      }
    });
  }

  /**
   * 无视敏感词提示，强制提交（站点原生的「执意提交」）。
   * 注意：站点在强制模式下会把疑似敏感词直接隐藏，正文会少字。
   * 所以只在「报出来的词在正文里根本不存在」这种误报场景下用它。
   */
  function pageForceSubmit() {
    var form = document.getElementById('myform');
    if (!form) return { ok: false, error: '页面里找不到章节表单' };
    var ed = window.editor;
    if (ed && ed.sync) { try { ed.sync(); } catch (e0) { /* ignore */ } }
    var bv = document.getElementById('buttonValue');
    if (bv) bv.value = 'dosubmit';
    var is = document.getElementById('is_submit');
    if (is) is.value = '1';
    try {
      form.submit();
    } catch (e) {
      return { ok: false, error: '提交失败：' + String((e && e.message) || e) };
    }
    return { ok: true, submitted: true };
  }

  /** 页面是否登录失效（供投递前的守卫使用） */
  function pageIsLoginWall() {
    return /\/login/.test(location.href)
      || !!document.querySelector('input[name=account],input#inputAccount');
  }

  /**
   * 接管站点自己的发布按钮。
   *
   * 站点把「发布章节」绑在 check_special() → check_badword() 上，这两个都是全局函数。
   * 覆盖它们就等价于接管按钮：点下去仍然走站点同一个接口，但结果由我们收，
   * 敏感词不会再被站点那个「执意提交就隐藏所有敏感词」的确认框吞掉。
   *
   * 命中后把结果挂在 window.__wbCheckResult，宿主每 1.2 秒来取一次。
   * 幂等：重复注入不会叠加。
   */
  function pageHookPublish() {
    if (window.__wbHooked) return { ok: true, already: true };

    /**
     * 在站点页面顶部弹一条自己的提示。
     *
     * 位置刻意选在页面内部：宿主窗口那边有顶栏状态条，但最少要等一拍轮询（1.2 秒）
     * 才亮；而作者点完按钮视线就在按钮附近，这一拍的空档看起来就是「没反应」。
     * 样式全内联、不依赖站点 CSS，站点改版也不会变成白底白字。
     */
    function pageToast(text, kind, holdMs) {
      var host = document.body || document.documentElement;
      if (!host) return;
      var el = document.getElementById('__wbCheckToast');
      if (!el) {
        el = document.createElement('div');
        el.id = '__wbCheckToast';
        el.setAttribute('style',
          'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;'
          + 'max-width:70%;padding:9px 18px;border-radius:8px;color:#fff;'
          + 'font:13px/1.7 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;'
          + 'box-shadow:0 8px 24px rgba(0,0,0,.28);pointer-events:none;transition:opacity .25s;');
        host.appendChild(el);
      }
      var bg = 'rgba(28,28,30,.94)';
      if (kind === 'ok') bg = 'rgba(22,116,62,.96)';
      else if (kind === 'error') bg = 'rgba(176,42,42,.96)';
      else if (kind === 'warn') bg = 'rgba(178,110,20,.96)';
      el.textContent = text;
      el.style.background = bg;
      el.style.opacity = '1';
      if (el.__wbHide) { clearTimeout(el.__wbHide); el.__wbHide = null; }
      // 「进行中」不自动收，等 settle 换成结果；其余按 holdMs 淡出
      if (kind === 'busy') return;
      el.__wbHide = setTimeout(function () {
        el.style.opacity = '0';
        el.__wbHide = setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 300);
      }, holdMs || 3200);
    }

    function doCheck(buttonValue) {
      var bv = buttonValue || 'dosubmit';

      // 防重入：站点按钮的内联 onclick 万一没摘干净（站点换写法、我们摘漏了），
      // 或者用户手快连点两下，都不能让两个请求同时飞出去抢同一个结果槽。
      // 后到的直接忽略 —— 前一个请求的结果才是要的。
      if (window.__wbChecking) return;
      window.__wbChecking = true;

      // 每次请求一个序号。超时之后用户点「重试」会开一个新请求，
      // 而旧请求的 ajax 回调可能这时才姗姗来迟 —— 没有序号的话它会把
      // 新请求的结果覆盖成旧结果，界面于是显示上一轮的错误，越点越乱。
      var seq = (window.__wbSeq || 0) + 1;
      window.__wbSeq = seq;

      var $jq = window.jQuery || window.$;
      var form = document.getElementById('myform');
      if (!form || !$jq) {
        window.__wbChecking = false;
        window.__wbCheckResult = { phase: 'error', at: Date.now(), error: '页面还没就绪（表单或 jQuery 不在）' };
        return;
      }
      var ed = window.editor;
      if (ed && ed.sync) { try { ed.sync(); } catch (e0) { /* 让下面的 serialize 决定 */ } }
      var bvel = document.getElementById('buttonValue');
      if (bvel) bvel.value = bv;

      window.__wbCheckResult = { phase: 'pending', at: Date.now(), buttonValue: bv };

      // 页面里立刻给一条反馈。
      // 为什么要它：宿主那边靠 1.2 秒一次的轮询，顶栏状态条最快也要一拍才亮；
      // 作者点完按钮视线还在按钮上，这一拍的空档就是「点了没反应」。
      // 这条提示直接画在页面上，几百毫秒内就能看到，且跟着页面的主题走不掉。
      pageToast('正在提交校验…', 'busy');

      // 超时兜底：站点这个接口正常 2 秒内回。
      // 以前这里没有 timer，ajax 一旦挂住（断网、被拦、会话失效但连接不关），
      // __wbCheckResult 就永远停在 pending，宿主轮询对 pending 是直接跳过的，
      // 于是界面从头到尾没有任何反馈 —— 这是「卡住」的另一半原因。
      function settle(obj) {
        if (!window.__wbChecking) return;      // 已经结束过了，别覆盖真实结果
        if (window.__wbSeq !== seq) return;    // 上一轮请求的回调，丢掉
        window.__wbChecking = false;
        if (timer) { clearTimeout(timer); timer = null; }
        window.__wbCheckResult = obj;

        if (obj.phase === 'error') {
          pageToast(obj.error || '提交失败', 'error', 6000);
        } else if (obj.suggestion === 'pass') {
          pageToast('发布成功 ✓ 正在跳转…', 'ok');
        } else if (obj.suggestion === 'error') {
          pageToast(obj.msg || '站点没有接收这一章', 'error', 6000);
        } else {
          pageToast('站点报出敏感内容，这一章没有发出去', 'warn', 6000);
        }
      }
      var timer = setTimeout(function () {
        settle({
          phase: 'error',
          at: Date.now(),
          buttonValue: bv,
          error: '提交校验 25 秒没有响应，可能后台掉线了，点这里重新登录后再发',
          needLogin: false,
          timeout: true,
        });
      }, 25000);

      $jq.ajax({
        url: 'https://author.ciweimao.com/book_manage/add_chapter',
        type: 'post',
        data: $jq('#myform').serialize(),
        dataType: 'json',
        success: function (data) {
          var suggestion = String((data && data.suggestion) || '');
          // 站点偶尔不给 url（或者给空串）。以前这种情况什么都不做 ——
          // 结果是：章节确实发出去了，页面却一动不动，作者以为没发出去，又点一遍。
          // 所以这里先把「该跳哪儿」算出来，空就兜底到这本书的章节管理页。
          var target = (data && data.url) ? String(data.url) : '';
          if (!target) {
            var bidEl = document.querySelector('input[name=book_id]');
            var bid = bidEl ? String(bidEl.value || '') : '';
            target = '/book_manage/view_chapter_info' + (bid ? ('?book_id=' + bid) : '');
          }
          settle({
            phase: 'done',
            at: Date.now(),
            buttonValue: bv,
            suggestion: suggestion,
            msg: String((data && data.msg) || ''),
            url: String((data && data.url) || ''),
            hintWords: String((data && data.hint_words) || ''),
            navTo: target,
          });
          // 通过：站点原本会弹一个「确认」再跳转，这里直接跳，别让人多点一次。
          //
          // 但要先让宿主读到结果再跳：跳转会让页面卸载，宿主那边的轮询就再也拿不到
          // 这次成功，侧栏会一直停在「已填入后台」，用户以为没发出去，又点一遍。
          // sessionStorage 在同源内跨页面共享，所以先把结果备份进去，跳完宿主还能捞回来。
          if (suggestion === 'pass') {
            try {
              window.sessionStorage.setItem('__wbCheckResult', JSON.stringify(window.__wbCheckResult));
            } catch (e1) { /* 隐私模式禁用了也不影响主流程 */ }
            setTimeout(function () {
              try { window.location.href = target; } catch (e2) { /* ignore */ }
            }, 60);
          }
        },
        error: function (xhr) {
          var body = '';
          try { body = String((xhr && xhr.responseText) || '').slice(0, 300); } catch (e3) { body = ''; }
          settle({
            phase: 'error',
            at: Date.now(),
            buttonValue: bv,
            needLogin: /inputAccount|J_ChangeLoginType|\/login/i.test(body),
            error: '提交校验失败（HTTP ' + ((xhr && xhr.status) || '?') + '）',
          });
        },
      });
    }

    window.check_special = function () { doCheck('dosubmit'); };
    window.check_badword = function (bv) { doCheck(bv || 'dosubmit'); };
    window.__wbDoCheck = doCheck;

    // 再硬一层：把两个按钮换成同名同貌的克隆节点。
    // cloneNode + replaceChild 会把站点用 addEventListener / jQuery .on 绑的事件一起丢掉，
    // 但**内联 onclick 属性会被原样复制**（它是 DOM 属性，不是监听器）。
    // 站点这两个按钮正是 `onclick="check_special()"` 这种写法，于是点一次会跑两遍：
    //   ① 克隆保留的内联 onclick → window.check_special → 我们的 doCheck
    //   ② 我们自己 addEventListener 的 click → doCheck
    // 两个请求抢同一个 window.__wbCheckResult：后发的立刻把先发的 done 覆盖成 pending，
    // 宿主轮询只认 done/error，于是界面一直停在「什么都没发生」——就是用户说的「卡住了」。
    // 所以克隆之后必须把内联事件属性摘掉。
    var INLINE_EVENTS = [
      'onclick', 'onmousedown', 'onmouseup', 'ondblclick',
      'onkeydown', 'onkeyup', 'onkeypress', 'onsubmit',
    ];

    /**
     * 找按钮：先按 id，找不到再按可见文字。
     *
     * 只认 id 有个隐患：站点哪天把 <input id="dosubmit"> 改成
     * <button class="btn btn-warning">发布章节</button>，接管就整个失效 ——
     * 而失效是完全静默的：用户点的是站点原生按钮，站点自己提交、自己跳转，
     * 我们的轮询永远等不到结果，侧栏一直停在「已填入后台」，
     * 用户看到的就是「点了发布，然后卡住了」。
     */
    function findButton(id, label) {
      var byId = document.getElementById(id);
      if (byId) return byId;
      var all = document.querySelectorAll('input[type=button], input[type=submit], button');
      for (var i = 0; i < all.length; i += 1) {
        var t = String(all[i].value || all[i].textContent || '').replace(/\s+/g, '');
        if (t === label) return all[i];
      }
      return null;
    }

    var hooked = 0;
    [
      { id: 'dosubmit', label: '发布章节', bv: 'dosubmit' },
      { id: 'savedraft', label: '保存草稿', bv: 'savedraft' },
    ].forEach(function (spec) {
      var btn = findButton(spec.id, spec.label);
      if (!btn || btn.getAttribute('data-wb-hooked') === '1') return;
      var clone = btn.cloneNode(true);
      clone.setAttribute('data-wb-hooked', '1');
      for (var k = 0; k < INLINE_EVENTS.length; k += 1) {
        clone.removeAttribute(INLINE_EVENTS[k]);
      }
      clone.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        doCheck(spec.bv);
      });
      btn.parentNode.replaceChild(clone, btn);
      hooked += 1;
    });

    window.__wbHooked = true;
    window.__wbCheckResult = null;
    // hooked 告诉宿主到底接管上了没有：0 说明站点改版了，
    // 此时点页面上的按钮走的是站点原生流程，界面必须把这件事说出来
    return { ok: true, hooked: true, buttons: hooked };
  }

  /** 宿主轮询用：取最近一次被接管的校验结果 */
  function pageReadCheck() {
    var r = window.__wbCheckResult;

    // 页面提交成功后站点会自己跳走，跳转那一刻页面卸载，__wbCheckResult 随之消失。
    // 宿主是 1.2 秒轮询一次，很容易还没读到就跳没了 —— 侧栏便一直停在「已填入后台」，
    // 用户以为没发出去，又点一遍，站点就报「重复提交」。
    // 所以 doCheck 成功时会往 sessionStorage 里备份一份（同源跨页面共享），这里捞回来。
    if (!r) {
      try {
        var bak = window.sessionStorage.getItem('__wbCheckResult');
        if (bak) r = JSON.parse(bak);
      } catch (e0) { /* 读不到就按 idle 处理 */ }
    }

    if (!r) return { phase: 'idle', hooked: !!window.__wbHooked };
    return {
      phase: r.phase,
      at: r.at,
      hooked: !!window.__wbHooked,
      buttonValue: r.buttonValue || '',
      suggestion: r.suggestion || '',
      msg: r.msg || '',
      url: r.url || '',
      hintWords: r.hintWords || '',
      /** 通过后该跳到哪：站点给的 url，没有就是兜底的章节管理页 */
      navTo: r.navTo || '',
      error: r.error || '',
      needLogin: !!r.needLogin,
      fromStorage: !window.__wbCheckResult,
    };
  }

  /** 清掉已读的结果，避免同一份结果被反复处理 */
  function pageClearCheck() {
    window.__wbCheckResult = null;
    try { window.sessionStorage.removeItem('__wbCheckResult'); } catch (e) { /* ignore */ }
    return true;
  }

  /** 读页面编辑器里的正文（纯文本 + HTML），敏感词分析以这个为准 */
  function pageEditorText() {
    var ed = window.editor;
    var html = '';
    var text = '';
    try { html = ed && ed.html ? ed.html() : ''; } catch (e) { html = ''; }
    try {
      if (ed && ed.text) {
        text = ed.text();
      } else {
        var d = document.createElement('div');
        d.innerHTML = html;
        text = d.textContent || '';
      }
    } catch (e2) { text = ''; }
    return { ok: !!ed, html: html, text: text, htmlLen: html.length, textLen: String(text).length };
  }

  /**
   * 直接在页面正文里做替换，保留原有分段、图片与格式。
   * @param {Object} args { pairs: [{ from, to }] }
   * 注意：替换是在 HTML 字符串上做的，词若被换行或标签拆开就命中不了 ——
   * 这种情况返回 changed=0，由界面提示作者手动改。
   */
  function pageReplaceInEditor(args) {
    var a = args || {};
    var pairs = a.pairs || [];
    var ed = window.editor;
    if (!ed || !ed.html) return { ok: false, error: '编辑器还没就绪' };

    var html = '';
    try { html = ed.html(); } catch (e) { return { ok: false, error: '读不到编辑器内容' }; }

    var total = 0;
    var detail = [];
    for (var i = 0; i < pairs.length; i += 1) {
      var from = String((pairs[i] && pairs[i].from) || '');
      var to = String((pairs[i] && pairs[i].to) || '');
      // to 允许是空串 —— 那就是「把这个词直接删掉」
      if (!from || from === to) continue;
      var parts = html.split(from);
      var n = parts.length - 1;
      if (n <= 0) continue;
      html = parts.join(to);
      total += n;
      detail.push({ from: from, to: to, count: n });
    }
    if (!total) return { ok: true, changed: 0, detail: [] };

    try {
      ed.html(html);
      ed.sync();
    } catch (e2) {
      return { ok: false, error: '写回编辑器失败：' + String((e2 && e2.message) || e2) };
    }
    var desc = document.getElementById('description') || document.getElementById('desc_content');
    if (desc) desc.innerHTML = html;
    if (typeof check_description === 'function') { try { check_description(); } catch (e3) { /* ignore */ } }
    return { ok: true, changed: total, detail: detail };
  }

  // ------------------------------------------------------------ 注入打包
  //
  // 需要随目标函数一起送进页面的辅助函数。它们互相调用，必须同批注入。

  /**
   * 读当前登录账号的作者名（笔名）。
   *
   * 用途：把密码本里的「账号」和「笔名」对上，多账号用户才能一眼分清。
   *
   * 站点没有给稳定的钩子，所以按「越具体越优先」的顺序试几种来源：
   *   1. 后台页面里明确写着「作者名 / 笔名 / 昵称」的字段；
   *   2. 顶部导航里的用户名节点（作者后台右上角那一块）；
   *   3. 作者中心首页的欢迎语「你好，XXX」。
   * 都读不到就返回空串——宁可让用户手填，也不要瞎猜一个名字绑上去。
   */
  function readAuthorName() {
    function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

    // 1) 带标签的字段：<dt>作者名</dt><dd>某某</dd>、<span>笔名：</span><b>某某</b>
    var labels = ['作者名', '笔名', '作者笔名'];
    var all = document.querySelectorAll('dt, span, label, th, td, li, p, div');
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      var text = clean(el.innerText || el.textContent);
      if (text.length > 40) continue;
      for (var l = 0; l < labels.length; l += 1) {
        var lab = labels[l];
        if (text === lab || text === lab + '：' || text === lab + ':') {
          var next = el.nextElementSibling;
          if (next) {
            var v = clean(next.innerText || next.textContent);
            if (v && v.length <= 40 && !/[:：]$/.test(v)) return v;
          }
          // 同一个节点里写成「作者名：某某」
          var self = text.replace(new RegExp('^' + lab + '\\s*[:：]\\s*'), '');
          if (self && self !== text) return self;
        }
        // 直接命中「作者名：某某」的紧凑写法
        var m = text.match(new RegExp(lab + '\\s*[:：]\\s*(\\S{1,40})$'));
        if (m && m[1]) return m[1];
      }
    }

    // 2) 顶部导航的用户名节点
    var candidates = [
      '.header .username', '.top-bar .username', '.user-name', '.author-name',
      '.header-user .name', '.nav-user .name', '[class*="userName"]', '[class*="authorName"]',
    ];
    for (var c = 0; c < candidates.length; c += 1) {
      var node = document.querySelector(candidates[c]);
      if (!node) continue;
      var name = clean(node.innerText || node.textContent);
      if (name && name.length <= 40) return name;
    }

    // 3) 欢迎语
    var bodyText = clean(document.body ? document.body.innerText : '');
    var hello = bodyText.match(/(?:你好|欢迎你|欢迎)[，,、\s]*([^\s，,。！!]{1,20})/);
    if (hello && hello[1]) return hello[1];

    return '';
  }

  /**
   * 道具获得：从作者后台「统计中心 → 道具获得」读当日四项数字与明细。
   *
   * 真实页面结构（2026-11 实测）：
   *   [说明行] 平台按每日 6 时到次日 6 时结算…
   *   [选择作品 ▼] [查看]                    [道具获得][点击和收藏]
   *   [总推荐票 384] [总月票 9] [总打赏 5064] [总刀片 3]
   *   「道具获得趋势」 近7日 / 近30日 / 按月
   *   「道具获得明细」 一张表（常见为「暂无任何数据」）
   *
   * 只有这四项，没有「宝箱」。之前按猜测多写了一项，永远读不到、只会显示「—」。
   *
   * 提取策略：不写死选择器。按「关键词 + 同一块里唯一的数字」找，
   * 这样后台改版换了 class 也还能用；一块里数字不唯一就跳过，宁可不显示也不猜。
   */
  function extractProps() {
    // 顺序与平台一致：推荐票 → 月票 → 打赏 → 刀片
    var RULES = [
      { key: 'recommend', words: ['总推荐票', '推荐票'] },
      { key: 'monthly', words: ['总月票', '月票'] },
      { key: 'reward', words: ['总打赏', '打赏'] },
      { key: 'blade', words: ['总刀片', '刀片'] },
    ];

    function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
    function toNum(s) {
      var t = String(s == null ? '' : s).replace(/,/g, '').trim();
      var m = t.match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : null;
    }

    var nodes = document.querySelectorAll('div, li, p, span, td, th, h3, h4, strong, em, b');
    var items = {};
    var raw = [];
    var scanned = 0;

    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var text = clean(el.innerText || el.textContent);
      if (!text || text.length > 60) continue;
      scanned += 1;

      // 只认叶子级：子元素里若也有同样的关键词，交给子元素处理，避免父块重复计数
      var hasSameInside = false;
      for (var c = 0; c < el.children.length; c += 1) {
        var childText = clean(el.children[c].innerText || el.children[c].textContent);
        for (var r0 = 0; r0 < RULES.length; r0 += 1) {
          if (RULES[r0].words.indexOf(childText) >= 0) { hasSameInside = true; break; }
        }
        if (hasSameInside) break;
      }
      if (hasSameInside) continue;

      for (var r = 0; r < RULES.length; r += 1) {
        var rule = RULES[r];
        var hitWord = '';
        for (var w = 0; w < rule.words.length; w += 1) {
          if (text.indexOf(rule.words[w]) >= 0) { hitWord = rule.words[w]; break; }
        }
        if (!hitWord) continue;

        // 卡片里通常写成「总推荐票 / 384」两行，或「总推荐票 384」一行。
        // 先把关键词本身去掉，剩下的数字才是这个指标的数值，
        // 否则「总推荐票」里的字被当成数字之外的东西没问题，但「近7日」这类
        // 会混进无关数字 —— 所以要求去掉关键词后只剩一个数字。
        var rest = text.split(hitWord).join(' ');
        var nums = rest.match(/-?\d[\d,]*(?:\.\d+)?/g) || [];
        if (nums.length !== 1) {
          if (nums.length > 1) raw.push({ key: rule.key, text: text, ambiguous: true });
          continue;
        }
        var value = toNum(nums[0]);
        if (value === null || value < 0) continue;

        // 同一指标在多处出现时取第一次（主卡片通常在页面最前）
        if (items[rule.key] === undefined) {
          items[rule.key] = value;
          raw.push({ key: rule.key, text: text, value: value });
        }
      }
    }

    // ---- 明细表：有就抓，没有就空数组（平台默认就是「暂无任何数据」） ----
    var detail = [];
    try {
      var tables = document.querySelectorAll('table');
      for (var t = 0; t < tables.length; t += 1) {
        var rows = tables[t].querySelectorAll('tbody tr, tr');
        var cols = [];
        var headRow = tables[t].querySelector('thead tr');
        if (headRow) {
          var ths = headRow.querySelectorAll('th, td');
          for (var h = 0; h < ths.length; h += 1) cols.push(clean(ths[h].innerText || ths[h].textContent));
        }
        for (var q = 0; q < rows.length && detail.length < 50; q += 1) {
          var tds = rows[q].querySelectorAll('td');
          if (!tds.length) continue;
          var cells = [];
          for (var k = 0; k < tds.length; k += 1) cells.push(clean(tds[k].innerText || tds[k].textContent));
          // 整行都没有数字的，多半是「暂无任何数据」这类占位行，不当明细
          if (!cells.some(function (x) { return /\d/.test(x); })) continue;
          detail.push({ cells: cells, cols: cols });
        }
        if (detail.length) break;
      }
    } catch (_) { detail = []; }

    // ---- 当前选中的作品 ----
    var bookId = '';
    var sel = document.querySelector('select');
    if (sel && /^\d{6,}$/.test(String(sel.value || ''))) bookId = String(sel.value);

    // ---- 当前粒度（近7日 / 近30日 / 按月）----
    var grain = '';
    var grainWords = ['近7日', '近30日', '按月', '近 7 日', '近 30 日'];
    for (var g = 0; g < grainWords.length; g += 1) {
      var cands = document.querySelectorAll('a, button, li, span');
      for (var cb = 0; cb < cands.length; cb += 1) {
        var ct = clean(cands[cb].innerText || cands[cb].textContent);
        if (ct === grainWords[g]) {
          var cls = String(cands[cb].className || '');
          var par = cands[cb].parentElement ? String(cands[cb].parentElement.className || '') : '';
          if (/active|on|cur|selected|is-/.test(cls + ' ' + par)) grain = grainWords[g];
        }
      }
      if (grain) break;
    }

    return {
      items: items,
      detail: detail,
      bookId: bookId,
      grain: grain,
      raw: raw.slice(0, 30),
      scanned: scanned,
    };
  }

  /**
   * 在道具获得页切到指定作品并点「查看」。
   *
   * 平台是「选作品 → 查看」两步，只改下拉框不会刷新数字，必须点那个按钮。
   * 找不到按钮时只改下拉框并返回 clicked=false，由调用方决定是否重试。
   */
  function selectPropsBook(bookId) {
    function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
    var want = String(bookId || '');
    var sel = document.querySelector('select');
    var picked = false;
    if (sel && want) {
      for (var i = 0; i < sel.options.length; i += 1) {
        if (String(sel.options[i].value) === want) {
          sel.value = want;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          picked = true;
          break;
        }
      }
    }
    // 「查看」按钮：文字精确匹配，避免误点「刷新」之类
    var clicked = false;
    var btns = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
    for (var b = 0; b < btns.length; b += 1) {
      var txt = clean(btns[b].innerText || btns[b].value || btns[b].textContent);
      if (txt === '查看' || txt === '查 看') {
        btns[b].click();
        clicked = true;
        break;
      }
    }
    return { picked: picked, clicked: clicked, value: sel ? String(sel.value || '') : '' };
  }

  const PAGE_HELPERS = [
    execPost,
    execGet,
    hasTsukkomi,
    isLoginResponse,
    inboxIsDot,
    inboxDots,
    inboxExpandCount,
    inboxRowOf,
    inboxUnreadDot,
    inboxRowKey,
    inboxExpandButtons,
  ];

  /**
   * 生成一段能在平台页面里独立运行的脚本。
   *
   * 只把目标函数 toString() 送过去是不够的——它内部会调用同模块的辅助函数，
   * 而那些在页面里根本不存在。v0.4.0 第一次真执行就报
   * 「Script failed to execute」，原因正是这个（测试时整份适配层都注入了，所以没暴露）。
   * 之后所有注入都必须走这里。
   */
  function pageSource(fnName, args) {
    var fn = api[fnName];
    if (!fn) throw new Error('适配层缺少方法 ' + fnName);
    var helpers = PAGE_HELPERS.map(function (f) { return f.toString(); }).join('\n');
    var argStr = args === undefined ? '' : JSON.stringify(args);
    return '(function () {\n' + helpers + '\nreturn (' + fn.toString() + ')(' + argStr + ');\n})()';
  }

  var api = {
    norm: norm,
    extractTsukkomi: extractTsukkomi,
    extractPager: extractPager,
    extractReview: extractReview,
    queryFanValue: queryFanValue,
    extractBooks: extractBooks,
    extractBookOptions: extractBookOptions,
    extractBookStats: extractBookStats,
    extractSubscribeStats: extractSubscribeStats,
    extractProps: extractProps,
    selectPropsBook: selectPropsBook,
    readAuthorName: readAuthorName,
    extractHomeStats: extractHomeStats,
    fetchHtml: fetchHtml,
    fetchChapterDetail: fetchChapterDetail,
    parseChapterList: parseChapterList,
    parseBookList: parseBookList,
    parseChapterContent: parseChapterContent,
    dominantBlock: dominantBlock,
    toPlainText: toPlainText,
    chapterNo: chapterNo,
    fillLoginForm: fillLoginForm,
    readLoginForm: readLoginForm,
    pageSource: pageSource,
    execDeleteTsukkomi: execDeleteTsukkomi,
    execMuteReader: execMuteReader,
    verifyTsukkomi: verifyTsukkomi,
    verifyMuted: verifyMuted,
    inboxScan: inboxScan,
    inboxClear: inboxClear,
    // 上传章节（新建章节页）
    pageChapterState: pageChapterState,
    pageFillChapter: pageFillChapter,
    pageCheckChapter: pageCheckChapter,
    pageForceSubmit: pageForceSubmit,
    pageIsLoginWall: pageIsLoginWall,
    pageEditorText: pageEditorText,
    pageReplaceInEditor: pageReplaceInEditor,
    pageHookPublish: pageHookPublish,
    pageReadCheck: pageReadCheck,
    pageClearCheck: pageClearCheck,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CiweimaoAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
