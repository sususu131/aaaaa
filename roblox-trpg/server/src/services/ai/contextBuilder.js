/**
 * AI Context 构建（阶段2 + 阶段3 集成）。
 * 分区：SYSTEM_RULES / WORLD_SETTING / ROOM_STATUS / PLAYER_STATE /
 * CURRENT_LOCATION / CURRENT_DUNGEON / NPC_STATE / RECENT_EVENTS /
 * DICE_RESULT + TOOL_RESULT / IMPORTANT_MEMORIES / WORLD_STATE / ROBLOX_SOURCE_DATA
 *
 * 纪律：CANONICAL_FACT / TRPG_ORIGINAL / UNTRUSTED_INPUT 分离；
 * Context 不是数据库 —— 真实状态永远回查数据库。
 */
const { getDb } = require('@roblox-trpg/database');
const { SYSTEM_RULES, wrapSourceData } = require('./promptRules');
const { RECENT_EVENTS_KEEP } = require('../../config');
const worldState = require('../world/worldState');
const playerStates = require('../world/playerStates');

const WORLD_SETTING = `世界设定：全球突变，Roblox降临现实。所有人变成自己的Roblox形象，
没有Roblox账号的人变成培根头。每个Roblox体验都变成危险副本，
玩家通过副本获得装备、能力和奖励。当前为灾变初期，城市秩序正在崩坏。
战斗与检定核心规则：双骰拼点（玩家1d20 对 难度1d20，大者成功，相等为特殊结果）。`;

/** token 估算（启发式：CJK≈1 token/字，其余≈4字符/token）。 */
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

function playerNameOf(playerId) {
  if (!playerId) return '系统';
  const row = getDb().prepare('SELECT name FROM players WHERE id = ?').get(playerId);
  return row ? row.name : '未知玩家';
}

/** 近期事件（受保护类型的消息不参与压缩截断）。 */
function recentEventsContent(roomId) {
  const db = getDb();
  const parts = [];

  const summaries = db
    .prepare('SELECT * FROM context_summaries WHERE room_id = ? ORDER BY id DESC LIMIT 2')
    .all(roomId);
  for (const s of summaries) parts.push(`【历史压缩摘要】${s.summary}`);

  const sinceId = summaries.length ? summaries[0].message_id_to || 0 : 0;
  const msgs = db
    .prepare(
      `SELECT * FROM messages WHERE room_id = ? AND (id > ? OR type NOT IN ('chat','gm'))
       ORDER BY id DESC LIMIT ?`
    )
    .all(roomId, sinceId, RECENT_EVENTS_KEEP + 15)
    .reverse();

  for (const m of msgs) {
    if (m.type === 'chat') parts.push(`${playerNameOf(m.player_id)}: ${m.content}`);
    else if (m.type === 'gm') parts.push(`[GM] ${m.content}`);
    else if (m.type === 'system') parts.push(`[系统] ${m.content}`);
    else parts.push(`[${m.type}] ${renderEventPayload(m.content)}`);
  }
  return parts.join('\n') || '（暂无事件）';
}

function renderEventPayload(raw) {
  try {
    const d = JSON.parse(raw);
    if (d.event === 'dice:rolled') return `服务器掷骰 ${d.count}d${d.sides} = [${(d.rolls || []).join(',')}] 合计 ${d.total}`;
    if (d.event === 'skill:check')
      return `${d.playerName} 技能检定「${d.skill}」：玩家骰${d.playerRoll}${d.modifier ? `+${d.modifier}` : ''} vs 难度骰${d.difficultyRoll} → ${d.success ? '成功' : d.draw ? '平局' : '失败'}（差距${d.margin}）`;
    if (d.event === 'skill:gained') return `${d.playerName} 获得技能「${d.skillName}」（来源副本：${d.dungeon}）`;
    if (d.event === 'item:gained') return `${d.playerName} 获得物品「${d.itemName}」×${d.quantity}`;
    if (d.event === 'world:changed') return `世界状态变更：${d.field} = ${JSON.stringify(d.value)}（v${d.version}）`;
    if (d.event === 'dungeon:completed') return `副本「${d.dungeon}」通关：${(d.players || []).join('、')}`;
    return JSON.stringify(d).slice(0, 120);
  } catch {
    return String(raw).slice(0, 120);
  }
}

