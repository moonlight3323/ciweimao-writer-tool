'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程与主进程之间的唯一通道。
 * 只暴露白名单方法，不向页面泄漏 Node 能力。
 */
contextBridge.exposeInMainWorld('api', {
  browser: {
    /** 打开平台页面并挂载到指定矩形 {x,y,width,height} */
    open: (rect, url) => ipcRenderer.invoke('browser:open', rect, url),
    /** 只重新挂载已加载页面，不导航（章节投递后回看时使用） */
    show: (rect) => ipcRenderer.invoke('browser:show', rect),
    navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
    reload: () => ipcRenderer.invoke('browser:reload'),
    close: () => ipcRenderer.invoke('browser:close'),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    home: () => ipcRenderer.invoke('browser:home'),
    navState: () => ipcRenderer.invoke('browser:nav-state'),
    setBounds: (rect) => ipcRenderer.invoke('browser:bounds', rect),
    state: () => ipcRenderer.invoke('browser:state'),
    /** 在平台页面上下文执行 JS，用于抓取 */
    evalInPage: (code) => ipcRenderer.invoke('browser:eval', code),
    goto: (p) => ipcRenderer.invoke('browser:goto', p),
    waitIdle: (ms) => ipcRenderer.invoke('browser:wait-idle', ms),
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('browser:event', handler);
      return () => ipcRenderer.removeListener('browser:event', handler);
    },
  },
  /** 敏感词处理侧栏：独立窗口，不挤压作者后台页面。 */
  pubside: {
    open: (state) => ipcRenderer.invoke('pubside:open', state),
    close: () => ipcRenderer.invoke('pubside:close'),
    setState: (state) => ipcRenderer.invoke('pubside:set-state', state),
    isOpen: () => ipcRenderer.invoke('pubside:is-open'),
    onCommand: (cb) => {
      const handler = (_e, cmd) => cb(cmd);
      ipcRenderer.on('pubside:command', handler);
      return () => ipcRenderer.removeListener('pubside:command', handler);
    },
  },
  /**
   * 喵语数据站（第三方）。只放行站点里 /ciweimao 下的页面，
   * 首页与移动版由主进程的路由守卫挡掉，界面这边只需关心挂载与导航。
   */
  miaoyu: {
    open: (rect) => ipcRenderer.invoke('miaoyu:open', rect),
    close: () => ipcRenderer.invoke('miaoyu:close'),
    setBounds: (rect) => ipcRenderer.invoke('miaoyu:bounds', rect),
    goto: (which) => ipcRenderer.invoke('miaoyu:goto', which),
    reload: () => ipcRenderer.invoke('miaoyu:reload'),
    back: () => ipcRenderer.invoke('miaoyu:back'),
    forward: () => ipcRenderer.invoke('miaoyu:forward'),
    external: () => ipcRenderer.invoke('miaoyu:external'),
    state: () => ipcRenderer.invoke('miaoyu:state'),
  },
  /**
   * AI 接入：本机只读接口 + 素材包。
   * 只暴露「开关 / 状态 / 生成素材 / 打开目录」，没有任何写数据的能力。
   */
  ai: {
    status: () => ipcRenderer.invoke('ai:status'),
    start: () => ipcRenderer.invoke('ai:start'),
    stop: () => ipcRenderer.invoke('ai:stop'),
    exportPack: () => ipcRenderer.invoke('ai:export'),
    openFolder: () => ipcRenderer.invoke('ai:open-folder'),
    openEndpoint: () => ipcRenderer.invoke('ai:open-endpoint-folder'),
  },
  /** 正文归档：导出的同时留一份，供 AI 读剧情 */
  library: {
    archive: (payload) => ipcRenderer.invoke('library:archive', payload),
    list: () => ipcRenderer.invoke('library:list'),
    clear: () => ipcRenderer.invoke('library:clear'),
  },
  /** 本地创作中心：作品库、导入与草稿保存 */
  writer: {
    list: () => ipcRenderer.invoke('writer:list'),
    open: (bookId) => ipcRenderer.invoke('writer:open', bookId),
    create: (name) => ipcRenderer.invoke('writer:create', name),
    /** 把后台新建、本地还没有的作品补进作品库并绑定 */
    adopt: (books) => ipcRenderer.invoke('writer:adopt', books),
    save: (book) => ipcRenderer.invoke('writer:save', book),
    covers: (list) => ipcRenderer.invoke('writer:covers', list),
    remove: (bookId) => ipcRenderer.invoke('writer:delete', bookId),
    importBook: () => ipcRenderer.invoke('writer:import'),
  },
  storage: {
    status: () => ipcRenderer.invoke('storage:status'),
    choose: () => ipcRenderer.invoke('storage:choose'),
    reset: () => ipcRenderer.invoke('storage:reset'),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    get: (id) => ipcRenderer.invoke('plugins:get', id),
    enable: (id, enabled) => ipcRenderer.invoke('plugins:enable', id, enabled),
    openFolder: () => ipcRenderer.invoke('plugins:open-folder'),
    importZip: () => ipcRenderer.invoke('plugins:import'),
    createTemplate: () => ipcRenderer.invoke('plugins:create-template'),
    remove: (id) => ipcRenderer.invoke('plugins:remove', id),
    storageGet: (id, key) => ipcRenderer.invoke('plugins:storage-get', id, key),
    storageSet: (id, key, value) => ipcRenderer.invoke('plugins:storage-set', id, key, value),
  },
  /**
   * 密码本。注意这里没有任何「取密码」的方法：
   * 解密与填入都在主进程完成，界面只拿得到 id / 账号 / 时间。
   */
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    capture: () => ipcRenderer.invoke('vault:capture'),
    fill: (id) => ipcRenderer.invoke('vault:fill', id),
    remove: (id) => ipcRenderer.invoke('vault:remove', id),
  },
  app: {
    userDataPath: () => ipcRenderer.invoke('app:user-data'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    openPath: (p) => ipcRenderer.invoke('app:open-path', p),
    /** 在文件管理器中定位到某个文件 */
    reveal: (p) => ipcRenderer.invoke('app:reveal', p),
  },
  file: {
    /** 弹保存对话框并写入文本（自动补 UTF-8 BOM） */
    saveText: (opts) => ipcRenderer.invoke('file:save-text', opts),
  },
  diag: {
    save: (filename, content) => ipcRenderer.invoke('diag:save', filename, content),
    dir: () => ipcRenderer.invoke('diag:dir'),
  },
  data: {
    read: (name) => ipcRenderer.invoke('data:read', name),
    write: (name, content) => ipcRenderer.invoke('data:write', name, content),
    dir: () => ipcRenderer.invoke('data:dir'),
  },
  /**
   * 执行动作（删除间贴 / 禁言读者）。
   * 真正的请求参数校验与请求发送都在主进程完成，渲染进程只能提交目标编号。
   */
  exec: {
    run: (req) => ipcRenderer.invoke('exec:run', req),
    verify: (req) => ipcRenderer.invoke('exec:verify', req),
    log: () => ipcRenderer.invoke('exec:log'),
  },
  rank: {
    fetch: () => ipcRenderer.invoke('rank:fetch'),
  },
  /** 敏感词库：只存词本身，接口按 word 增删查，不提供任何批量导出到网络的通道 */
  badword: {
    list: () => ipcRenderer.invoke('badword:list'),
    add: (words) => ipcRenderer.invoke('badword:add', words),
    stats: () => ipcRenderer.invoke('badword:stats'),
    remove: (word) => ipcRenderer.invoke('badword:remove', word),
    clear: () => ipcRenderer.invoke('badword:clear'),
    dir: () => ipcRenderer.invoke('badword:dir'),
  },
  /**
   * 自动更新。
   * 清单地址、哈希、版本号都在主进程侧重新拉取，这里只负责触发与接收进度。
   */
  update: {
    notice: () => ipcRenderer.invoke('update:notice'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    skip: (version) => ipcRenderer.invoke('update:skip', version),
    openReleases: (url) => ipcRenderer.invoke('update:open-releases', url),
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('update:event', handler);
      return () => ipcRenderer.removeListener('update:event', handler);
    },
  },
});
