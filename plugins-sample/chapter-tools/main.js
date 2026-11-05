'use strict';

/**
 * 章节小工具 —— 刺猬猫作家助手插件示例。
 *
 * 覆盖了全部 8 个接口：
 *   app.info / app.notify / editor.getContext / editor.setContent
 *   editor.insertText / stats.get / storage.get / storage.set
 *
 * 三条硬规矩（沙箱逼的，不是风格问题）：
 *   1. 不能联网、不能用 localStorage —— 要存东西用 PluginAPI.storage。
 *   2. 每个调用都是 Promise，必须 await + try/catch。
 *   3. 1 秒内不要超过 40 次调用，超限会被静默丢弃（15 秒后报超时）。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const API = window.PluginAPI;

  const DIVIDER = '\n\n＊　＊　＊\n\n';
  const GOAL_KEY = 'dailyGoal';

  let goal = 0;

  function say(text, isError) {
    const box = $('msg');
    box.textContent = text || '';
    box.classList.toggle('is-error', !!isError);
    if (text) API.app.notify(text).catch(() => {});
  }

  function num(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }

  /** 主题：沙箱里的 prefers-color-scheme 跟系统走，软件主题只能问 app.info() */
  async function applyTheme() {
    try {
      const info = await API.app.info();
      document.body.classList.toggle('is-dark', info.theme === 'dark');
    } catch (_) { /* 取不到就按浅色 */ }
  }

  async function loadGoal() {
    try {
      const v = await API.storage.get(GOAL_KEY);
      goal = Number(v) || 0;
      $('goalInput').value = goal ? String(goal) : '';
    } catch (err) {
      say('读取目标失败：' + err.message, true);
    }
  }

  /** 刷新：统计 + 本章信息，两个接口各调一次 */
  async function refresh() {
    try {
      const s = await API.stats.get();
      $('bookName').textContent = s.bookName || '—';
      $('chapterTitle').textContent = s.chapterTitle || '（没打开章节）';
      $('totalWords').textContent = s.totalWords ? num(s.totalWords) + ' 字' : '—';
      $('todayWords').textContent = num(s.todayWords) + ' 字';

      const ctx = await API.editor.getContext();
      $('chapterWords').textContent = ctx ? num(ctx.words) + ' 字' : '—';

      const today = Number(s.todayWords) || 0;
      if (goal > 0) {
        const pct = Math.min(100, Math.round((today / goal) * 100));
        $('progress').textContent = `${pct}%（目标 ${num(goal)}）`;
      } else {
        $('progress').textContent = '未设置目标';
      }
    } catch (err) {
      say('读取失败：' + err.message, true);
    }
  }

  async function saveGoal() {
    const v = Math.max(0, Math.round(Number($('goalInput').value) || 0));
    try {
      await API.storage.set(GOAL_KEY, v);
      goal = v;
      await refresh();
      say(v ? `目标已设为 ${num(v)} 字` : '目标已清空');
    } catch (err) {
      say('保存失败：' + err.message, true);
    }
  }

  async function insertDivider() {
    try {
      const ctx = await API.editor.getContext();
      if (!ctx) { say('请先在码字台打开一章', true); return; }
      const r = await API.editor.insertText(DIVIDER, 'end');
      await refresh();
      say(`已在末尾插入分隔符，现在 ${num(r.words)} 字`);
    } catch (err) {
      say('插入失败：' + err.message, true);
    }
  }

  /**
   * 给选中的文字套上【】。
   * 注意：setContent 是「整章覆盖」，所以必须先把原文取出来、改好再写回；
   * 不能凭空拼一段正文，否则整章会被替换掉。
   */
  async function bracketSelection() {
    try {
      const ctx = await API.editor.getContext();
      if (!ctx) { say('请先在码字台打开一章', true); return; }
      const picked = String(ctx.selectedText || '').trim();
      if (!picked) { say('先在编辑器里选中一段文字', true); return; }

      const at = String(ctx.content || '').indexOf(picked);
      if (at < 0) { say('没在正文里定位到选中的文字，请重新选中', true); return; }

      const next = ctx.content.slice(0, at) + '【' + picked + '】'
        + ctx.content.slice(at + picked.length);
      const r = await API.editor.setContent(next);
      await refresh();
      say(`已加方头括号，现在 ${num(r.words)} 字`);
    } catch (err) {
      say('处理失败：' + err.message, true);
    }
  }

  function bind() {
    $('refresh').addEventListener('click', refresh);
    $('saveGoal').addEventListener('click', saveGoal);
    $('divider').addEventListener('click', insertDivider);
    $('bracket').addEventListener('click', bracketSelection);
  }

  // main.js 注入在 </body> 前，DOM 已就绪，直接跑
  bind();
  applyTheme();
  loadGoal().then(refresh);
})();