function playerStateContent(room) {
  const db = getDb();
  const lines = [];
  for (const p of room.players) {
    const row = db.prepare('SELECT * FROM players WHERE socket_id = ?').get(p.socketId);
    if (!row) continue;
    const st = playerStates.getPlayerState(row.id);
    const avatar = row.avatar_type === 'roblox' ? 'Roblox形象' : '培根头';
    const skills = st.skills.length ? st.skills.map((s) => s.name).join('、') : '无';
    const items = st.items.length ? st.items.map((i) => `${i.name}×${i.quantity}`).join('、') : '无';
    lines.push(
      `- ${p.name}（${row.uid || '未分配ID'}，${avatar}）HP ${st.hp}/${st.maxHp}，位置：${st.location}，技能：${skills}，物品：${items}`
    );
  }
  return lines.join('\n') || '（房间内没有玩家）';
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

/** 骰子结果 + 工具结果（DICE_RESULT / TOOL_RESULT 分区）。 */
function diceAndToolsContent(roomId) {
  const db = getDb();
  const rolls = db.prepare('SELECT * FROM dice_rolls WHERE room_id = ? ORDER BY id DESC LIMIT 6').all(roomId).reverse();
  const calls = db
    .prepare("SELECT * FROM tool_calls WHERE room_id = ? AND success = 1 AND tool_name NOT LIKE 'get_%' ORDER BY id DESC LIMIT 6")
    .all(roomId)
    .reverse();
  const parts = [];
  for (const r of rolls) {
    const d = JSON.parse(r.data);
    if (r.kind === 'skill_check')
      parts.push(`[SKILL_CHECK] ${d.skill}: 玩家${d.playerRoll}+${d.modifier || 0} vs 难度${d.difficultyRoll} → ${d.success ? '成功' : d.draw ? '平局' : '失败'}`);
    else parts.push(`[DICE] ${d.count}d${d.sides} = [${(d.rolls || []).join(',')}] 合计 ${d.total}`);
  }
  for (const c of calls) parts.push(`[TOOL] ${c.tool_name} → ${String(c.result).slice(0, 120)}`);
  return parts.join('\n') || '（暂无骰子/工具结果）';
}

function worldVarsContent(roomId) {
  const w = worldState.getWorld(roomId);
  const entries = Object.entries(w.state).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  return `world_version = ${w.version}\n${entries.join('\n') || '（无白名单状态字段）'}`;
}

/** 构建完整 Context。返回 { sections, totalTokens }。 */
function buildContext(room) {
  const exp = room.currentExperience || null;
  const cd = room.currentDungeon || null;

  const dungeonContent = cd
    ? `当前副本：${cd.name}（dungeonId=${cd.dungeonId}）—— 数据库登记副本，奖励由 dungeon_rewards 驱动。`
    : exp
      ? `当前副本来源体验：${exp.name}（universeId=${exp.universeId}），尚未在副本数据库登记。`
      : '（房间尚未绑定副本）';

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
    { key: 'room_status', label: 'Room Status', content: `房间 ${room.id}，GM Agent 运行中（阶段3）。` },
    { key: 'players', label: 'Player State', content: playerStateContent(room) },
    { key: 'location', label: 'Current Location', content: `当前地点：房间 ${room.id} 的集合点。` },
    { key: 'dungeon', label: 'Current Dungeon', content: dungeonContent },
    { key: 'npc', label: 'NPC State', content: npcStateContent(room.id) },
    { key: 'events', label: 'Recent Events', content: recentEventsContent(room.id) },
    { key: 'dice_tools', label: 'Dice & Tool Results', content: diceAndToolsContent(room.id) },
    { key: 'memories', label: 'Important Memories', content: memoriesContent(room.id) },
    { key: 'world_vars', label: 'World State (versioned)', content: worldVarsContent(room.id) },
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
