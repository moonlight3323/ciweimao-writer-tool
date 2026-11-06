'use strict';

/**
 * 更新提示：横幅 + 确认对话框。
 *
 * 交互约定（与需求一一对应）：
 * - 不在启动时自动弹窗，只挂一条 32px 高的横幅；用户点它才展开详情。
 * - 「稍后提醒」只影响本次运行，「跳过此版本」写入偏好且该版本永不再提示。
 * - 所有失败提示都带上当前版本号，让用户明确知道「没被搞坏、还能继续用」。
 *
 * 清单内容来自网络，渲染前一律转义：只允许纯文本，不拼接任何 HTML。
 */
(function () {
  const api = window.api && window.api.update;
  if (!api) return;

  const $ = (sel) => document.querySelector(sel);

  /** 本次运行的状态：不写入磁盘，重启即重置 */
  let info = null;
  let dismissed = false;
  let busy = false;
  let checking = false;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ------------------------------------------------------------------ 横幅

  function showBar(text) {
    const bar = $('#updateBar');
    if (!bar) return;
    $('#updateBarText').textContent = text;
    bar.hidden = dismissed;
    requestAnimationFrame(() => bar.classList.add('is-on'));
  }

  function hideBar() {
    const bar = $('#updateBar');
    if (!bar) return;
    bar.classList.remove('is-on');
    bar.hidden = true;
  }

  // ---------------------------------------------------------------- 对话框

  function setTitle(text) { $('#updateTitle').textContent = text; }

  function setStatus(text, tone) {
    const el = $('#updateStatus');
    el.hidden = !text;
    el.textContent = text || '';
    el.dataset.tone = tone || '';
  }

  /** 底部按钮按阶段整体替换，避免残留上一阶段的按钮造成误点 */
  function setActions(list) {
    const box = $('#updateActions');
    box.innerHTML = '';
    list.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = a.primary ? 'btn primary' : 'btn ghost';
      b.textContent = a.label;
      b.disabled = !!a.disabled;
      if (a.title) b.title = a.title;
      b.addEventListener('click', a.onClick);
      box.appendChild(b);
    });
  }

  function renderChanges(bundle, fallback) {
    const box = $('#updateChanges');
    const empty = $('#updateEmpty');
    box.innerHTML = '';

    if (fallback || !bundle || !bundle.length) {
      box.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    box.hidden = false;

    bundle.forEach((entry) => {
      const group = document.createElement('div');
      group.className = 'update-group';

      const head = document.createElement('div');
      head.className = 'update-group-head';
      head.textContent = `v${entry.version}${entry.date ? ' · ' + entry.date : ''}`;
      group.appendChild(head);

      if (entry.items && entry.items.length) {
        const ul = document.createElement('ul');
        ul.className = 'update-items';
        entry.items.forEach((line) => {
          const li = document.createElement('li');
          li.textContent = line;
          ul.appendChild(li);
        });
        group.appendChild(ul);
      }
      box.appendChild(group);
    });
  }

  function openDialog() {
    $('#updateDialog').hidden = false;
  }

  function closeDialog() {
    $('#updateDialog').hidden = true;
  }

  function setSettingsCheck(text, tone, tag) {
    const hint = $('#updateSettingsHint');
    const badge = $('#updateSettingsTag');
    if (hint) {
      hint.textContent = text;
      hint.dataset.tone = tone || '';
    }
    if (badge && tag) badge.textContent = tag;
  }

  async function checkLatest(manual) {
    if (checking) return null;
    checking = true;
    const button = $('#btnCheckUpdate');
    if (button) {
      button.disabled = true;
      button.textContent = '正在检查…';
    }
    if (manual) setSettingsCheck('正在连接 GitHub 获取最新版本…', '', '检查中');

    try {
      const result = await api.check();
      if (!result || !result.available) {
        info = null;
        const current = result && result.current ? result.current : '当前版本';
        setSettingsCheck(`已经是最新版本（v${current}）。`, 'ok', `v${current}`);
        if (manual) hideBar();
        return result;
      }

      info = result;
      setSettingsCheck(
        `发现新版本 v${info.version}，更新包 ${info.sizeText}。`,
        'warn',
        `可更新至 v${info.version}`,
      );

      // 启动时尊重“跳过此版本”；用户主动检查时仍允许重新查看并安装。
      if (info.skipped && !manual) {
        setSettingsCheck(`v${info.version} 已被跳过；点击“立即检查更新”仍可重新安装。`, '', `已跳过 v${info.version}`);
        return result;
      }

      if (manual) dismissed = false;
      if (info.readyToRestart) showBar(`v${info.version} 已下载，重启后生效`);
      else showBar(`发现新版本 v${info.version} · 更新包 ${info.sizeText}`);

      if (manual) {
        openDialog();
        renderConfirm();
      }
      return result;
    } catch (err) {
      if (manual) {
        setSettingsCheck(`检查失败：${err && err.message ? err.message : '无法连接更新服务器'}`, 'error', '检查失败');
      }
      return null;
    } finally {
      checking = false;
      if (button) {
        button.disabled = false;
        button.textContent = '立即检查更新';
      }
    }
  }

  /** 主展示：确认阶段的画面 */
  function renderConfirm() {
    const across = info.across || 0;
    setTitle(across > 1 ? `本次更新（跨 ${across} 个版本）` : '本次更新');
    $('#updateMeta').textContent =
      `当前版本 v${info.current} → 新版本 v${info.version}　更新包 ${info.sizeText}`;

    const full = $('#updateFull');
    if (info.type === 'full') {
      full.hidden = false;
      full.textContent = `这次是完整包（含运行时升级），体积较大，约 ${info.sizeText}。下载完会提示你重启，重启后自动生效。`;
    } else {
      full.hidden = true;
    }

    renderChanges(info.bundle, info.fallback);
    setStatus('');
    setActions([
      {
        label: '稍后提醒',
        onClick: () => {
          dismissed = true;
          hideBar();
          closeDialog();
        },
      },
      {
        label: '跳过此版本',
        title: `以后不再提示 v${info.version}`,
        onClick: async () => {
          const r = await api.skip(info.version);
          if (r && r.ok) dismissed = true;
          hideBar();
          closeDialog();
        },
      },
      { label: info.readyToRestart ? '重启并安装' : '立即升级', primary: true, onClick: startDownload },
    ]);
  }

  // ------------------------------------------------------------ 下载与安装

  /** 给进度条用的体积文案，和后端 humanSize 保持同一口径 */
  function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '0 KB';
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  let downloadTotal = 0;

  /**
   * 下载进度。
   *
   * 包只有 1 MB 出头，正常几秒就完，所以不做节流 —— 少写点代码，
   * 也让「很快下完」这件事在界面上看得见，而不是一闪而过什么都不显示。
   */
  function setProgress(bytes) {
    const wrap = $('#updateProgress');
    if (!wrap) return;
    const got = Math.max(0, Number(bytes) || 0);
    const total = downloadTotal > 0 ? downloadTotal : 0;
    const pct = total > 0 ? Math.min(100, Math.round((got / total) * 100)) : 0;

    wrap.hidden = false;
    $('#updateProgressFill').style.width = `${pct}%`;
    $('#updateProgressText').textContent = total > 0 ? `${pct}%` : '下载中';
    $('#updateProgressBytes').textContent =
      total > 0 ? `${humanSize(got)} / ${humanSize(total)}` : humanSize(got);
  }

  function hideProgress() {
    const wrap = $('#updateProgress');
    if (wrap) wrap.hidden = true;
  }

  async function startDownload() {
    if (busy) return;
    busy = true;

    downloadTotal = Number(info.size) || 0;
    setTitle('正在下载更新');
    $('#updateMeta').textContent = `v${info.current} → v${info.version}　${info.sizeText}`;
    setStatus('正在下载更新包，下载完成后会自动校验完整性。', 'busy');
    setProgress(0);
    setActions([{ label: '取消', onClick: () => { hideProgress(); closeDialog(); busy = false; } }]);

    const r = await api.download();
    busy = false;

    if (!r || !r.ok) {
      hideProgress();
      // 失败也要把当前版本号说清楚：用户最担心的是「是不是把我软件弄坏了」
      setTitle('这次没能装上新版本');
      setStatus(r && r.message ? r.message : `没能下到更新包，当前版本 v${info.current} 可继续使用`, 'error');
      setActions([
        { label: '重试', primary: true, onClick: startDownload },
        { label: '稍后提醒', onClick: () => { closeDialog(); } },
      ]);
      return;
    }

    // 下载完但还没解压：进度条走满，文字说明改口，别让人以为卡住了
    setProgress(downloadTotal || (r.bytes || 0));
    setStatus('下载完成，正在校验完整性…', 'busy');
    renderReady(r);
  }

  function renderReady(r) {
    setTitle('更新包已就绪');
    hideProgress();
    setStatus(
      `已下载完成并校验通过（${r.sizeText || ''}），重启后生效。重启期间界面会关闭几秒，回来就是新版本了。`,
      'ok',
    );
    setActions([
      { label: '稍后重启', onClick: () => { closeDialog(); showBar(`v${info.version} 已下载，重启后生效`); } },
      { label: '立即重启', primary: true, onClick: restartNow },
    ]);
  }

  async function restartNow() {
    if (busy) return;
    busy = true;
    setStatus('正在准备安装，软件会短暂关闭后自动打开。', 'busy');
    setActions([]);

    const r = await api.install();

    if (r && r.ok && r.manual) {
      // 完整包不自动替换，只告诉用户文件在哪、怎么用
      busy = false;
      setTitle('完整包已下载完成');
      setStatus(
        `文件位置：${r.packagePath}\n解压后覆盖安装目录即可生效；当前版本 v${info.current} 可以继续使用。`,
        'ok',
      );
      setActions([
        {
          label: '打开所在文件夹',
          onClick: () => { if (window.api.app && window.api.app.reveal) window.api.app.reveal(r.packagePath); },
        },
        { label: '知道了', primary: true, onClick: () => { closeDialog(); hideBar(); } },
      ]);
      return;
    }

    if (!r || !r.ok) {
      busy = false;
      setTitle('这次没能装上新版本');
      setStatus(
        r && r.message ? r.message : `安装没有开始，当前版本 v${info.current} 可继续使用`,
        'error',
      );
      setActions([
        { label: '重试', primary: true, onClick: restartNow },
        { label: '稍后提醒', onClick: () => closeDialog() },
      ]);
    }
    // 成功时主进程会自己退出，这里不需要再做什么
  }

  // ------------------------------------------------------------ 回滚提示

  function showRollbackNotice(n) {
    setTitle('上次更新没有成功');
    $('#updateMeta').textContent = `已回到 v${n.reason === '备份失败' ? n.to : n.from || ''} 之前的状态`;
    $('#updateFull').hidden = true;
    $('#updateChanges').hidden = true;
    $('#updateEmpty').hidden = true;
    setStatus(
      `上次升级到 v${n.to} 没有成功（${n.reason || '启动失败'}），已经自动回到当前版本，可以继续使用。`,
      'warn',
    );
    setActions([{ label: '知道了', primary: true, onClick: () => closeDialog() }]);
    openDialog();
  }

  // -------------------------------------------------------------- 启动流程

  async function boot() {
    const bar = $('#updateBar');
    if (!bar) return;

    $('#updateBarClose').addEventListener('click', () => {
      dismissed = true;
      hideBar();
    });
    $('#updateBarOpen').addEventListener('click', () => {
      if (info) {
        openDialog();
        renderConfirm();
      }
    });
    $('#btnUpdateReleases').addEventListener('click', () => {
      api.openReleases(info ? info.releasesPage : '');
    });
    const checkButton = $('#btnCheckUpdate');
    if (checkButton) checkButton.addEventListener('click', () => checkLatest(true));
    const releasesButton = $('#btnSettingsReleases');
    if (releasesButton) releasesButton.addEventListener('click', () => {
      api.openReleases(info ? info.releasesPage : '');
    });

    // 被更新脚本拉起来的新版本：先领上次的回滚提示
    try {
      const notice = await api.notice();
      if (notice && notice.kind === 'rolled-back') showRollbackNotice(notice);
    } catch (_) { /* 没有提示就是正常的 */ }

    await checkLatest(false);
  }

  // 等界面先画出来再联网，避免启动瞬间被网络请求拖慢
  setTimeout(boot, 2500);

  // 主进程清理跳过记录后同步给偏好，避免下次写回时把它又带回来
  api.onEvent((e) => {
    if (!e) return;
    if (e.type === 'skipped-pruned' && window.Prefs) {
      window.Prefs.set('skippedVersions', e.skippedVersions || []);
    }
    // 下载过程中主进程会不断上报累计字节数
    if (e.type === 'progress' && e.phase === 'downloading') {
      setProgress(e.bytes);
    }
  });
})();
