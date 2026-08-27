/**
 * Preset Dungeon Seeder（阶段16）：读取 presets/*.json，幂等创建
 * Dungeon / World 地点 / Quest / NPC / 阵营 / 奖励 / 副本定义。
 * 全部复用既有表与系统（dungeons/quests/npcs/npc_locations/dungeon_versions/
 * dungeon_rewards/world_sim_events/inventory）——不新增任何基础架构。
 * 红线：Lore 必须标记 CANON / TRPG_EXTENSION；剑奖励只能来自已登记真实剑库。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');

const PRESETS_DIR = path.join(__dirname, '..', '..', '..', 'presets');

class PresetError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

function loadPresetFiles() {
  const files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')));
}

// ── 幂等导入 ──
function upsertPresetRow(preset) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO preset_experiences (key, name) VALUES (?, ?)').run(preset.key, preset.name);
  db.prepare(
    `UPDATE preset_experiences SET name = ?, roblox_universe_id = COALESCE(?, roblox_universe_id), roblox_place_id = COALESCE(?, roblox_place_id),
     description = ?, genre = ?, difficulty = ?, source_type = 'CANON_PRESET' WHERE key = ?`
  ).run(preset.name, preset.roblox_universe_id || null, preset.roblox_place_id || null, preset.description || '', preset.genre || '', preset.difficulty || 1, preset.key);
  return db.prepare('SELECT * FROM preset_experiences WHERE key = ?').get(preset.key);
}

function ensureDungeon(preset) {
  const db = getDb();
  if (preset.reuse_existing_dungeon) {
    const existing = db.prepare('SELECT * FROM dungeons WHERE roblox_experience_name = ?').get(preset.reuse_existing_dungeon);
    if (!existing) throw new PresetError('DUNGEON_NOT_FOUND', `复用副本 ${preset.reuse_existing_dungeon} 不存在`, 404);
    return existing;
  }
  db.prepare('INSERT OR IGNORE INTO dungeons (roblox_experience_name, dungeon_name, difficulty, description, uid) VALUES (?, ?, ?, ?, ?)').run(
    preset.name,
    preset.dungeon.dungeon_name,
    preset.difficulty || 1,
    preset.description || '',
    `dungeon_${preset.key}`
  );
  const row = db.prepare('SELECT * FROM dungeons WHERE roblox_experience_name = ?').get(preset.name);
  // CANON IDs 仅在缺失时回填（不覆盖既有官方资料）
  if (preset.roblox_universe_id && !row.roblox_universe_id) {
    db.prepare('UPDATE dungeons SET roblox_universe_id = ? WHERE id = ? AND roblox_universe_id IS NULL').run(preset.roblox_universe_id, row.id);
  }
  if (preset.roblox_place_id && !row.roblox_place_id) {
    db.prepare('UPDATE dungeons SET roblox_place_id = ? WHERE id = ? AND roblox_place_id IS NULL').run(preset.roblox_place_id, row.id);
  }
  return db.prepare('SELECT * FROM dungeons WHERE id = ?').get(row.id);
}

function ensureLocations(preset) {
  const db = getDb();
  const locs = (preset.world && preset.world.locations) || [];
  const ins = db.prepare('INSERT OR IGNORE INTO npc_locations (key, name, description, is_safe) VALUES (?, ?, ?, ?)');
  for (const l of locs) ins.run(l.key, l.name, l.description || '', l.is_safe ? 1 : 0);
  return locs.length;
}

function ensureFactions(preset, dungeonId) {
  const db = getDb();
  const factions = preset.factions || [];
  for (const f of factions) {
    db.prepare('INSERT OR IGNORE INTO factions (uid, name, description, dungeon_id) VALUES (?, ?, ?, ?)').run(
      `faction_preset_${preset.key}_${f.uid_suffix}`,
      f.name,
      f.description || '',
      dungeonId
    );
  }
  return factions.length;
}

function ensureNpcs(preset, dungeonId) {
  const db = getDb();
  let count = 0;
  const make = (uidSuffix, name, description, nature, factionSuffix, loreSource) => {
    const factionId = factionSuffix
      ? (db.prepare('SELECT id FROM factions WHERE uid = ?').get(`faction_preset_${preset.key}_${factionSuffix}`) || {}).id || null
      : null;
    const existing = db.prepare('SELECT 1 FROM npcs WHERE uid = ?').get(`npc_preset_${preset.key}_${uidSuffix}`);
    if (!existing) {
      db.prepare(
        'INSERT INTO npcs (uid, name, description, avatar, personality_json, goals_json, knowledge_json, faction_id, nature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        `npc_preset_${preset.key}_${uidSuffix}`,
        name,
        description || '',
        '🧍',
        JSON.stringify({ lore_source: loreSource || 'TRPG_EXTENSION' }),
        '[]',
        '[]',
        factionId,
        nature || 'neutral'
      );
      count += 1;
    }
  };
  for (const n of preset.npcs || []) make(n.uid_suffix, n.name, n.description, n.nature, n.faction_suffix, n.lore_source);
  for (const e of preset.entities || []) make(e.uid_suffix, e.name, e.description, 'hostile', null, e.lore_source);
  return count;
}

function ensureQuest(preset, dungeonId) {
  const db = getDb();
  const q = preset.quest;
  if (!q) return null;
  db.prepare('INSERT OR IGNORE INTO quests (uid, name, description, type, status, source_type, dungeon_id, difficulty, max_players) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3)').run(
    q.uid,
    q.name,
    q.description || '',
    'MAIN',
    'ACTIVE',
    'CANON_PRESET',
    dungeonId,
    preset.difficulty || 1
  );
  const quest = db.prepare('SELECT * FROM quests WHERE uid = ?').get(q.uid);
  const hasVersion = db.prepare('SELECT 1 FROM quest_versions WHERE quest_id = ? AND version = 1').get(quest.id);
  if (!hasVersion) {
    db.prepare("INSERT INTO quest_versions (quest_id, version, definition_json, status, published_at) VALUES (?, 1, ?, 'PUBLISHED', datetime('now'))").run(
      quest.id,
      JSON.stringify({ scope: 'PARTY', rewards: [] })
    );
  }
  const version = db.prepare('SELECT * FROM quest_versions WHERE quest_id = ? AND version = 1').get(quest.id);
  const insObj = db.prepare(
    'INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json) VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?)'
  );
  for (const o of q.objectives) {
    insObj.run(version.id, o.key, o.name, o.description || '', o.type, o.order_index || 1, JSON.stringify({ event_type: o.event_type || null, match: o.match || {} }));
  }
  return quest;
}

function buildDefinition(preset, dungeonId = null) {
  const firstScene = preset.dungeon.scenes[0] ? preset.dungeon.scenes[0].id : null;
  const canonFacts = [];
  for (const e of preset.entities || []) if (e.lore_source === 'CANON') canonFacts.push(`官方实体：${e.name}`);
  for (const e of preset.enemies || []) if (e.lore_source === 'CANON') canonFacts.push(`官方实体：${e.name}`);
  for (const n of preset.npcs || []) if (n.lore_source === 'CANON') canonFacts.push(`官方角色：${n.name}`);
  return {
    dungeon: { display_name: preset.dungeon.dungeon_name },
    dungeon_id: dungeonId || undefined, // 任务联动（questEngine.onDungeonInstanceStarted）依赖此字段
    source_type: 'CANON_PRESET',
    canonical_facts: canonFacts,
    roblox_universe_id: preset.roblox_universe_id || undefined,
    scenes: preset.dungeon.scenes.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description || '',
      source_type: 'TRPG_ORIGINAL',
      order: s.order,
      possible_actions: [],
      exits: s.exits || [],
      encounters: s.encounters || [],
      events: s.events || [],
    })),
    encounters: (preset.dungeon.encounters || []).map((e) => ({
      id: e.id,
      name: e.name,
      type: 'COMBAT',
      description: e.description || '',
      participants: e.participants || [],
      trigger: '',
      resolution: '',
      difficulty: e.difficulty || preset.difficulty || 1,
      possible_checks: [],
      source_type: 'TRPG_ORIGINAL',
    })),
    enemies: (preset.enemies || []).map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description || '',
      source_type: e.lore_source || 'TRPG_EXTENSION',
      stats: e.stats,
      skills: [],
      behaviour: e.behaviour || 'attack',
      weaknesses: [],
      resistances: [],
      loot: e.loot || [],
    })),
    boss: null,
    npcs: (preset.npcs || []).map((n) => ({ uid: `npc_preset_${preset.key}_${n.uid_suffix}`, spawn_scene: firstScene })),
    events: preset.dungeon.events || [],
    reward_candidates: [],
  };
}

function ensureDefinitionVersion(preset, dungeon) {
  const db = getDb();
  if (preset.reuse_official_definition) {
    const officialContent = require('../runtime/officialContent');
    return officialContent.materializeOfficial(preset.reuse_existing_dungeon);
  }
  const existing = db.prepare("SELECT * FROM dungeon_versions WHERE dungeon_id = ? AND version = 1").get(dungeon.id);
  if (existing) return existing;
  db.prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, status, published_at) VALUES (?, 1, ?, 'PUBLISHED', datetime('now'))").run(
    dungeon.id,
    JSON.stringify(buildDefinition(preset, dungeon.id))
  );
  return db.prepare('SELECT * FROM dungeon_versions WHERE dungeon_id = ? AND version = 1').get(dungeon.id);
}

function ensureRewards(preset, dungeonId) {
  const db = getDb();
  let count = 0;
  for (const r of preset.rewards || []) {
    if (r.type === 'currency') {
      const cur = db.prepare('SELECT * FROM currencies WHERE name = ?').get(r.name);
      if (!cur) continue; // 不存在的奖励绝不创建
      db.prepare("INSERT OR IGNORE INTO dungeon_rewards (dungeon_id, reward_type, reward_id, drop_rate, is_guaranteed, status, condition_data) VALUES (?, 'currency', ?, 1.0, 1, 'approved', ?)").run(
        dungeonId,
        cur.id,
        JSON.stringify({ amount: Math.max(1, Math.min(100000, Number(r.amount) || 100)) })
      );
      count += 1;
    } else if (r.type === 'item') {
      const item = db.prepare("SELECT * FROM items WHERE name = ? AND status = 'approved'").get(r.name);
      if (!item) continue;
      db.prepare("INSERT OR IGNORE INTO dungeon_rewards (dungeon_id, reward_type, reward_id, drop_rate, is_guaranteed, status) VALUES (?, 'item', ?, 1.0, 1, 'approved')").run(dungeonId, item.id);
      count += 1;
    } else if (r.type === 'skill') {
      const skill = db.prepare("SELECT * FROM skills WHERE name = ? AND status = 'approved'").get(r.name);
      if (!skill) continue;
      db.prepare("INSERT OR IGNORE INTO dungeon_rewards (dungeon_id, reward_type, reward_id, drop_rate, is_guaranteed, status) VALUES (?, 'skill', ?, 1.0, 1, 'approved')").run(dungeonId, skill.id);
      count += 1;
    }
  }
  return count;
}

/** 导入单个预设（全幂等：重复运行不产生重复数据）。 */
function importPreset(io, preset) {
  const db = getDb();
  if (!preset.key || !preset.name) throw new PresetError('BAD_PRESET', '预设缺少 key/name');
  const presetRow = upsertPresetRow(preset);
  const dungeon = ensureDungeon(preset);
  const locations = ensureLocations(preset);
  const factions = ensureFactions(preset, dungeon.id);
  const npcs = ensureNpcs(preset, dungeon.id);
  const quest = ensureQuest(preset, dungeon.id);
  const version = ensureDefinitionVersion(preset, dungeon);
  const rewards = ensureRewards(preset, dungeon.id);
  db.prepare('INSERT OR IGNORE INTO preset_dungeon_configs (preset_id, dungeon_id, config_json, status) VALUES (?, ?, ?, ?)').run(
    presetRow.id,
    dungeon.id,
    JSON.stringify(preset),
    'DRAFT'
  );
  db.prepare("UPDATE preset_dungeon_configs SET dungeon_id = ?, status = 'PUBLISHED', published_at = datetime('now') WHERE preset_id = ?").run(dungeon.id, presetRow.id);
  return {
    key: preset.key,
    presetId: presetRow.id,
    dungeonId: dungeon.id,
    versionId: version.id,
    questUid: quest ? quest.uid : null,
    created: { locations, factions, npcs, rewards },
  };
}

