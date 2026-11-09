'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 摸鱼浮层窗口的专用桥。
 *
 * 这个窗口里只有一个 textarea，不需要 Node，也不需要主界面那套 api。
 * 只放行：拿初始内容、回推正文、隐藏、回到软件、改设置。
 */
contextBridge.exposeInMainWorld('overlayApi', {
  /** 打开浮层时主进程推来的初始状态：正文、章节名、设置、快捷键 */
  onInit: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('overlay:init', handler);
    return () => ipcRenderer.removeListener('overlay:init', handler);
  },
  onSettings: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('overlay:settings', handler);
    return () => ipcRenderer.removeListener('overlay:settings', handler);
  },
  /** 快捷键变了：{ combo, wanted, ok } —— combo 是真正生效的，wanted 是用户设的 */
  onHotkey: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('overlay:hotkey', handler);
    return () => ipcRenderer.removeListener('overlay:hotkey', handler);
  },
  /** 正文变了：主进程转给码字台 */
  input: (text) => ipcRenderer.send('moyu:input', String(text == null ? '' : text)),
  /** 只藏浮层，主窗口保持隐藏，等快捷键再叫回来 */
  hide: () => ipcRenderer.send('moyu:hide'),
  /** 关掉浮层并把主窗口拉回来 */
  restore: () => ipcRenderer.send('moyu:restore'),
  /** 字号 / 字色 / 描边 / 底色 / 窄中宽 */
  settings: (patch) => ipcRenderer.send('moyu:settings', patch || {}),
  /** 按住把手：主进程开始按系统光标位置挪窗口，松开就停 */
  dragStart: () => ipcRenderer.send('moyu:drag-start'),
  dragEnd: () => ipcRenderer.send('moyu:drag-end'),
});
