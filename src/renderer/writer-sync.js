'use strict';

/**
 * 创作中心与作者后台之间的章节匹配规则。
 *
 * 旧版本已经保存的后台章节只有 `id: chapter_<后台章节号>`，新版本会额外
 * 保存 `platformChapterId`。这里把两种格式统一成后台章节号；本地手动新建
 * 的空章节不会被误认为已经同步过的后台章节。
 */
(function (root) {
  function remoteChapterId(chapter) {
    const c = chapter || {};
    const explicit = String(c.platformChapterId || '').trim();
    if (explicit) return explicit;

    const id = String(c.id || '').trim();
    const legacy = id.match(/^chapter_(\d+)$/);
    if (legacy && String(c.content || '').trim()) return legacy[1];
    return '';
  }

  function missingRemoteChapters(localChapters, remoteChapters) {
    const known = new Set(
      (Array.isArray(localChapters) ? localChapters : [])
        .map(remoteChapterId)
        .filter(Boolean)
    );
    return (Array.isArray(remoteChapters) ? remoteChapters : []).filter((chapter) => {
      const id = String(chapter && chapter.chapterId || '').trim();
      return id && !known.has(id);
    });
  }

  const api = { remoteChapterId, missingRemoteChapters };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WriterSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