/** 导入全部预设（幂等）。 */
function runPresetSeeder(io = null) {
  const results = [];
  for (const preset of loadPresetFiles()) {
    try {
      results.push(importPreset(io, preset));
    } catch (err) {
      results.push({ key: preset.key, error: err.message });
    }
  }
  return results;
}

// ── 视图（UI：Experience Select Panel）──
async function presetView() {
  const db = getDb();
  const presets = db.prepare('SELECT * FROM preset_experiences ORDER BY id').all();
  const thumbnails = require('../roblox/robloxThumbnails');
  const out = [];
  for (const p of presets) {
    const cfg = db.prepare('SELECT * FROM preset_dungeon_configs WHERE preset_id = ?').get(p.id);
    let iconUrl = null;
    if (p.roblox_universe_id) {
      try {
        iconUrl = await thumbnails.getGameIcon(p.roblox_universe_id);
      } catch {
        iconUrl = null; // 离线/失败不影响可玩性
      }
    }
    out.push({
      key: p.key,
      name: p.name,
      description: p.description,
      genre: p.genre,
      difficulty: p.difficulty,
      iconUrl,
      sourceType: p.source_type,
      status: cfg ? cfg.status : 'DRAFT',
      dungeonId: cfg ? cfg.dungeon_id : null,
      versionId: cfg && cfg.status === 'PUBLISHED' ? db.prepare('SELECT v.id FROM dungeon_versions v WHERE v.dungeon_id = ? AND v.status = ? ORDER BY v.version DESC LIMIT 1').get(cfg.dungeon_id, 'PUBLISHED')?.id : null,
    });
  }
  return out;
}

