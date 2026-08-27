/**
 * Die of Death 预设 Phase 1：Civilian System（阶段17）。
 *
 * 设定纪律（必须遵守）：
 *  - Civilian 是【模板】，代表一类普通居民 —— 禁止固定英雄角色（无 John/Mike/Alice）；
 *  - Ability 不是魔法，是普通人用于生存的技能；Background 只解释 Ability 来源，不是职业系统；
 *  - 多个 Civilian 允许拥有相同 Ability（无唯一职业限制）；
 *  - Synergy 不是特殊种族：拥有匹配 Trait/Ability 组合的 Civilian 升级为 Synergy；
 *  - Ability 永久保存（source: DIE_OF_DEATH → character_skills），离开 DOD 后由 Balance 系统削弱；
 *  - GM 描述：普通人/幸存者/拥有特殊技能的人；禁止超级英雄/职业战士/救世主。
 *  - 本文件内容全部来自官方设定输入，不创造原创 Lore。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'DIE_OF_DEATH';
const DOD_EXPERIENCE = 'Die of Death';

class DodCivilianError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ── 官方设定（Civilian - The Victims）──
const CIVILIAN_FACTION = {
  uid: 'faction_dod_robloxia_citizens',
  name: 'Robloxia Citizens',
  description:
    'Civilians are the average Citizens inhabiting Robloxia. They are ordinary people who must survive against Killers that are running amuck and killing people for different reasons.',
};

// Background：职业/兴趣/生活经历 —— 只解释 Ability 来源，不是职业系统
const BACKGROUNDS = ['Engineer', 'Medic', 'Athlete', 'Cook', 'Security', 'Artist'];

// Ability 目录（官方）：key / 含义 / 对应 Trait（技能来源）
const ABILITY_CATALOG = [
  { key: 'Punch', description: '代表强大的身体能力。', trait: 'Physical Training' },
  { key: 'Caretaker', description: '代表医疗能力。', trait: 'Medical Knowledge' },
  { key: 'Revolver', description: '代表枪械训练。', trait: 'Firearms Training' },
  { key: 'Hotdog', description: '代表特殊习惯。', trait: 'Special Habit' },
  { key: 'BonusPad', description: '代表支援设施能力。', trait: 'Support Facility' },
];

// Synergy 规则（官方示例）：Caretaker + BonusPad → CarePad（医疗能力 + 支援设施能力）
const SYNERGY_RULES = [
  { requires: ['Caretaker', 'BonusPad'], result: 'CarePad', description: '医疗能力 + 支援设施能力。' },
];

// Balance（跨副本）：DOD Ability 永久保存，离开 DOD 后被削弱
const BALANCE_MULTIPLIER = { home: 1.0, away: 0.5 };

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

/** DOD 副本行（由阶段16 预设导入；未导入则报错）。 */
function dodDungeon() {
  const db = getDb();
  const cfg = db.prepare("SELECT c.dungeon_id FROM preset_dungeon_configs c JOIN preset_experiences p ON p.id = c.preset_id WHERE p.key = 'dod'").get();
  if (!cfg || !cfg.dungeon_id) throw new DodCivilianError('DOD_PRESET_NOT_IMPORTED', '请先导入 Die of Death 预设（阶段16 导入器）', 409);
  return db.prepare('SELECT * FROM dungeons WHERE id = ?').get(cfg.dungeon_id);
}

/** 幂等播种：阵营 + Ability 定义（skills 表，approved；发放走 character_skills）。 */
function ensureSeeded() {
  const db = getDb();
  const dungeon = dodDungeon();
  db.prepare('INSERT OR IGNORE INTO factions (uid, name, description, dungeon_id) VALUES (?, ?, ?, ?)').run(
    CIVILIAN_FACTION.uid,
    CIVILIAN_FACTION.name,
    CIVILIAN_FACTION.description,
    dungeon.id
  );
  const ins = db.prepare(
    `INSERT OR IGNORE INTO skills (name, description, source_dungeon_id, source_type, skill_type, rarity, status, effect_data)
     VALUES (?, ?, ?, 'DUNGEON', 'active', 'rare', 'approved', ?)`
  );
  for (const a of ABILITY_CATALOG) {
    ins.run(a.key, a.description, dungeon.id, JSON.stringify({ dod_ability: true, trait: a.trait, source: SOURCE }));
  }
  for (const s of SYNERGY_RULES) {
    db.prepare(
      `INSERT OR IGNORE INTO skills (name, description, source_dungeon_id, source_type, skill_type, rarity, status, effect_data)
       VALUES (?, ?, ?, 'DUNGEON', 'reaction', 'epic', 'approved', ?)`
    ).run(s.result, s.description, dungeon.id, JSON.stringify({ dod_ability: true, synergy: true, requires: s.requires, source: SOURCE }));
  }
  return dungeon;
}

