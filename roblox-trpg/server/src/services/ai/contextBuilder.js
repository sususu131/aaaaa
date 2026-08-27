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
    const skills = st.skills.length ? st.skills.map((s) => `${s.name}(${s.grantChannel})`).join('、') : '无';
    const items = st.items.length ? st.items.map((i) => `${i.name}×${i.quantity}`).join('、') : '无';
    const attrs = st.attributes
      ? `，属性：${Object.entries(st.attributes).map(([k, v]) => `${k}${v}`).join(' ')}`
      : '';
    lines.push(
      `- ${p.name}（${row.uid || '未分配ID'}，${avatar}）HP ${st.hp}/${st.maxHp}，位置：${st.location}${attrs}，技能：${skills}，物品：${items}`
    );
  }
  return lines.join('\n') || '（房间内没有玩家）';
}

/**
 * Avatar / Initial State 分区（Context Viewer 可见；Context 只含最终结果，
 * 完整 Vision Raw Output 仅存数据库）。区分 AVATAR_DERIVED 与 DUNGEON_REWARD。
 */
function avatarContext(room) {
  const db = getDb();
  const lines = [];
  for (const p of room.players) {
    const row = db.prepare('SELECT * FROM players WHERE socket_id = ?').get(p.socketId);
    if (!row) continue;
    const init = db.prepare('SELECT * FROM avatar_initialization WHERE player_id = ?').get(row.id);
    if (!init) {
      lines.push(`${p.name}: NOT_INITIALIZED`);
      continue;
    }
    if (init.status === 'INITIALIZED' && init.roblox_user_id === 'bacon') {
      lines.push(`${p.name}: Bacon Head（无Roblox账号）→ 默认属性全5，初始技能：无 [AVATAR_DERIVED]`);
      continue;
    }
    const attrs = init.final_attributes ? JSON.parse(init.final_attributes) : {};
    const skills = init.accepted_skills ? JSON.parse(init.accepted_skills) : [];
    lines.push(
      `${p.name}: Avatar Source=roblox_api(user:${init.roblox_user_id}) | Vision Model=${init.vision_model || '-'} | ` +
        `Accepted Tags=[${JSON.parse(init.accepted_tags || '[]').join(',')}] | ` +
        `属性：${Object.entries(attrs).map(([k, v]) => `${k}${v}`).join(' ')} | ` +
        `初始技能：${skills.join('、') || '无'} [AVATAR_DERIVED]`
    );
  }
  return lines.join('\n') || '（无）';
}

/**
 * NPC State（阶段21 修复）：名册唯一来源 = 服务器生成的 npc_instances
 * （定义导入/遭遇判定/世界模拟生成，全部服务器流程）。
 * AI GM 的 memory_update 不再写入 kind='npc'（防止 AI 凭叙事"创建"NPC）。
 */