// ── 高地剑斗：表现评分 → 永久剑（第六节）──
const DEFAULT_GRADES = { S: 90, A: 75, B: 50, C: 25 };
const GRADE_RARITY = { S: 'legendary', A: 'epic', B: 'rare', C: 'common' };
const RARITY_POWER = { common: 40, rare: 55, epic: 70, legendary: 100 };

function gradeForScore(score, grades = DEFAULT_GRADES) {
  const order = ['S', 'A', 'B', 'C'];
  for (const g of order) {
    if (score >= grades[g]) return g;
  }
  return null;
}

/**
 * 按评分发放永久剑（剑只能来自 experience_items 已登记的真实剑库 —— 禁止创造）。
 * 永久保存 + 进入其他副本自动削弱（阶段14 平衡规则）。
 */
function grantSwordByScore(io, playerId, { score, experienceName = 'Sword Fight on the Heights', rng = null, grantKey = null } = {}) {
  const db = getDb();
  const grade = gradeForScore(score);
  if (!grade) return { ok: false, reason: 'SCORE_TOO_LOW', grade: null, score };
  const rarity = GRADE_RARITY[grade];
  const swords = db
    .prepare("SELECT * FROM experience_items WHERE source_experience = ? AND rarity = ? AND status = 'approved'")
    .all(experienceName, rarity);
  if (!swords.length) return { ok: false, reason: 'NO_SWORD_IN_GRADE', grade, score };
  const pick = rng !== null ? swords[Math.floor(rng * swords.length) % swords.length] : swords[crypto.randomInt(0, swords.length)];

  // 旧物品表同步（奖励链复用）+ 永久物品登记（阶段11）
  db.prepare("INSERT OR IGNORE INTO items (name, description, source_type, rarity, status, kind, slot, stacking) VALUES (?, ?, 'official', ?, 'approved', 'weapon', 'weapon', 'UNIQUE')").run(
    pick.name,
    pick.description || '',
    rarity
  );
  const item = db.prepare('SELECT * FROM items WHERE name = ?').get(pick.name);
  const legendEncounter = require('../legends/legendEncounter');
  legendEncounter.grantPermanentItem(playerId, item.id, experienceName);

  // 持久背包（阶段14）：永久定义 + 强度元数据（服务器固定值，TRPG_ORIGINAL）
  const inventoryService = require('../inventory/inventoryService');
  const def = inventoryService.syncDefinitionFromLegacyItem(item);
  const basePower = RARITY_POWER[rarity] || 40;
  db.prepare("UPDATE item_definitions SET permanent = 1, base_power = ?, metadata_json = ? WHERE id = ?").run(
    basePower,
    JSON.stringify({ damage: basePower, source: experienceName }),
    def.id
  );
  const add = inventoryService.addItem(io, playerId, def.item_key, {
    amount: 1,
    sourceType: 'PRESET_SWORD',
    sourceId: `${experienceName}:${grade}`,
    grantKey: grantKey || null,
  });
  return { ok: true, grade, score, sword: pick.name, rarity, permanent: true, granted: add.added, reason: add.reason || null };
}

