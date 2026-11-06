'use strict';

/**
 * 「点关闭按钮之后干什么」的判定。
 *
 * 抽成纯函数是因为这块已经错过两次：一次是关窗进程不退出，一次是选了「直接退出」
 * 却只关了窗口、进程留在托盘。真正难查的地方在于它只在真点关闭时才跑，
 * 本机又没有 GUI 能自动化，只能靠这段判定被测试盯住。
 *
 * @param {boolean} quitting 是否已经在退出流程里
 * @param {string} behavior  偏好里记的值：'minimize' | 'quit' | ''（还没问过）
 * @returns {'pass'|'hide'|'ask'}
 *   pass —— 放行这次关闭，窗口真的销毁，交给 closed 收尾退出
 *   hide —— 拦下来，收进托盘，进程继续跑
 *   ask  —— 拦下来，先问用户这次要哪种
 */
function decide(quitting, behavior) {
  if (quitting) return 'pass';
  if (behavior === 'quit') return 'pass';
  if (behavior === 'minimize') return 'hide';
  // 空串=还没问过；脏值（比如老版本写进来的别的东西）一律当成没问过
  return 'ask';
}

module.exports = { decide };
