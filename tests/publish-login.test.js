'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publish = fs.readFileSync(path.join(__dirname, '../src/renderer/publish.js'), 'utf8');
const origin = 'https://author.ciweimao.com';
const loginUrl = `${origin}/login/index`;
const homeUrl = `${origin}/homepage`;
const draftUrl = `${origin}/book_manage/draft?book_id=123`;

function setup({ startOnLogin, abortOnRedirect, pendingOnRedirect } = {}) {
  let url = startOnLogin ? loginUrl : '';
  let loggedIn = false;
  let click;
  let now = 0;
  const navigations = [];
  const pageCalls = [];
  const filled = [];
  const status = {};
  const elements = {
    '#btnWriterPublish': { addEventListener: (_event, handler) => { click = handler; } },
    '#pubStatus': {},
    '#pubStatusText': status,
  };
  const context = vm.createContext({
    document: { readyState: 'complete', querySelector: (selector) => elements[selector], addEventListener() {} },
    URL,
    Date: { now: () => now },
    setTimeout: (fn, ms) => { if (ms <= 500) { now += ms; fn(); } },
    clearTimeout() {},
    setInterval() {},
    Writer: {
      currentBook: () => ({ id: 'local', name: '作品', platformBookId: '123' }),
      currentChapter: () => ({ id: 'chapter', title: '第一章', vol: '正文' }),
      getText: () => '章节内容',
      saveNow: async () => {},
    },
    showBrowserKeepPage: async () => {},
    CiweimaoAdapter: { pageSource: (name, args) => ({ name, args }) },
    BadWords: { textToHtml: (text) => `<p>${text}</p>` },
    api: { browser: {
      onEvent() {},
      state: async () => ({ ready: true, url, isLoginPage: !url || url === loginUrl }),
      navigate: async (target) => {
        navigations.push(target);
        url = loggedIn ? target : loginUrl;
        if (!loggedIn && abortOnRedirect) throw new Error('ERR_ABORTED');
        if (!loggedIn && pendingOnRedirect) await new Promise(() => {});
      },
      waitIdle: async () => true,
      evalInPage: async ({ name, args }) => {
        pageCalls.push(name);
        if (name === 'pageChapterState') return { url, hasForm: url === draftUrl, hasEditor: url === draftUrl };
        if (name === 'pageFillChapter') filled.push(args);
        return { ok: true };
      },
    } },
  });
  context.window = context;
  vm.runInContext(publish, context);
  return {
    click: () => click(), status, navigations, pageCalls, filled,
    isBusy: () => context.Publish.state.busy,
    login() { loggedIn = true; url = homeUrl; },
  };
}

for (const [scenario, options, firstNavigations] of [
  ['未打开后台时被重定向到登录页', {}, [draftUrl]],
  ['后台已经停在登录页', { startOnLogin: true }, []],
  ['登录重定向中止原导航', { abortOnRedirect: true }, [draftUrl]],
  ['已显示登录页但原导航还在等待', { pendingOnRedirect: true }, [draftUrl]],
]) {
  test(`${scenario}，登录后重新点击即可填表`, async () => {
    const app = setup(options);
    await app.click();
    assert.deepEqual(app.navigations, firstNavigations);
    assert.deepEqual(app.pageCalls, [], '登录页无需轮询章节表单');
    assert.match(app.status.textContent, /完成登录.*再点/);
    assert.equal(app.isBusy(), false);

    app.login();
    await app.click();
    assert.deepEqual(app.navigations, [...firstNavigations, draftUrl]);
    assert.equal(app.filled.length, 1);
    assert.equal(app.filled[0].title, '第一章');
    assert.equal(app.filled[0].html, '<p>章节内容</p>');
    assert.equal(app.isBusy(), false);
  });
}
