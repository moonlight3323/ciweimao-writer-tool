'use strict';

const DEFAULTS = { subscriptions: 10000, tier: 'D', bookSubscriptions: {} };
const RATES = Object.freeze({ D: 2, C: 4, B: 6, A: 8 });
let settings = { ...DEFAULTS, bookSubscriptions: {} };
let stats = { days: {}, savedBookDays: {}, books: [] };
let autoSaveTimer = null;
let settingsRevision = 0;
let settingsSaveQueue = Promise.resolve();

function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function shortDate(date) {
  return (date.getMonth() + 1) + '.' + String(date.getDate()).padStart(2, '0');
}

function money(value) { return '¥' + Math.max(0, Number(value) || 0).toFixed(2); }
function words(value) { return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('zh-CN'); }
function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
  });
}

function normaliseSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const tier = ['D', 'C', 'B', 'A'].includes(source.tier) ? source.tier : 'D';
  const bookSubscriptions = {};
  if (source.bookSubscriptions && typeof source.bookSubscriptions === 'object') {
    Object.entries(source.bookSubscriptions).forEach(function (entry) {
      bookSubscriptions[String(entry[0])] = numberOr(entry[1], DEFAULTS.subscriptions);
    });
  }
  return {
    subscriptions: numberOr(source.subscriptions, DEFAULTS.subscriptions),
    tier: tier,
    bookSubscriptions: bookSubscriptions,
  };
}

function booksList() {
  return Array.isArray(stats.books) ? stats.books : [];
}

function subscriptionFor(bookId) {
  return Object.prototype.hasOwnProperty.call(settings.bookSubscriptions, String(bookId))
    ? numberOr(settings.bookSubscriptions[String(bookId)], settings.subscriptions)
    : settings.subscriptions;
}

function calculateForKey(key) {
  const savedBookDays = stats.savedBookDays || {};
  const books = booksList().map(function (book) {
    const id = String(book.bookId);
    return {
      bookId: id,
      name: String(book.name || '未命名作品'),
      actual: Math.max(0, Number(savedBookDays[id] && savedBookDays[id][key]) || 0),
    };
  });
  const actual = books.reduce(function (total, book) { return total + book.actual; }, 0);
  const scale = actual > 20000 ? 20000 / actual : 1;
  let subscription = 0;
  books.forEach(function (book) {
    book.billable = book.actual * scale;
    book.subscription = book.billable / 2000 * (subscriptionFor(book.bookId) / 10000) * 400;
    subscription += book.subscription;
  });
  const billable = actual * scale;
  const attendance = actual >= 4000 ? billable / 1000 * RATES[settings.tier] : 0;
  return {
    actual: actual,
    billable: billable,
    subscription: subscription,
    attendance: attendance,
    total: subscription + attendance,
    books: books,
  };
}

function rangeRows(days) {
  // 刺猬猫的统计日从 06:00 开始；凌晨六点前仍显示为前一结算日。
  const today = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const rows = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    rows.push({ date: date, key: dayKey(date), income: calculateForKey(dayKey(date)) });
  }
  return rows;
}

function sum(rows, key) {
  return rows.reduce(function (total, row) { return total + row.income[key]; }, 0);
}

function selectedBookId() {
  return String(document.querySelector('#book').value || '');
}

function syncSubscriptionInput() {
  const id = selectedBookId();
  const input = document.querySelector('#subscriptions');
  input.disabled = !id;
  input.value = id ? subscriptionFor(id) : '';
}

function fillBookOptions() {
  const select = document.querySelector('#book');
  const previous = selectedBookId();
  const books = booksList();
  if (!books.length) {
    select.innerHTML = '<option value="">暂无作品</option>';
    select.disabled = true;
    syncSubscriptionInput();
    return;
  }
  select.disabled = false;
  select.innerHTML = books.map(function (book) {
    return '<option value="' + escapeHtml(String(book.bookId)) + '">' + escapeHtml(book.name || '未命名作品') + '</option>';
  }).join('');
  if (books.some(function (book) { return String(book.bookId) === previous; })) select.value = previous;
  syncSubscriptionInput();
}

function fillSettings() {
  document.querySelector('#tier').value = settings.tier;
  fillBookOptions();
}

function bookIncome(row, bookId) {
  const item = row.income.books.find(function (book) { return book.bookId === String(bookId); });
  return item || { actual: 0, subscription: 0 };
}

function renderBookRows(rows7, rows30, today) {
  const box = document.querySelector('#bookRows');
  const books = booksList();
  if (!books.length) {
    box.innerHTML = '<div class="book-empty">作品库为空，稿费统计为 0。</div>';
    return;
  }
  box.innerHTML = books.map(function (book) {
    const todayItem = bookIncome(today, book.bookId);
    const seven = rows7.reduce(function (total, row) {
      return total + bookIncome(row, book.bookId).subscription;
    }, 0);
    const thirty = rows30.reduce(function (total, row) {
      return total + bookIncome(row, book.bookId).subscription;
    }, 0);
    return '<div class="book-row"><strong title="' + escapeHtml(book.name) + '">' + escapeHtml(book.name) +
      '</strong><span>今日 ' + words(todayItem.actual) + ' 字 / ' + money(todayItem.subscription) +
      '</span><span>7日 ' + money(seven) + '</span><span>30日 ' + money(thirty) + '</span></div>';
  }).join('');
}

