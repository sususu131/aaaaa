/**
 * Context 自动压缩（Step 17）。
 * 阈值：70% 提示 / 80% 准备 / 90% 强制压缩（占 AI_CONTEXT_BUDGET）。
 * 压缩对象：普通聊天、重复叙述、已结束事件。
 * 必须保留（天然在压缩范围之外）：世界设定、玩家状态、技能装备、
 * 副本进度、NPC重要关系、关键 Roblox 资料 —— 这些由数据库回查重建，
 * Context 不是数据库。
 */
const { getDb } = require('@roblox-trpg/database');
const { buildContext, estimateTokens } = require('./contextBuilder');
const {
  AI_CONTEXT_BUDGET,
  CONTEXT_WARN_RATIO,
  CONTEXT_PREPARE_RATIO,
  CONTEXT_COMPRESS_RATIO,
  RECENT_EVENTS_KEEP,
} = require('../../config');

/** 调用时读取预算（便于测试覆盖）。 */
function budget() {
  return Number(process.env.AI_CONTEXT_BUDGET || AI_CONTEXT_BUDGET);
}

/** 规则式兜底摘要（AI 不可用时）：保留系统事件与 GM 叙事，截断普通聊天。 */
function ruleBasedSummary(messages) {
  const kept = [];
  for (const m of messages) {
    if (m.type === 'system') kept.push(`[系统] ${m.content}`);
    else if (m.type === 'gm') kept.push(`[GM] ${m.content.slice(0, 120)}`);
  }
  const chatCount = messages.filter((m) => m.type === 'chat').length;
  const head = `已压缩 ${messages.length} 条历史消息（其中聊天 ${chatCount} 条）。`;
  const body = kept.length ? kept.slice(-20).join('\n') : '（无需要保留的系统/剧情要点）';
  return `${head}\n保留要点：\n${body}`;
}

/**
 * 检查并按需压缩。返回提示文本（系统消息），无动作返回 null。
 * summarizeFn: (text) => Promise<string>，由 aiGm 提供（可能失败）。
 */
async function maybeCompress(room, io, summarizeFn) {
  const ctx = buildContext(room);
  const ratio = ctx.totalTokens / budget();
  const flags = room.contextFlags || (room.contextFlags = {});

  if (ratio >= CONTEXT_COMPRESS_RATIO) {
    const db = getDb();
    const last = db
      .prepare('SELECT message_id_to FROM context_summaries WHERE room_id = ? ORDER BY id DESC LIMIT 1')
      .get(room.id);
    const sinceId = (last && last.message_id_to) || 0;

    // 只压缩 chat/gm；骰子结果、技能获得、世界变化等关键事件受保护，永不压缩
    const compressible = db
      .prepare("SELECT * FROM messages WHERE room_id = ? AND id > ? AND type IN ('chat','gm') ORDER BY id ASC")
      .all(room.id, sinceId);
    if (compressible.length <= RECENT_EVENTS_KEEP) {
      flags.prepared80 = true;
      return '【Context】已达 90%，但可压缩消息过少，暂不压缩。';
    }
    const toCompress = compressible.slice(0, compressible.length - RECENT_EVENTS_KEEP);

    let summary;
    try {
      summary = await summarizeFn(toCompress);
    } catch {
      summary = ruleBasedSummary(toCompress);
    }

    db.prepare(
      'INSERT INTO context_summaries (room_id, summary, token_estimate, message_id_from, message_id_to) VALUES (?, ?, ?, ?, ?)'
    ).run(room.id, summary, estimateTokens(summary), toCompress[0].id, toCompress[toCompress.length - 1].id);

    flags.warned70 = false;
    flags.prepared80 = false;
    return `【Context】已达 ${Math.round(ratio * 100)}%，已自动压缩 ${toCompress.length} 条历史消息（骰子/技能/世界变化等关键事件已保留，重要状态仍来自数据库）。`;
  }

  if (ratio >= CONTEXT_PREPARE_RATIO && !flags.prepared80) {
    flags.prepared80 = true;
    return `【Context】已达 ${Math.round(ratio * 100)}%，准备压缩…`;
  }
  if (ratio >= CONTEXT_WARN_RATIO && !flags.warned70) {
    flags.warned70 = true;
    return `【Context】已达 ${Math.round(ratio * 100)}%，接近上限。`;
  }
  return null;
}

module.exports = { maybeCompress, ruleBasedSummary };