function npcStateContent(roomId) {
  try {
    const npcEngine = require('../npcs/npcEngine');
    const insts = npcEngine.npcInstancesInRoom(roomId);
    if (!insts.length) return '（尚未出现重要NPC）';
    return insts
      .map((ni) => {
        const npc = npcEngine.getNpc(ni.npc_id);
        if (!npc) return null;
        return `- ${npc.name}${npc.avatar ? ` ${npc.avatar}` : ''}｜${ni.alive ? '在场' : '已死亡'}｜情绪：${ni.mood || 'neutral'}`;
      })
      .filter(Boolean)
      .join('\n');
  } catch (err) {
    return `（NPC 状态不可用：${err.message}）`;
  }
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

/**
 * 阶段13：PARTY_CONTEXT —— 队伍成员 / 叙事角色定位 / 玩家关系。
 * 角色定位（EXPLORER/COMBATANT/SUPPORT/SCOUT/CUSTOM）只影响 GM 叙事措辞，绝不改变真实属性。
 */
function partyContextContent(room) {
  try {
    const partyService = require('../party/partyService');
    const playerRelations = require('../party/playerRelations');
    const parts = [];
    const party = partyService.getActiveParty(room.id);
    if (!party) {
      parts.push('当前房间没有队伍。');
    } else {
      const view = partyService.partyView(party.id);
      const leader = view.members.find((m) => m.isLeader);
      parts.push(
        `队伍 ${view.uid}（队长：${leader ? leader.name : '?'}）：` +
          view.members.map((m) => `${m.name}[${m.roleLabel}${m.isLeader ? '/队长' : ''}]`).join('、')
      );
      if (view.relationships.length) {
        parts.push(`成员关系：${view.relationships.map((r) => `${r.a}↔${r.b}=${r.type}(${r.value})`).join('；')}`);
      }
      parts.push('（叙事定位仅供描述参考，如「作为队伍侦察者，你提前发现异常气息」；不改变任何属性数值。）');
    }
    const rels = playerRelations.relationshipsInRoom(room.id);
    if (!party && rels.length) parts.push(`房间玩家关系：${rels.map((r) => `${r.a}↔${r.b}=${r.type}(${r.value})`).join('；')}`);
    return parts.join('\n');
  } catch (err) {
    return `（队伍状态不可用：${err.message}）`;
  }
}

/**
 * 阶段13：DECISION_CONTEXT —— 当前待决选择 / 剩余时间 / 可选方案。
 * 剩余时间由服务器计算（客户端只显示）；AI 不得代替玩家选择或宣布结果。
 */
function decisionContextContent(roomId) {
  try {
    const decisionEngine = require('../party/decisionEngine');
    const pending = decisionEngine.pendingDecisions(roomId);
    if (!pending.length) return '（当前无待决选择）';
    return pending
      .map((d) => {
        const view = decisionEngine.decisionView(d.id);
        const timeLeft = view.remainingMs !== null ? `，剩余 ${Math.ceil(view.remainingMs / 1000)} 秒` : '，无时限';
        const opts = view.options.map((o) => `${o.key}:${o.text}`).join(' / ');
        const votes = d.type === 'PARTY' ? `，投票 ${view.totalVotes}/${view.requiredVotes}` : '';
        return `[${d.type} DECISION ${view.uid}] ${d.prompt}${timeLeft}${votes}，选项：${opts}，默认：${view.defaultOption || '-'}（等待玩家选择，AI 不得代选）`;
      })
      .join('\n');
  } catch (err) {
    return `（决策状态不可用：${err.message}）`;
  }
}

/**
 * 阶段12：WORLD_STATE（世界模拟）分区 ——
 * 当前世界事件 / 阵营状态 / NPC活动 / 环境状态 / 副本变体。
 * 全部来自服务器数据库（WORLD_SIMULATION 数据，非 AI 生成）。
 */
function worldSimContent(roomId) {
  try {
    const worldSim = require('../world/worldSim');
    const snap = worldSim.worldSnapshot(roomId);
    const parts = [];
    parts.push(`调度器：tick#${snap.scheduler.lastTick}，${snap.scheduler.paused ? '已暂停' : '运行中'}`);
    parts.push(
      snap.events.length
        ? `当前世界事件：${snap.events.map((e) => `${e.label}(${e.type}/${e.category}${e.expiresAt ? `，至${e.expiresAt}` : '，永久'})`).join('；')}`
        : '当前世界事件：无'
    );
    parts.push(
      snap.relations.length
        ? `阵营关系：${snap.relations.map((r) => `${r.factionA}↔${r.factionB}=${r.relation}`).join('；')}`
        : '阵营关系：（未定义）'
    );
    parts.push(
      snap.npcs.length
        ? `NPC活动：${snap.npcs.map((n) => `${n.name}@${n.locationName || '?'}[${n.behaviorState}]${n.alive ? '' : '(死亡)'}`).join('；')}`
        : 'NPC活动：无'
    );
    const env = Object.entries(snap.environment.flags).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    parts.push(`环境状态：${env.join('，') || '（无）'}`);
    if (snap.variants.length) {
      parts.push(`副本变体：${snap.variants.map((v) => `${v.dungeon_name}=${v.variant_key}(${v.variant.label})`).join('；')}`);
    }
    return parts.join('\n');
  } catch (err) {
    return `（世界模拟状态不可用：${err.message}）`;
  }
}

/**
 * 阶段14：INVENTORY_CONTEXT —— 玩家拥有什么 / 装备了什么。
 * 隐藏内部 ID：只给名称/品质/装备状态，供 GM 叙事（如「你腰间携带着散发微光的剑」）。
 */
function inventoryContextContent(room) {
  try {
    const inventoryService = require('../inventory/inventoryService');
    const db = getDb();
    const lines = [];
    for (const p of room.players) {
      const row = db.prepare('SELECT id FROM players WHERE socket_id = ?').get(p.socketId);
      if (!row) continue;
      lines.push(`- ${p.name}: ${inventoryService.contextSummary(row.id)}`);
    }
    return lines.length ? lines.join('\n') : '（房间内没有玩家）';
  } catch (err) {
    return `（背包状态不可用：${err.message}）`;
  }
}

/**
 * 阶段18：CIVILIAN_CONTEXT（Die of Death Lore Simulation）。
 * 玩家作为普通 Civilian 的身份/经历/能力（含跨世界解释）；供 GM 模拟居民与事件。
 * 阶段19：DOD_CIVILIAN_CONTEXT —— 每个 Ability 附带 Lore Explanation
 * （为什么拥有这个能力 = 过去的人生经历；禁止解释为技能/魔法/数值）。
 */
function civilianContextContent(room) {
  try {
    const db = getDb();
    const dodLore = require('../presets/dodLore');
    const abilityLore = require('../presets/dodAbilityLore');
    const expName = room.currentDungeon ? room.currentDungeon.name : null;
    const blocks = [];
    for (const p of room.players) {
      const row = db.prepare('SELECT id FROM players WHERE socket_id = ?').get(p.socketId);
      if (!row) continue;
      const view = dodLore.loreView(row.id, expName);
      if (!view) continue;
      const lines = [
        `- ${p.name} Civilian:`,
        `  Background: ${view.background}`,
        `  Traits: ${view.personalityTraits.join('、') || '（未知）'}`,
        `  Abilities: ${view.abilities.map((a) => `${a.key}（当前解释：${a.interpretation}×${a.effectiveMultiplier}）`).join('、') || '无'}`,
      ];
      for (const a of view.abilities) {
        lines.push(`  Lore Explanation: ${a.key} —— ${a.loreExplanation || '（该能力的经历来源未知）'}`);
      }
      if (view.synergyState && view.synergyState !== 'NONE') {
        lines.push(`  Synergy: ${view.synergyState}（能力组合的大师级水平）`);
      }
      lines.push(`  Life Experience: ${view.lifeExperience || '（未知）'}`);
      blocks.push(lines.join('\n'));
    }
    if (!blocks.length) return '（房间内没有 Civilian 身份）';
    const w = dodLore.WORLD_SETTING;
    return (
      `世界：${w.world}（${w.era}）——玩家是${w.player_role}。\n` +
      `Ability 解释规则：${abilityLore.ABILITY_EXPLANATION_RULE}\n` +
      `${blocks.join('\n')}\n` +
      `（GM 纪律：普通居民/幸存者/拥有特殊经验的人；禁止超级英雄/救世主/传奇战士；` +
      `Background 只提高概率，不锁定 Ability；NPC 同样遵循 Civilian 规则。）`
    );
  } catch (err) {
    return `（Civilian 上下文不可用：${err.message}）`;
  }
}

/**
 * 阶段20：CIVILIAN_PROFILE_CONTEXT —— Background 档案 / Traits / 人格 /
 * 人生经历 / Ability 第二人称解释 / 背景推断（供 GM 叙事、NPC 互动、剧情选择）。
 * 人格不改变任何数值；Ability 解释遵守"人生经历"用语纪律。
 */
function civilianProfileContextContent(room) {
  try {
    const db = getDb();
    const dodLore = require('../presets/dodLore');
    const profileSvc = require('../presets/dodBackgroundProfile');
    const blocks = [];
    for (const p of room.players) {
      const row = db.prepare('SELECT id FROM players WHERE socket_id = ?').get(p.socketId);
      if (!row) continue;
      const view = dodLore.profileView(row.id);
      if (!view) continue;
      const lines = [
        `- ${p.name}:`,
        `  Background: ${view.background} —— ${view.backgroundDescription || '（未知经历类型）'}`,
        `  Traits: ${(view.traits.length ? view.traits.join('、') : '（未知）')}${view.profileTraits.length ? `｜背景特点：${view.profileTraits.join('、')}` : ''}`,
        `  Personality: ${view.personality.length ? view.personality.join('、') : '（未知）'}`,
        `  Life Experience: ${view.lifeExperience || '（未知）'}`,
      ];
      for (const a of view.abilities) {
        lines.push(`  Ability Explanation: ${a.key} —— ${a.gmPhrasing || a.loreExplanation || '（该能力的经历来源未知）'}`);
      }
      if (view.backgroundSurvivalLore) lines.push(`  Survival Lore: ${view.backgroundSurvivalLore}`);
      const inf = view.inferredBackground;
      if (inf && inf.top) {
        const top = inf.candidates[0];
        lines.push(`  Inferred Background: ${inf.top}（依据 ${top.matchedAbilities.join('、') || '—'}；仅为推断，同一能力可来自多种人生，不构成职业绑定）`);
      }
      blocks.push(lines.join('\n'));
    }
    if (!blocks.length) return '（房间内没有 Civilian 身份）';
    return (
      `Civilian Profile（Background=人生经历，不是职业；无职业等级/技能树/装备）：\n` +
      `${blocks.join('\n')}\n` +
      `（GM 用语纪律：${profileSvc.GM_PHRASING_RULE}\n` +
      `人格 Personality 只影响叙事语气、NPC 互动与剧情选择，绝不改变属性或检定数值；禁止英雄化描述。）`
    );
  } catch (err) {
    return `（Civilian Profile 上下文不可用：${err.message}）`;
  }
}

/**
 * 阶段21：CIVILIAN_IDENTITY_CONTEXT —— Background / Traits / Ability / Appearance / Personality。
 * 供 AI 叙事人物表现；Ability 名仅 GM 可见（NPC 与玩家叙事不得直呼，只能观察推测）。
 * 外观是人生经历的可视化，不是装备（无属性/无数值）。
 */
function civilianIdentityContextContent(room) {
  try {
    const db = getDb();
    const dodLore = require('../presets/dodLore');
    const identitySvc = require('../presets/dodIdentityPresentation');
    const blocks = [];
    for (const p of room.players) {
      const row = db.prepare('SELECT id FROM players WHERE socket_id = ?').get(p.socketId);
      if (!row) continue;
      const view = dodLore.loreView(row.id);
      if (!view) continue;
      const identity = identitySvc.ensureIdentityProfile(row.id);
      if (!identity) continue;
      const lines = [
        `- ${p.name}:`,
        `  Background: ${view.background}`,
        `  Traits: ${view.personalityTraits.join('、') || '（未知）'}`,
        `  Ability: ${view.abilities.map((a) => a.key).join('、') || '无'}（仅GM可见——叙事中不得直呼Ability名）`,
        `  Appearance: ${identity.clothingStyle}；${identity.appearanceTraits.join('、') || '普通居民外表'}`,
        `  Personality: ${view.personality.join('、') || '（未知）'}——${identity.personalityExpression.join('；') || '举止平常'}`,
      ];
      for (const sig of identity.abilitySignatures) {
        lines.push(`  NPC观察提示（${sig.ability}）: 「${sig.observation}」`);
      }
      blocks.push(lines.join('\n'));
    }
    if (!blocks.length) return '（房间内没有 Civilian 身份）';
    return (
      `Civilian Identity（人物表现档案）：\n${blocks.join('\n')}\n` +
      `（外观规则：${identitySvc.APPEARANCE_RULE}\n` +
      `NPC 识别规则：${identitySvc.NPC_IDENTIFICATION_RULE}\n` +
      `限制：${identitySvc.IDENTITY_LIMIT_RULE}）`
    );
  } catch (err) {
    return `（Civilian Identity 上下文不可用：${err.message}）`;
  }
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
    { key: 'room_status', label: 'Room Status', content: `房间 ${room.id}：AI GM 主持中。世界模拟运行，抉择/队伍/背包系统就绪。` },
    { key: 'players', label: 'Player State', content: playerStateContent(room) },
    { key: 'location', label: 'Current Location', content: `当前地点：房间 ${room.id} 的集合点。` },
    { key: 'dungeon', label: 'Current Dungeon', content: dungeonContent },
    { key: 'npc', label: 'NPC State', content: npcStateContent(room.id) },
    { key: 'events', label: 'Recent Events', content: recentEventsContent(room.id) },
    { key: 'dice_tools', label: 'Dice & Tool Results', content: diceAndToolsContent(room.id) },
    { key: 'memories', label: 'Important Memories', content: memoriesContent(room.id) },
    { key: 'world_vars', label: 'World State (versioned)', content: worldVarsContent(room.id) },
    { key: 'world_sim', label: 'WORLD_STATE (World Simulation)', content: worldSimContent(room.id) },
    { key: 'party', label: 'PARTY_CONTEXT', content: partyContextContent(room) },
    { key: 'decisions', label: 'DECISION_CONTEXT', content: decisionContextContent(room.id) },
    { key: 'inventory', label: 'INVENTORY_CONTEXT', content: inventoryContextContent(room) },
    { key: 'civilian', label: 'DOD_CIVILIAN_CONTEXT (Die of Death Lore Simulation)', content: civilianContextContent(room) },
    { key: 'civilian_profile', label: 'CIVILIAN_PROFILE_CONTEXT', content: civilianProfileContextContent(room) },
    { key: 'civilian_identity', label: 'CIVILIAN_IDENTITY_CONTEXT', content: civilianIdentityContextContent(room) },
    { key: 'avatar', label: 'Avatar / Initial State', content: avatarContext(room) },
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
