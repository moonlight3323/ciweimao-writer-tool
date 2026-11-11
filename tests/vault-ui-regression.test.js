'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const adapter = require('../src/adapters/ciweimao');
const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const tick = () => new Promise(setImmediate);

function classes(initial = []) {
  const values = new Set(initial);
  return { add: name => values.add(name), remove: name => values.delete(name), contains: name => values.has(name),
    toggle(name, on) { if (on) values.add(name); else values.delete(name); } };
}

for (const mode of ['account', 'email']) {
  test(`密码填入 ${mode} 模式同步全部分组，不执行站点页签脚本`, async () => {
    const account = [0, 1].map(() => ({ classList: classes(['hide']) }));
    const email = [0, 1].map(() => ({ classList: classes() }));
    const tabs = { account: { classList: classes(), click() { throw new Error('不能触发站点页签'); } },
      email: { classList: classes(['active']), click() { throw new Error('不能触发站点页签'); } } };
    class Input {
      constructor(pane) { this.pane = pane; this.events = []; this._value = ''; }
      get value() { return this._value; }
      set value(value) { this._value = value; }
      dispatchEvent(event) { this.events.push(event.type); }
      getBoundingClientRect() { return { width: this.pane.classList.contains('hide') ? 0 : 120, height: 0 }; }
      focus() {}
    }
    const fields = { inputAccount: new Input(account[0]), inputAccountPasswd: new Input(account[1]),
      inputEmail: new Input(email[0]), inputPasswd: new Input(email[1]), author_login_type: {} };
    const context = vm.createContext({
      window: { HTMLInputElement: Input, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
      Event: class { constructor(type) { this.type = type; } },
      setTimeout() { throw new Error('填入不应等待页签切换'); },
      document: { getElementById: id => fields[id],
        querySelectorAll: selector => selector === '.type-account' ? account : selector === '.type-email' ? email : [],
        querySelector: selector => selector.includes('"account"') ? tabs.account : tabs.email },
    });
    const result = await vm.runInContext(adapter.pageSource('fillLoginForm', { mode, username: 'fixture-user', password: 'fixture-password' }), context);
    assert.equal(result.ok, true);
    assert.equal(fields[mode === 'email' ? 'inputEmail' : 'inputAccount'].value, 'fixture-user');
    assert.equal(fields[mode === 'email' ? 'inputPasswd' : 'inputAccountPasswd'].value, 'fixture-password');
    assert.equal(fields.author_login_type.value, mode);
    for (const pane of account) assert.equal(pane.classList.contains('hide'), mode === 'email');
    for (const pane of email) assert.equal(pane.classList.contains('hide'), mode !== 'email');
  });
}

function promptHarness({ guide = false, missing = false, pending = false } = {}) {
  const elements = new Map(), calls = [], frames = [];
  function element() {
    const events = new Map();
    return { hidden: true, value: '', classList: classes(), focus() {}, select() {},
      addEventListener(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
      removeEventListener(name, callback) { events.get(name)?.delete(callback); },
      fire(name = 'click', event = {}) { for (const callback of [...(events.get(name) || [])]) callback(event); } };
  }
  for (const id of ['textPrompt', 'textPromptInput', 'textPromptHint', 'textPromptTitle', 'textPromptOk', 'textPromptCancel',
    'guideDialog', 'updateDialog', 'updateCompleteDialog']) elements.set(id, element());
  if (missing) elements.delete('textPromptInput');
  elements.get('guideDialog').hidden = !guide;
  const body = { classList: classes(guide ? ['is-locked'] : []) };
  let release;
  const gate = pending ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const context = vm.createContext({
    document: { body, getElementById: id => elements.get(id) || null },
    $: selector => elements.get(selector.slice(1)) || null,
    requestAnimationFrame: callback => frames.push(callback), setTimeout: callback => callback(),
    window: { prepareUpdateOverlay: async () => { calls.push('detach'); await gate; return { browser: true }; },
      restoreUpdateOverlay: async () => { calls.push('restore'); } },
  });
  vm.runInContext(app.slice(app.indexOf('function askText('), app.indexOf('const HOST =')), context);
  return { context, body, calls, get: id => elements.get(id), ask: options => context.askText(options),
    release: () => release(), frame() { for (const callback of frames.splice(0)) callback(); } };
}

test('作者名弹窗等待网页摘下，关闭两帧后恢复同一页面', async () => {
  const h = promptHarness({ pending: true });
  const answer = h.ask({ title: '作者名', value: '旧笔名' });
  await tick(); assert.equal(h.get('textPrompt').hidden, true);
  h.release(); await tick();
  assert.equal(h.get('textPrompt').hidden, false);
  assert.equal(h.body.classList.contains('is-locked'), true);
  h.get('textPromptInput').value = '新笔名'; h.get('textPromptOk').fire();
  assert.equal(await answer, '新笔名');
  assert.equal(h.get('textPrompt').hidden, true);
  assert.equal(h.body.classList.contains('is-locked'), false);
  h.frame(); assert.deepEqual(h.calls, ['detach']);
  h.frame(); assert.deepEqual(h.calls, ['detach', 'restore']);
});

test('嵌套输入弹窗保留外层遮罩的锁定与页面所有权', async () => {
  const h = promptHarness({ guide: true });
  const answer = h.ask(); await tick(); h.get('textPromptCancel').fire();
  assert.equal(await answer, null); h.frame(); h.frame();
  assert.equal(h.body.classList.contains('is-locked'), true);
  assert.deepEqual(h.calls, []);
});

test('连续输入弹窗之间不恢复原生网页，最后一次关闭才恢复', async () => {
  const h = promptHarness(); const first = h.ask(); await tick();
  h.get('textPromptOk').fire(); await first;
  const second = h.ask(); await tick(); h.frame(); h.frame();
  assert.equal(h.calls.includes('restore'), false);
  h.get('textPromptCancel').fire(); await second; h.frame(); h.frame();
  assert.equal(h.calls.filter(call => call === 'restore').length, 1);
});

test('缺少输入控件时不摘除网页', async () => {
  const h = promptHarness({ missing: true });
  assert.equal(await h.ask(), null); assert.deepEqual(h.calls, []);
});

for (const kind of ['existing', 'new', 'restore']) {
  test(`作者后台 ${kind} 场景没有导航事件也会刷新密码本状态`, async () => {
    const calls = [], states = [];
    const ready = kind !== 'new';
    const loginState = { ready: true, url: 'https://author.ciweimao.com/login', isLoginPage: true };
    let opened = false;
    const context = vm.createContext({
      console, miaoyuOpen: false, HOST: { classList: classes() },
      requestAnimationFrame: callback => callback(), currentRect: () => ({}), setBrowserChrome() {},
      applyBrowserState: state => states.push(state),
      window: { api: { browser: { state: async () => ready || opened ? loginState : { ready: false },
        show: async () => calls.push('show'), open: async () => { opened = true; calls.push('open'); } } } },
    });
    const start = app.indexOf('async function openBrowser('), end = app.indexOf('window.showBrowserKeepPage =', start);
    vm.runInContext(app.slice(start, end), context);
    if (kind === 'restore') await context.showBrowserKeepPage(); else await context.openBrowser();
    assert.deepEqual(calls, [kind === 'new' ? 'open' : 'show']);
    assert.equal(states.length, 1); assert.equal(states[0].isLoginPage, true);
  });
}
