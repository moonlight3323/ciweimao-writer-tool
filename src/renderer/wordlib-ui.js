'use strict';

/**
 * 设置 → 敏感词库。
 *
 * 这里只做「看」：列出收集到的词、复制、清空。提交与同步留给后续版本，
 * 所以界面上不出现「上传」「云端」这一类字眼。
 *
 * 渲染上有两处刻意的取舍：
 * - 单字词默认折叠。站点把「的」「了」这类字当敏感词报出来几乎都是误判，
 *   混在列表里会把真正有用的词淹掉，但不删 —— 用户展开仍能看到。
 * - 超过 200 条只画前 200，避免一次插入几千个 DOM 让设置页卡住。
 */
(function () {
  const MAX_RENDER = 200;

  const $ = (sel) => document.querySelector(sel);

  let all = [];
  let expanded = false;
  let showAll = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 字数：按码点算，避免把 emoji 当成两个词 */
  const charCount = (w) => Array.from(String(w || '')).length;

  function day(iso) {
    const s = String(iso || '');
    return s.length >= 10 ? s.slice(0, 10) : '—';
  }

  function rowHtml(w) {
    const state = w.submitted
      ? '<span class="wl-state is-done">已提交</span>'
      : '<span class="wl-state">未提交</span>';
    return `<div class="wl-row">
      <span class="wl-word">${esc(w.w)}</span>
      <span class="wl-hits">命中 ${Number(w.hits) || 0} 次</span>
      <span class="wl-last">末次 ${esc(day(w.last))}</span>
      ${state}
    </div>`;
  }

  function renderEmpty(host) {
    host.innerHTML = '<p class="wordlib-empty">还没有收集到敏感词。发布章节触发审核时，站点返回的词会自动记录在这里。</p>';
  }

  function render() {
    const host = $('#wordlibList');
    if (!host) return;

    // 排序：命中多的在前，同次数时最近出现的在前
    const sorted = all.slice().sort((a, b) => {
      const d = (Number(b.hits) || 0) - (Number(a.hits) || 0);
      if (d) return d;
      return String(b.last || '') > String(a.last || '') ? 1 : -1;
    });

    if (!sorted.length) {
      renderEmpty(host);
      $('#wordlibMore').hidden = true;
      return;
    }

    const singles = sorted.filter((w) => charCount(w.w) === 1);
    const normals = sorted.filter((w) => charCount(w.w) > 1);

    const shown = showAll ? normals : normals.slice(0, MAX_RENDER);
    let html = shown.map(rowHtml).join('');

    if (normals.length > shown.length) {
      html += `<div class="wl-more-inline">还有 ${normals.length - shown.length} 条未显示</div>`;
    }

    if (singles.length) {
      html += `<div class="wl-group">
        <button class="wl-group-head" type="button" id="wlGroupToggle" aria-expanded="false">
          <span class="wl-group-title">疑似误报（${singles.length} 条）</span>
          <span class="wl-group-note">单字词几乎都是误报</span>
          <span class="wl-group-arrow">▾</span>
        </button>
        <div class="wl-group-body" id="wlGroupBody" hidden>${singles.map(rowHtml).join('')}</div>
      </div>`;
    }

    host.innerHTML = html;

    const toggle = $('#wlGroupToggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const body = $('#wlGroupBody');
        const open = body.hidden;
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.classList.toggle('is-open', open);
      });
    }

    const more = $('#wordlibMore');
    const moreBtn = $('#btnWordlibMore');
    if (normals.length > MAX_RENDER) {
      more.hidden = false;
      moreBtn.textContent = showAll
        ? `只显示前 ${MAX_RENDER} 条`
        : `显示全部（${normals.length} 条）`;
    } else {
      more.hidden = true;
    }
  }

  async function load() {
    try {
      const [words, stats] = await Promise.all([
        window.api.badword.list(),
        window.api.badword.stats(),
      ]);
      all = Array.isArray(words) ? words : [];

      const total = (stats && stats.total) || 0;
      const submitted = (stats && stats.submitted) || 0;
      $('#wordlibStats').textContent = `共 ${total} 条 · 已提交 ${submitted} 条`;
      $('#wordlibTag').textContent = `${total} 条`;

      const copyBtn = $('#btnWordlibCopy');
      const clearBtn = $('#btnWordlibClear');
      if (copyBtn) copyBtn.disabled = !all.length;
      if (clearBtn) clearBtn.disabled = !all.length;

      render();
    } catch (_) {
      // 数据层不可用时按空库展示，不要把设置页整块打空
      all = [];
      render();
    }
  }

  // ---------------------------------------------------------------- 动作

  async function copyAll() {
    if (!all.length) return;
    const text = all
      .slice()
      .sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0))
      .map((w) => w.w)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板', `${all.length} 个词，一行一个`);
    } catch (_) {
      toast('复制没有成功', '可以点「打开数据目录」，直接取那个 json 文件');
    }
  }

  async function clearAll() {
    if (!all.length) return;
    const n = all.length;
    const typed = await askUser(
      '清空本地敏感词库',
      `将删除本地收集的 ${n} 个词。内置词库与已提交的记录不受影响。请输入「清空」确认。`,
    );
    if (typed == null) return;
    if (String(typed).trim() !== '清空') {
      toast('没有清空', '输入的确认词不一致，词库保持原样');
      return;
    }
    await window.api.badword.clear();
    await load();
    toast('已清空本地收集', '下次发布触发审核时会重新开始记录');
  }

  /** 优先用主界面的输入弹窗；测试环境或异常时退回到内置 prompt 语义 */
  function askUser(title, hint) {
    if (typeof window.askText === 'function') {
      return window.askText({ title, hint, okText: '确认清空', cancelText: '取消' });
    }
    return Promise.resolve(null);
  }

  /** 轻量提示：设置页没有发布侧那条 toast，这里自带一个，避免操作后毫无反馈 */
  function toast(title, sub) {
    let el = document.getElementById('wordlibToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wordlibToast';
      el.className = 'wl-toast';
      document.body.appendChild(el);
    }
    el.innerHTML = `<b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`;
    el.classList.add('is-on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('is-on'), 2600);
  }

  async function openDir() {
    try {
      const file = await window.api.badword.dir();
      if (window.api.app && window.api.app.reveal) {
        await window.api.app.reveal(file);
      } else {
        await window.api.app.openPath(file);
      }
    } catch (_) {
      toast('没能打开目录', '可以在设置里查看数据目录位置');
    }
  }

  // ---------------------------------------------------------------- 绑定

  function bind() {
    if (!$('#panelWordlib')) return;

    $('#btnWordlibCopy').addEventListener('click', copyAll);
    $('#btnWordlibClear').addEventListener('click', clearAll);
    $('#btnWordlibDir').addEventListener('click', openDir);
    $('#btnWordlibMore').addEventListener('click', () => {
      showAll = !showAll;
      render();
    });

    // 订阅开关：本版只存值，真正拉取词库的逻辑留到后续
    const sub = $('#chkSubscribeWordlib');
    const saved = window.Prefs ? window.Prefs.get('subscribeWordlib', false) : false;
    sub.checked = saved === true;
    sub.addEventListener('change', () => {
      if (window.Prefs) window.Prefs.set('subscribeWordlib', !!sub.checked);
      // TODO(下一段)：开关打开时从项目发布地址拉取词库并合并到内置词表
    });

    document.addEventListener('wordlib:refresh', load);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.Wordlib = { reload: load, getAll: () => all.slice() };
})();