function render() {
  const rows30 = rangeRows(30);
  const rows7 = rows30.slice(-7);
  const today = rows30[rows30.length - 1];
  document.querySelector('#todayTotal').textContent = money(today.income.total);
  document.querySelector('#todayWords').textContent = '已保存 ' + words(today.income.actual) + ' 字';
  document.querySelector('#sevenTotal').textContent = money(sum(rows7, 'total'));
  document.querySelector('#sevenWords').textContent = '累计 ' + words(sum(rows7, 'actual')) + ' 字';
  document.querySelector('#thirtyTotal').textContent = money(sum(rows30, 'total'));
  document.querySelector('#thirtyWords').textContent = '累计 ' + words(sum(rows30, 'actual')) + ' 字';
  document.querySelector('#todayBonus').textContent = money(today.income.attendance);
  document.querySelector('#attendanceHint').textContent = today.income.actual >= 4000
    ? settings.tier + '档 ' + RATES[settings.tier] + ' 元/千字，今日已达标'
    : '距 4,000 字门槛还差 ' + words(4000 - today.income.actual) + ' 字';
  document.querySelector('#tierBadge').textContent = settings.tier + '档 · ' + RATES[settings.tier] + '元/千字';
  document.querySelector('#breakdown').textContent = '30日订阅稿费 ' + money(sum(rows30, 'subscription')) +
    ' · 全勤奖励 ' + money(sum(rows30, 'attendance'));
  const limit = document.querySelector('#limitNote');
  limit.classList.toggle('is-warning', today.income.actual > 20000);
  limit.textContent = today.income.actual > 20000
    ? '每日 06:00 刷新；今日所有作品合计保存 ' + words(today.income.actual) + ' 字，超过 20,000 字的部分未计入稿费预估。'
    : '每日 06:00 刷新；所有作品每天合计最多按 20,000 字计算，合计达到 4,000 字后计入一次全勤奖励。';

  const max = Math.max.apply(null, [1].concat(rows30.map(function (row) { return row.income.total; })));
  document.querySelector('#incomeChart').innerHTML = rows30.map(function (row) {
    const height = row.income.total ? Math.max(2, Math.round(row.income.total / max * 100)) : 0;
    return '<div class="bar" title="' + dayKey(row.date) + '：' + money(row.income.total) + ' · ' +
      words(row.income.actual) + '字"><i style="height:' + height + '%"></i><span>' +
      shortDate(row.date) + '</span></div>';
  }).join('');
  renderBookRows(rows7, rows30, today);
}

async function reload() {
  settings = normaliseSettings(await PluginAPI.storage.get('settings'));
  stats = await PluginAPI.stats.get() || { days: {}, savedBookDays: {}, books: [] };
  fillSettings();
  render();
}

function readSettingsForm() {
  const next = normaliseSettings(settings);
  next.tier = document.querySelector('#tier').value;
  const id = selectedBookId();
  if (id) next.bookSubscriptions[id] = numberOr(document.querySelector('#subscriptions').value, next.subscriptions);
  return next;
}

function previewSettings() {
  settings = readSettingsForm();
  render();
}

async function persistSettings(notify) {
  clearTimeout(autoSaveTimer);
  settings = readSettingsForm();
  render();
  const snapshot = JSON.parse(JSON.stringify(settings));
  const revision = ++settingsRevision;
  document.querySelector('#saveState').textContent = '正在自动保存…';
  settingsSaveQueue = settingsSaveQueue.catch(function () {}).then(function () {
    return PluginAPI.storage.set('settings', snapshot);
  });
  await settingsSaveQueue;
  if (revision === settingsRevision) document.querySelector('#saveState').textContent = '已自动保存并生效';
  if (notify) await PluginAPI.app.notify('稿费计算设置已保存');
}

function scheduleSettingsSave() {
  previewSettings();
  document.querySelector('#saveState').textContent = '正在自动保存…';
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(function () {
    persistSettings(false).catch(function (error) {
      document.querySelector('#saveState').textContent = error.message;
    });
  }, 180);
}

document.querySelector('#book').addEventListener('change', syncSubscriptionInput);
document.querySelector('#subscriptions').addEventListener('input', scheduleSettingsSave);
document.querySelector('#tier').addEventListener('change', function () {
  previewSettings();
  persistSettings(false).catch(function (error) {
    document.querySelector('#saveState').textContent = error.message;
  });
});
document.querySelector('#save').addEventListener('click', function () {
  persistSettings(true).catch(function (error) {
    document.querySelector('#saveState').textContent = error.message;
  });
});
document.querySelector('#refresh').addEventListener('click', reload);

reload().catch(function (error) { document.querySelector('#saveState').textContent = error.message; });
setInterval(async function () {
  stats = await PluginAPI.stats.get() || { days: {}, savedBookDays: {}, books: [] };
  fillBookOptions();
  render();
}, 3000);