function abilitySkillRow(key) {
  return getDb().prepare("SELECT * FROM skills WHERE name = ? AND status = 'approved'").get(key);
}

/** 服务器抽取 Ability Deck：3 个 Deck，每个 2 个 Ability（Deck 内不重复；不同 Deck 间允许重复）。 */
function rollAbilityDecks(rng = null) {
  let seed = rng === null ? null : Number(rng) % 1;
  const nextRoll = () => {
    if (seed === null) return crypto.randomInt(0, 100000) / 100000;
    seed = (seed + 0.137) % 1; // 注入种子时的确定性步进序列（可测试）
    return seed;
  };
  const decks = [];
  for (let d = 0; d < 3; d += 1) {
    const picks = [];
    let guard = 0;
    while (picks.length < 2 && guard < 100) {
      guard += 1;
      const roll = nextRoll();
      const a = ABILITY_CATALOG[Math.floor(roll * ABILITY_CATALOG.length) % ABILITY_CATALOG.length];
      if (!picks.some((p) => p.key === a.key)) picks.push({ key: a.key, trait: a.trait, description: a.description });
    }
    decks.push({ deckIndex: d + 1, abilities: picks });
  }
  return decks;
}

/** 生成/替换玩家的 Deck 候选（幂等：单行）。 */
function offerDecks(playerId, { rng = null } = {}) {
  const db = getDb();
  ensureSeeded();
  const decks = rollAbilityDecks(rng);
  db.prepare(
    `INSERT INTO dod_civilian_offers (player_id, decks_json) VALUES (?, ?)
     ON CONFLICT(player_id) DO UPDATE SET decks_json = ?, updated_at = datetime('now')`
  ).run(playerId, JSON.stringify(decks), JSON.stringify(decks));
  return decks;
}

function getOffer(playerId) {
  const row = getDb().prepare('SELECT * FROM dod_civilian_offers WHERE player_id = ?').get(playerId);
  return row ? parseJson(row.decks_json, []) : null;
}

function getCivilian(playerId) {
  return getDb().prepare('SELECT * FROM civilian_instance WHERE player_id = ?').get(playerId) || null;
}

function ownsAbility(playerId, abilityKey) {
  const skill = abilitySkillRow(abilityKey);
  if (!skill) return false;
  return Boolean(getDb().prepare('SELECT 1 FROM player_skills WHERE player_id = ? AND skill_id = ?').get(playerId, skill.id));
}

/** Synergy 检测：满足组合条件 → 授予 Synergy Ability（幂等，不重复升级）。 */
function checkSynergy(io, playerId) {
  const db = getDb();
  const civ = getCivilian(playerId);
  for (const rule of SYNERGY_RULES) {
    if (!rule.requires.every((k) => ownsAbility(playerId, k))) continue;
    if (civ && civ.synergy_state === rule.result) continue; // 已达成
    const synSkill = abilitySkillRow(rule.result);
    if (!synSkill) continue;
    if (!ownsAbility(playerId, rule.result)) {
      const characterService = require('../character/characterService');
      const dungeon = dodDungeon();
      characterService.grantSkill(playerId, synSkill.id, { sourceType: SOURCE, sourceId: `synergy:${rule.requires.join('+')}`, obtainedFromDungeonId: dungeon.id });
    }
    db.prepare('UPDATE civilian_instance SET synergy_state = ?, updated_at = datetime(\'now\') WHERE player_id = ?').run(rule.result, playerId);
    const gameEvents = require('../quests/gameEvents');
    const player = db.prepare('SELECT room_id, name FROM players WHERE id = ?').get(playerId);
    gameEvents.emit(io, player ? player.room_id : null, {
      type: 'CIVILIAN_SYNERGY',
      actor: player ? player.name : null,
      actorPlayerId: playerId,
      data: { synergy: rule.result, requires: rule.requires, source: SOURCE },
    });
    return { synergy: rule.result, requires: rule.requires };
  }
  return null;
}

/**
 * 玩家进入 DOD 流程：Civilian Identity → Ability Deck 选择 → 获得 Ability → 生存阶段。
 * 幂等：已有身份直接返回（不重复生成）。
 */
