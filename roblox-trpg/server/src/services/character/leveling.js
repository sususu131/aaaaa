/**
 * Level / XP 系统（阶段6 第五~七节）：数据驱动配置，集中在本文件。
 * AI 不能决定等级；升级由服务器计算并广播 LEVEL_UP 事件。
 */

// 升到 level N 所需的累计 XP（数据驱动；未来可改为数据库配置表）
const XP_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2200, 3000, 4000, 5200, 6600, 8200, 10000];
const MAX_LEVEL = XP_THRESHOLDS.length;
const XP_PER_ACTION = 5; // 探索/行动小奖励（服务器裁定）

/** 副本通关 XP：按难度数据驱动（+50% 若击败 Boss）。 */
function dungeonCompletionXp(difficulty, bossDefeated) {
  const base = 100 + (Number(difficulty) || 1) * 50;
  return bossDefeated ? Math.round(base * 1.5) : base;
}

/** 由累计 XP 计算等级（至少 1）。 */
function levelForXp(xp) {
  let level = 1;
  for (let l = 2; l <= MAX_LEVEL; l += 1) {
    if (xp >= XP_THRESHOLDS[l - 1]) level = l;
    else break;
  }
  return level;
}

/** 当前等级的进度信息。 */
function progress(xp, level) {
  const cur = XP_THRESHOLDS[level - 1] || 0;
  const next = level < MAX_LEVEL ? XP_THRESHOLDS[level] : null;
  return { xp, level, currentThreshold: cur, nextThreshold: next, maxLevel: MAX_LEVEL };
}

module.exports = { XP_THRESHOLDS, MAX_LEVEL, XP_PER_ACTION, dungeonCompletionXp, levelForXp, progress };
