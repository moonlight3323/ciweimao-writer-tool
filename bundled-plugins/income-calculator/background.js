'use strict';

let busy = false;
let hasPublished = false;

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function dayKey(date) {
  const shifted = new Date(date.getTime() - 6 * 60 * 60 * 1000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalise(value) {
  const source = value && typeof value === 'object' ? value : {};
  const tier = ['D', 'C', 'B', 'A'].includes(source.tier) ? source.tier : 'D';
  const bookSubscriptions = source.bookSubscriptions && typeof source.bookSubscriptions === 'object'
    ? source.bookSubscriptions : {};
  return {
    subscriptions: numberOr(source.subscriptions, 10000),
    bookSubscriptions,
    tier,
  };
}

async function update() {
  if (busy) return;
  busy = true;
  try {
    if (!hasPublished) {
      await PluginAPI.ui.setEditorStat({
        label: '本章预计稿费',
        value: '正在计算…',
        detail: '正在读取已保存字数',
      });
    }
    const settings = normalise(await PluginAPI.storage.get('settings'));
    const stats = await PluginAPI.stats.get() || { days: {} };
    const sourceDays = stats.savedDays || stats.days || {};
    const words = Number(sourceDays[dayKey(new Date())]) || 0;
    const currentBookId = String(stats.currentBookId || '');
    const savedBookDays = stats.savedBookDays || {};
    const bookWords = Number(savedBookDays[currentBookId] && savedBookDays[currentBookId][dayKey(new Date())]) || 0;
    const subscriptions = Object.prototype.hasOwnProperty.call(settings.bookSubscriptions, currentBookId)
      ? numberOr(settings.bookSubscriptions[currentBookId], settings.subscriptions) : settings.subscriptions;
    const chapterWords = Math.max(0, Number(stats.currentChapterSavedWords) || 0);
    const bookBillable = words > 20000 && words > 0 ? bookWords * (20000 / words) : bookWords;
    const chapterBillable = Math.min(chapterWords, 20000);
    const subscription = bookBillable / 2000 * (subscriptions / 10000) * 400;
    const chapterSubscription = chapterBillable / 2000 * (subscriptions / 10000) * 400;
    const detail = `本章 ${chapterWords.toLocaleString('zh-CN')} 字 · 本书今日 ¥${subscription.toFixed(2)} · 全部 ${words.toLocaleString('zh-CN')} 字`;
    await PluginAPI.ui.setEditorStat({
      label: '本章预计稿费',
      value: `¥${chapterSubscription.toFixed(2)}`,
      detail,
    });
    hasPublished = true;
  } catch (err) {
    try {
      await PluginAPI.ui.setEditorStat({
        label: '稿费计算器',
        value: '更新失败',
        detail: String((err && err.message) || err || '未知错误').slice(0, 80),
      });
    } catch (_) { /* 宿主通信失败时等待下一轮重试 */ }
  } finally {
    busy = false;
  }
}

update();
setInterval(update, 1200);
