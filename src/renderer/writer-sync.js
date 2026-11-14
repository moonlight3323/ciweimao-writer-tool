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

  /**
   * 后台章节号为空、但本地确实已经发布过的章节，用「卷 + 序号 / 标题」对上后台章节，
   * 把章节号补回去。
   *
   * 为什么需要：发布成功时站点偶尔不给 url（拿不到 chapter_id），本地只知道
   * 「这章发出去了」，却没有后台章节号。下一次同步就会把这章当成「后台新增」，
   * 再拉一份回来 —— 列表里于是出现两条同名章节，其中一条标着「已发布 · 冲突」。
   * 这里先按标题/序号认领，认领过的就不会再被当成新增。
   *
   * 只处理已发布（已上架）的章节：本地草稿故意不认领，否则作者在后台新发的章
   * 会被本地的同名草稿吞掉，看不到内容。
   */
  function linkPublishedChapters(localChapters, remoteChapters) {
    const remotes = Array.isArray(remoteChapters) ? remoteChapters : [];
    const byKey = new Map();
    for (const remote of remotes) {
      const id = String(remote && remote.chapterId || '').trim();
      const key = chapterConflictKey(remote);
      if (id && key && !byKey.has(key)) byKey.set(key, id);
    }
    let linked = 0;
    const used = new Set(
      (Array.isArray(localChapters) ? localChapters : []).map(remoteChapterId).filter(Boolean)
    );
    for (const chapter of (Array.isArray(localChapters) ? localChapters : [])) {
      if (remoteChapterId(chapter)) continue;
      const published = String(chapter.status || '').toLowerCase() === 'published'
        || String(chapter.origin || '').toLowerCase() === 'platform';
      if (!published) continue;
      const key = chapterConflictKey(chapter);
      const id = key ? byKey.get(key) : '';
      if (!id || used.has(id)) continue;
      chapter.platformChapterId = id;
      used.add(id);
      linked += 1;
    }
    return linked;
  }

  function missingRemoteChapters(localChapters, remoteChapters) {
    const list = Array.isArray(localChapters) ? localChapters : [];
    const known = new Set(list.map(remoteChapterId).filter(Boolean));
    // 标题 / 序号也对一遍：本地有这一章（草稿或已发布但没章节号）就不算「后台新增」。
    // 以前只比章节号，于是「发布时没拿到 chapter_id」的章会被重复拉回来，
    // 与本地那章撞成「同章冲突」。
    const knownKeys = new Set(list.map(chapterConflictKey).filter(Boolean));
    return (Array.isArray(remoteChapters) ? remoteChapters : []).filter((chapter) => {
      const id = String(chapter && chapter.chapterId || '').trim();
      if (!id || known.has(id)) return false;
      const key = chapterConflictKey(chapter);
      return !(key && knownKeys.has(key));
    });
  }

  const api = {
    remoteChapterId,
    chapterConflictKey,
    findChapterConflict,
    linkPublishedChapters,
    missingRemoteChapters,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WriterSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
