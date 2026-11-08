'use strict';

/**
 * 密码本条目的展示排序与脱敏
 *
 * 单独成文件的原因：vault.js 依赖 electron 的 safeStorage，在纯 Node 里跑不起来，
 * 于是「怎么排序」「哪些字段能给界面看」这两件最容易被改坏的事就没法测。
 * 抽出来之后可以不碰 electron 直接跑测试。
 */

/**
 * 对外（渲染进程）可见的字段，**永远不含密码**。
 * 加字段时只加在这里，别在 vault.js 里另拼一份。
 */
function redact(it) {
  return {
    id: it.id,
    label: it.label || it.username,
    mode: it.mode || 'account',
    username: it.username,
    // 作者名：多账号用户靠它区分「这条是哪个笔名的」
    authorName: it.authorName || '',
    authorBoundAt: it.authorBoundAt || '',
    updatedAt: it.updatedAt,
    lastUsedAt: it.lastUsedAt || '',
  };
}

/**
 * 展示顺序：先按作者名分组，组内按最近使用。
 *
 * 多账号用户真正在意的是「哪个笔名」，所以有作者名的排前面；
 * 没绑作者名的老记录统一沉到后面，用户一眼能看到还需要补哪些。
 */
function sortItems(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  const nameOf = (it) => String(it.authorName || '').trim();
  return list.sort((a, b) => {
    const an = nameOf(a);
    const bn = nameOf(b);
    if (!an && bn) return 1;
    if (an && !bn) return -1;
    if (an && bn && an !== bn) return an.localeCompare(bn, 'zh-CN');
    return String(b.lastUsedAt || b.updatedAt || '')
      .localeCompare(String(a.lastUsedAt || a.updatedAt || ''));
  });
}

/** 下拉里的显示名：有作者名就以作者名为主，账号放后面 */
function optionLabel(it) {
  const author = String((it && it.authorName) || '').trim();
  const account = String((it && it.username) || '');
  const suffix = it && it.mode === 'email' ? '（邮箱登录）' : '';
  if (!author) return `${account}${suffix} · 未标作者名`;
  if (author === account) return `${author}${suffix}`;
  return `${author} · ${account}${suffix}`;
}

const api = { redact, sortItems, optionLabel };

if (typeof module === 'object' && module.exports) module.exports = api;
else globalThis.VaultOrder = api;