function createCivilianIdentity(io, playerId, { deckIndex, rng = null, background = null } = {}) {
  const db = getDb();
  const dungeon = ensureSeeded();
  const existing = getCivilian(playerId);
  if (existing) {
    return { created: false, reason: 'ALREADY_HAS_IDENTITY', civilian: existing };
  }
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) throw new DodCivilianError('PLAYER_NOT_FOUND', '玩家不存在', 404);

  let decks = getOffer(playerId);
  if (!decks) decks = offerDecks(playerId, { rng });
  const idx = Number(deckIndex);
  if (!Number.isInteger(idx) || idx < 1 || idx > decks.length) {
    throw new DodCivilianError('BAD_DECK_INDEX', `必须选择 1~${decks.length} 号 Deck`, 400);
  }
  const deck = decks[idx - 1];

  // Background：从官方池服务器随机（或按输入验证后使用）——模板，不是固定角色
  let bg = background;
  if (bg && !BACKGROUNDS.includes(bg)) throw new DodCivilianError('BAD_BACKGROUND', `背景必须是：${BACKGROUNDS.join('/')}`, 400);
  if (!bg) {
    const roll = rng !== null ? rng : crypto.randomInt(0, 100000) / 100000;
    bg = BACKGROUNDS[Math.floor(roll * BACKGROUNDS.length) % BACKGROUNDS.length];
  }

  const traits = deck.abilities.map((a) => a.trait);
  const abilityKeys = deck.abilities.map((a) => a.key);
  db.prepare('INSERT INTO civilian_instance (player_id, background, traits, abilities, synergy_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
    playerId,
    bg,
    JSON.stringify(traits),
    JSON.stringify(abilityKeys),
    'NONE',
    SOURCE
  );

  // Ability 绑定 → character_skills（player_skills），source: DIE_OF_DEATH；允许与其他玩家重复
  const characterService = require('../character/characterService');
  const grants = [];
  for (const key of abilityKeys) {
    const skill = abilitySkillRow(key);
    if (!skill) throw new DodCivilianError('ABILITY_NOT_FOUND', `Ability ${key} 未登记`, 500);
    grants.push({ ability: key, ...characterService.grantSkill(playerId, skill.id, { sourceType: SOURCE, sourceId: `deck:${idx}`, obtainedFromDungeonId: dungeon.id }) });
  }

  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, player.room_id, {
    type: 'CIVILIAN_CREATED',
    actor: player.name,
    actorPlayerId: playerId,
    data: { background: bg, traits, abilities: abilityKeys, source: SOURCE },
  });

  const synergy = checkSynergy(io, playerId);
  return { created: true, civilian: getCivilian(playerId), grants, synergy, decks };
}

/** 跨副本 Balance：DOD 内 1.0；离开 DOD 后削弱（永久保存，不删除）。 */
function dodAbilityMultiplier(experienceName = null) {
  if (experienceName && String(experienceName).toLowerCase() === DOD_EXPERIENCE.toLowerCase()) return BALANCE_MULTIPLIER.home;
  return BALANCE_MULTIPLIER.away;
}

/** 玩家的 DOD Ability 视图（含跨副本有效倍率）。 */
function civilianView(playerId, experienceName = null) {
  const db = getDb();
  const civ = getCivilian(playerId);
  if (!civ) return null;
  const mult = dodAbilityMultiplier(experienceName);
  const abilities = parseJson(civ.abilities, []).map((key) => {
    const owned = db
      .prepare('SELECT ps.level FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id = ? AND s.name = ?')
      .get(playerId, key);
    const meta = abilitySkillRow(key);
    return {
      key,
      level: owned ? owned.level : 0,
      trait: parseJson(meta ? meta.effect_data : '{}', {}).trait || null,
      effectiveMultiplier: mult,
    };
  });
  return {
    playerId,
    background: civ.background,
    traits: parseJson(civ.traits, []),
    abilities,
    synergyState: civ.synergy_state,
    source: civ.source,
    experience: experienceName || null,
    balanceMultiplier: mult,
    faction: CIVILIAN_FACTION.name,
    note: 'Civilian 是普通居民模板：幸存者，拥有特殊技能的普通人（非超级英雄/职业战士/救世主）。',
  };
}

module.exports = {
  DodCivilianError,
  SOURCE,
  DOD_EXPERIENCE,
  CIVILIAN_FACTION,
  BACKGROUNDS,
  ABILITY_CATALOG,
  SYNERGY_RULES,
  BALANCE_MULTIPLIER,
  ensureSeeded,
  rollAbilityDecks,
  offerDecks,
  getOffer,
  getCivilian,
  ownsAbility,
  checkSynergy,
  createCivilianIdentity,
  dodAbilityMultiplier,
  civilianView,
};
