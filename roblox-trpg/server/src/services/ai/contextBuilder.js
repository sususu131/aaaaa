/**
 * AI Context 构建（Step 14）。
 * 10 类分区：SYSTEM_RULES / WORLD_SETTING / WORLD_STATE / PLAYER_STATE /
 * CURRENT_LOCATION / CURRENT_DUNGEON / NPC_STATE / RECENT_EVENTS /
 * IMPORTANT_MEMORIES / ROBLOX_SOURCE_DATA
 *
 * 原则：Context 不是数据库——真实状态永远回查数据库，这里只是给 AI 的视图。
 */
const { getDb } = require('@roblox-trpg/database');
const { SYSTEM_RULES, wrapSourceData } = require('./promptRules');
const { RECENT_EVENTS_KEEP } = require('../../config');

const WORLD_SETTING = `世界设定：全球突变，Roblox降临现实。所有人变成自己的Roblox形象，
没有Roblox账号的人变成培根头。每个Roblox体验都变成危险副本，
玩家通过副本获得装备、能力和奖励。当前为灾变初期，城市秩序正在崩坏。`;

/** token 估算（启发式：CJK≈1 token/字，其余≈4字符/token）。结果标注为估计值。 */
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

function recentEventsContent(roomId) {
  const db = getDb();
  const parts = [];

  const summaries = db
    .prepare('SELECT * FROM context_summaries WHERE room_id = ? ORDER BY id DESC LIMIT 2')
    .all(roomId);
  for (const s of summaries) parts.push(`【历史压缩摘要】${s.summary}`);

  let msgs;
  if (summaries.length) {
    const sinceId = summaries[0].message_id_to || 0;
    msgs = db
      .prepare('SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id DESC LIMIT ?')
      .all(roomId, sinceId, RECENT_EVENTS_KEEP)
      .reverse();
  } else {
    msgs = db
      .prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?')
      .all(roomId, RECENT_EVENTS_KEEP)
      .reverse();
  }

  for (const m of msgs) {
    if (m.type === 'chat') parts.push(`${playerNameOf(m.player_id)}: ${m.content}`);
    else if (m.type === 'gm') parts.push(`[GM] ${m.content}`);
    else parts.push(`[系统] ${m.content}`);
  }
  return parts.join('\n') || '（暂无事件）';
}

function playerNameOf(playerId) {
  if (!playerId) return '系统';
  const row = getDb().prepare('SELECT name FROM players WHERE id = ?').get(playerId);
  return row ? row.name : '未知玩家';
}

function playerStateContent(roomId) {
  const rows = getDb()
    .prepare(
      `SELECT p.name, p.uid, p.avatar_type, rp.username, rp.display_name
       FROM players p LEFT JOIN roblox_profiles rp ON rp.id = p.roblox_profile_id
       WHERE p.room_id = ? AND p.left_at IS NULL ORDER BY p.joined_at`
    )
    .all(roomId);
  if (!rows.length) return '（房间内没有玩家）';
  return rows
    .map((r) => {
      const avatar =
        r.avatar_type === 'roblox' && r.username
          ? `Roblox形象(username=${r.username}, displayName=${r.display_name || r.username})`
          : '培根头（无Roblox账号）';
      return `- ${r.name}（${r.uid || '未分配ID'}，${avatar}）`;
    })
    .join('\n');
}

function npcStateContent(roomId) {
  const npcs = getDb()
    .prepare("SELECT content FROM room_memories WHERE room_id = ? AND kind = 'npc' ORDER BY id DESC LIMIT 10")
    .all(roomId);
  return npcs.length ? npcs.map((n) => `- ${n.content}`).join('\n') : '（尚未出现重要NPC）';
}

function memoriesContent(roomId) {
  const rows = getDb()
    .prepare("SELECT kind, content FROM room_memories WHERE room_id = ? AND kind != 'npc' ORDER BY id DESC LIMIT 20")
    .all(roomId);
  return rows.length ? rows.map((r) => `- [${r.kind}] ${r.content}`).join('\n') : '（暂无重要记忆）';
}

/**
 * 构建完整 Context。room 为 roomManager 的内存房间对象。
 * 返回 { sections: [{key,label,content,tokens}], totalTokens }
 */
function buildContext(room) {
  const exp = room.currentExperience || null;

  const dungeonContent = exp
    ? `当前副本来源体验：${exp.name}（universeId=${exp.universeId}）\n` +
      `官方描述：${exp.description || '（无）'}\n创作者：${exp.creator ? exp.creator.name : '未知'}`
    : '（房间尚未绑定 Roblox 体验副本）';

  let robloxBlock = '（未绑定体验，无 ROBLOX_SOURCE_DATA）';
  if (exp) {
    robloxBlock = wrapSourceData(
      'ROBLOX_SOURCE_DATA | source=roblox_api | CANONICAL_FACT',
      JSON.stringify(
        {
          source: 'roblox_api',
          fetchedAt: exp.fetchedAt,
          experience: {
            universeId: exp.universeId,
            placeId: exp.rootPlaceId || null,
            name: exp.name,
            description: exp.description,
            creator: exp.creator,
            stats: exp.stats || null,
          },
        },
        null,
        2
      )
    );
  }

  const sections = [
    { key: 'system', label: 'System Rules', content: SYSTEM_RULES },
    { key: 'world', label: 'World Setting', content: WORLD_SETTING },
    { key: 'world_state', label: 'World State', content: `房间 ${room.id}，状态：灾变初期，阶段2跑团进行中。` },
    { key: 'players', label: 'Players', content: playerStateContent(room.id) },
    { key: 'location', label: 'Current Location', content: `当前地点：房间 ${room.id} 的集合点。` },
    { key: 'dungeon', label: 'Current Dungeon', content: dungeonContent },
    { key: 'npc', label: 'NPC State', content: npcStateContent(room.id) },
    { key: 'events', label: 'Recent Events', content: recentEventsContent(room.id) },
    { key: 'memories', label: 'Important Memories', content: memoriesContent(room.id) },
    { key: 'roblox', label: 'Roblox Source Data', content: robloxBlock },
  ];

  let totalTokens = 0;
  for (const s of sections) {
    s.tokens = estimateTokens(s.content);
    totalTokens += s.tokens;
  }
  return { sections, totalTokens };
}

/** 拼给模型的上下文文本。 */
function toPromptText(ctx) {
  return ctx.sections.map((s) => `## ${s.label}\n${s.content}`).join('\n\n');
}

module.exports = { buildContext, toPromptText, estimateTokens };
