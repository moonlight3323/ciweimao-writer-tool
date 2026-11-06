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
    // 本地新建章节使用 chapter_<时间戳>，不能把 13 位时间戳误当成后台章节号。
    const legacy = id.match(/^chapter_(\d{5,10})$/);
    if (legacy && String(c.content || '').trim()) return legacy[1];
    return '';
  }

  function normaliseTitle(title) {
    return String(title || '')
      .replace(/[\s　]+/g, '')
      .replace(/[（(][^）)]*[）)]$/g, '')
      .toLowerCase();
  }

  function chapterConflictKey(chapter) {
    const c = chapter || {};
    const volume = String(c.volume || '正文').replace(/[\s　]+/g, '').toLowerCase();
    const title = String(c.title || '');
    let seq = null;
    if (root.ChapterOrder && typeof root.ChapterOrder.chapterSeq === 'function') {
      seq = root.ChapterOrder.chapterSeq(title);
    } else {
      const matched = title.match(/第\s*(\d{1,8})\s*[章节回篇]/);
      if (matched) seq = Number(matched[1]);
    }
    if (Number.isFinite(seq)) return `${volume}|number:${seq}`;
    const normalised = normaliseTitle(title);
    return normalised ? `${volume}|title:${normalised}` : '';
  }

  function findChapterConflict(localChapters, remoteChapter) {
    const key = chapterConflictKey(remoteChapter);
    if (!key) return null;
    const candidates = (Array.isArray(localChapters) ? localChapters : [])
      .map((chapter) => ({ chapter, key: chapterConflictKey(chapter) }))
      .filter((item) => item.key === key);
    // 未发布的本地章节优先作为冲突对象；如果它已经有旧数据，仍保留并标记冲突。
    return candidates.find((item) => String(item.chapter.status || '') !== 'published')
      || candidates[0]
      || null;
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

  const api = {
    remoteChapterId,
    chapterConflictKey,
    findChapterConflict,
    missingRemoteChapters,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WriterSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
