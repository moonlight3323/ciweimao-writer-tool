'use strict';

/**
 * 敏感词侧栏窗口的 preload。
 *
 * 刻意跟主窗口的 preload 分开：这个窗口只需要「收状态、发命令」，
 * 不给它 browser / writer / data 那些能力，越界的手段少一条是一条。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sideApi', {
  /** 订阅主窗口推过来的界面状态 */
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('pubside:state', handler);
    return () => ipcRenderer.removeListener('pubside:state', handler);
  },
  /** 把动作交回主窗口执行：{ type: 'publish' | 'apply' | 'force', plan? } */
  command: (cmd) => ipcRenderer.send('pubside:command', cmd),
  /** 关闭（收起）侧栏 */
  hide: () => ipcRenderer.send('pubside:hide'),
  /** 让主进程重新摆一次位置（窗口尺寸变化时用） */
  reflow: () => ipcRenderer.send('pubside:reflow'),
});