// ── Something Evil：进入副本触发随机灾害事件（第七节，服务器抽签）──
function maybeTriggerPresetEvents(io, instance) {
  const db = getDb();
  const cfgRow = db.prepare('SELECT * FROM preset_dungeon_configs WHERE dungeon_id = ? AND status = ?').get(
    (db.prepare('SELECT dungeon_id FROM dungeon_versions WHERE id = ?').get(instance.dungeon_version_id) || {}).dungeon_id,
    'PUBLISHED'
  );
  if (!cfgRow) return null;
  const cfg = parseJson(cfgRow.config_json, {});
  if (!cfg.random_events_on_start || !Array.isArray(cfg.random_events) || !cfg.random_events.length) return null;
  const worldEvents = require('../world/worldEvents');
  const candidates = cfg.random_events.filter((t) => worldEvents.AI_REQUESTABLE_TYPES.includes(t));
  if (candidates.length < 2) {
    // 单候选也允许（服务器触发，非 AI 抽签）
    if (candidates.length === 1) {
      return worldEvents.triggerWorldEvent(io, instance.room_id, { type: candidates[0], source: 'preset', dedupeKey: `preset_event:${instance.id}`, data: { preset: cfg.key } });
    }
    return null;
  }
  const type = worldEvents.pickRandomEventType(instance.room_id, { candidates });
  return worldEvents.triggerWorldEvent(io, instance.room_id, { type, source: 'preset', dedupeKey: `preset_event:${instance.id}`, data: { preset: cfg.key, candidates } });
}

module.exports = {
  PresetError,
  PRESETS_DIR,
  loadPresetFiles,
  importPreset,
  runPresetSeeder,
  presetView,
  gradeForScore,
  DEFAULT_GRADES,
  GRADE_RARITY,
  grantSwordByScore,
  maybeTriggerPresetEvents,
};
