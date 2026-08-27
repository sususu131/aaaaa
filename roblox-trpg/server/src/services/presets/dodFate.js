/**
 * Die of Death 阶段24：Civilian Fate Selection System（Deck of Death Lore）。
 *
 * 这是 Lore 层模拟——不是复刻游戏 UI，不是卡牌玩法，无抽卡/稀有度/卡面机制。
 *
 * 核心概念：Civilian 进入危险环境后，会获得一组适合自身经历的生存能力。
 * 这些能力不是魔法——是自身潜能被激发、过去经历成为生存优势。
 * Deck of Death 不是普通卡牌：它代表未知力量给予 Civilian 的生存机会；
 * Civilian 无法完全控制获得什么，但自身经历（Background/Traits/Personality）
 * 会影响可能出现的能力（权重，非完全随机，也非锁定）。
 *
 * 生成流：Civilian Identity → Background → Traits → Possible Abilities →
 *         Fate Selection → Final Abilities。
 *
 * AI 描述规则：禁止"系统给你技能"；应描述
 * "你的过去经历让你发现，自己拥有处理这种情况的方法。"
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'DIE_OF_DEATH';

// ── Deck of Death Lore（官方概念）──
const FATE_SYSTEM = {
  id: 'deck_of_death',
  name: 'Deck of Death',
  description:
    'Deck of Death 不是普通卡牌。它代表未知力量给予 Civilian 的生存机会：Civilian 无法完全控制获得什么，但自身经历会影响可能出现的能力。',
  concepts: [
    'Civilian 进入危险环境后，会获得一组适合自身经历的生存能力。',
    '这些能力不是魔法：自身潜能被激发，过去经历成为生存优势。',
    'Civilian 无法完全控制获得什么；但 Background/Traits/Personality 影响可能出现的能力（权重）。',
  ],
  flow: ['Civilian Identity', 'Background', 'Traits', 'Possible Abilities', 'Fate Selection', 'Final Abilities'],
  ai_rule: '禁止"系统给你技能"；应描述："你的过去经历让你发现，自己拥有处理这种情况的方法。"',
};

// ── Background 权重分层（官方输入示例 + 阶段19 Lore 关联）──
// high：该背景的高概率能力；mid：中概率；其余 low。不锁定——任何 Civilian 仍可能获得任何 Ability。
const FATE_TIERS = {
  Medic: { high: ['Caretaker'], mid: ['BonusPad'] },
  Engineer: { high: ['BonusPad', 'Block'], mid: [] },
  Athlete: { high: ['Dash', 'Punch', 'Adrenaline'], mid: [] },
  Security: { high: ['Revolver', 'Block'], mid: [] },
  Cook: { high: ['Hotdog', 'Pie'], mid: [] },
  // 阶段25：Banana Peel/Bugle 已纳入技能池 → Artist 恢复官方关联高概率
  Artist: { high: ['Banana Peel', 'Bugle'], mid: [] },
};
const TIER_WEIGHTS = { high: 6, mid: 3, low: 1 };
const TRAIT_BONUS = 2;
const PROFILE_BONUS = 2;
const PERSONALITY_BONUS = 1;

// 官方示例组合命名与解释（Caretaker+Dash → Emergency Response）
const PAIR_NAMES = { 'Caretaker|Dash': 'Emergency Response' };
const PAIR_LORE = {
  'Caretaker|Dash': '过去接受过救援训练，同时拥有快速行动能力。',
};

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

/**
 * Fate 能力池：官方全部基础 Ability（来自 dod_abilities_lore；不含 Synergy 登记条目）。
 * 阶段25（用户指令）：Flashlight / Adrenaline / Banana Peel / Cloak / Taunt / Bugle
 * 总之所有都算技能——全部纳入 Fate 池（可发放、可被 Fate 选中）。
 */
function fatePool() {
  const abilityLore = require('./dodAbilityLore');
  return abilityLore.listAbilityLore().filter((l) => l.category !== 'synergy');
}

/**
 * 幂等播种：dod_fate_system 行 + Fate 池技能行（skills 表）。
 * 池技能用独立标记 dod_fate_ability（与阶段17 ABILITY_CATALOG 的 dod_ability 标记互不影响）。
 */
function ensureFateSeeded() {
  const db = getDb();
  db.prepare(
    `INSERT INTO dod_fate_system (id, name, description, concepts_json, flow_json, weight_tiers_json, ai_rule, lore_source, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'CANON', ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, description = excluded.description, concepts_json = excluded.concepts_json,
       flow_json = excluded.flow_json, weight_tiers_json = excluded.weight_tiers_json, ai_rule = excluded.ai_rule`
  ).run(
    FATE_SYSTEM.id,
    FATE_SYSTEM.name,
    FATE_SYSTEM.description,
    JSON.stringify(FATE_SYSTEM.concepts),
    JSON.stringify(FATE_SYSTEM.flow),
    JSON.stringify(FATE_TIERS),
    FATE_SYSTEM.ai_rule,
    SOURCE
  );
  const dodCivilian = require('./dodCivilian');
  const dungeon = dodCivilian.ensureSeeded();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO skills (name, description, source_dungeon_id, source_type, skill_type, rarity, status, effect_data)
     VALUES (?, ?, ?, 'DUNGEON', 'active', 'rare', 'approved', ?)`
  );
  // 同名已有行（阶段17 ABILITY_CATALOG 已播种的 5 项）补 fate 标记（保留原 dod_ability 标记）
  const tag = db.prepare(
    `UPDATE skills SET effect_data = json_set(effect_data, '$.dod_fate_ability', json('1'), '$.fate_trait', json_quote(?))
     WHERE name = ? AND json_extract(effect_data, '$.dod_fate_ability') IS NULL`
  );
  for (const a of fatePool()) {
    const effect = JSON.stringify({ dod_fate_ability: true, trait: a.core_trait, source: SOURCE });
    ins.run(a.name, `源于人生经历（${a.core_trait}）的生存能力。`, dungeon.id, effect);
    tag.run(a.core_trait, a.name);
  }
  return FATE_SYSTEM;
}

/** 读取 Deck of Death Lore（幂等播种）。 */
function getFateSystem() {
  ensureFateSeeded();
  const row = getDb().prepare('SELECT * FROM dod_fate_system WHERE id = ?').get(FATE_SYSTEM.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    concepts: parseJson(row.concepts_json, []),
    flow: parseJson(row.flow_json, []),
    weightTiers: parseJson(row.weight_tiers_json, {}),
    aiRule: row.ai_rule,
    loreSource: row.lore_source,
  };
}

/**
 * 单个 Ability 的 Fate 权重：Background 分层（6/3/1）+ Trait 重合加成 + 背景档案关联加成
 * + 人格一致性加成（人格模式与背景档案高度一致时，背景关联能力更可能浮现）。
 * 只提高概率——绝不锁定（无 1 Background=1 Ability）。
 */
function fateWeight(abilityKey, { background = null, traits = [], personality = [], profile = null } = {}) {
  const abilityLore = require('./dodAbilityLore');
  const tiers = FATE_TIERS[background] || { high: [], mid: [] };
  let w = tiers.high.includes(abilityKey)
    ? TIER_WEIGHTS.high
    : tiers.mid.includes(abilityKey)
      ? TIER_WEIGHTS.mid
      : TIER_WEIGHTS.low;
  const lore = abilityLore.getAbilityLore(abilityKey);
  if (lore) {
    w += TRAIT_BONUS * lore.explaining_traits.filter((t) => traits.includes(t)).length;
  }
  const bgProfile = profile || (background ? require('./dodBackgroundProfile').getProfile(String(background).toLowerCase()) : null);
  if (bgProfile && bgProfile.possible_abilities.includes(abilityKey)) w += PROFILE_BONUS;
  if (bgProfile && personality.filter((p) => bgProfile.personality_patterns.includes(p)).length >= 2) {
    if (bgProfile.possible_abilities.includes(abilityKey)) w += PERSONALITY_BONUS;
  }
  return w;
}

/** Lore 解释：官方示例优先；否则由两项 Ability 的人生经历解释合成。 */
function fateLoreReason(abilityA, abilityB, background) {
  const override = PAIR_LORE[pairKey(abilityA, abilityB)];
  if (override) return override;
  const abilityLore = require('./dodAbilityLore');
  const parts = [abilityA, abilityB].map((k) => abilityLore.abilityLoreExplanation(k, background) || '');
  return `${parts.join('')}在生死边缘，这些过去经历成为你的生存优势。`;
}

function fateOptionName(abilityA, abilityB) {
  return PAIR_NAMES[pairKey(abilityA, abilityB)] || `${abilityA} × ${abilityB}`;
}

/**
 * 生成 3 个 Fate Options：每个含 ability_1 / ability_2 / lore_reason（+名称）。
 * 权重抽样（非完全随机）；Option 内两项不重复；跨 Option 允许重复（与官方 Deck 行为一致）。
 */
function buildFateOptions({ background = null, traits = [], personality = [], rng = null } = {}) {
  let seed = rng === null ? null : Number(rng) % 1;
  const nextRoll = () => {
    if (seed === null) return crypto.randomInt(0, 100000) / 100000;
    seed = (seed + 0.137) % 1;
    return seed;
  };
  const pool = fatePool();
  const options = [];
  for (let i = 0; i < 3; i += 1) {
    const picks = [];
    let guard = 0;
    while (picks.length < 2 && guard < 200) {
      guard += 1;
      const weights = pool.map((a) => fateWeight(a.name, { background, traits, personality }));
      const total = weights.reduce((s, w) => s + w, 0);
      let roll = nextRoll() * total;
      let hit = pool.length - 1;
      for (let j = 0; j < pool.length; j += 1) {
        roll -= weights[j];
        if (roll < 0) {
          hit = j;
          break;
        }
      }
      if (!picks.includes(pool[hit].name)) picks.push(pool[hit].name);
    }
    options.push({
      optionIndex: i + 1,
      name: fateOptionName(picks[0], picks[1]),
      ability_1: picks[0],
      ability_2: picks[1],
      lore_reason: fateLoreReason(picks[0], picks[1], background),
    });
  }
  return options;
}

/**
 * 生成/替换玩家的 Fate 候选（含身份前件：Background → Traits → Personality 服务器掷取）。
 * 持久化为 deck 兼容格式（dod_civilian_offers），供 selectFate / createCivilianIdentity 复用。
 */
function offerFate(playerId, { rng = null, background = null } = {}) {
  const dodCivilian = require('./dodCivilian');
  const profileSvc = require('./dodBackgroundProfile');
  ensureFateSeeded();
  let bg = background;
  if (bg && !dodCivilian.BACKGROUNDS.includes(bg)) {
    throw new dodCivilian.DodCivilianError('BAD_BACKGROUND', `背景必须是：${dodCivilian.BACKGROUNDS.join('/')}`, 400);
  }
  let seed = rng === null ? null : Number(rng) % 1;
  const nextRoll = () => {
    if (seed === null) return crypto.randomInt(0, 100000) / 100000;
    seed = (seed + 0.137) % 1;
    return seed;
  };
  if (!bg) bg = dodCivilian.BACKGROUNDS[Math.floor(nextRoll() * dodCivilian.BACKGROUNDS.length) % dodCivilian.BACKGROUNDS.length];
  const traits = profileSvc.rollProfileTraits(bg, rng === null ? null : (Number(rng) + 0.31) % 1);
  const personality = profileSvc.rollPersonality(bg, rng === null ? null : (Number(rng) + 0.57) % 1);
  const options = buildFateOptions({ background: bg, traits, personality, rng: rng === null ? null : (Number(rng) + 0.73) % 1 });

  const abilityLore = require('./dodAbilityLore');
  const decks = options.map((o) => ({
    deckIndex: o.optionIndex,
    abilities: [o.ability_1, o.ability_2].map((key) => {
      const lore = abilityLore.getAbilityLore(key);
      return { key, trait: lore ? lore.core_trait : null, description: lore ? lore.lore_description.slice(0, 60) : '' };
    }),
    name: o.name,
    lore_reason: o.lore_reason,
    background: bg,
    traits,
    personality,
    fate: true,
  }));
  getDb()
    .prepare(
      `INSERT INTO dod_civilian_offers (player_id, decks_json) VALUES (?, ?)
       ON CONFLICT(player_id) DO UPDATE SET decks_json = ?, updated_at = datetime('now')`
    )
    .run(playerId, JSON.stringify(decks), JSON.stringify(decks));
  return { background: bg, traits, personality, options };
}

/**
 * 玩家选择 Fate Option → Final Abilities：
 * 保存 selected abilities（civilian_instance.abilities）+ fate_choice（选项名/解释）；
 * Ability 进入 character_skills（source: DIE_OF_DEATH，跨副本永久保存，离开 DOD 由 Balance 削弱）。
 */
function selectFate(io, playerId, optionIndex, { rng = null } = {}) {
  const db = getDb();
  const dodCivilian = require('./dodCivilian');
  const offer = dodCivilian.getOffer(playerId);
  if (!offer || !offer[0] || offer[0].fate !== true) {
    throw new dodCivilian.DodCivilianError('NO_FATE_OFFER', '请先生成 Fate 候选（GET /api/dod/fate/offer）', 409);
  }
  const idx = Number(optionIndex);
  if (!Number.isInteger(idx) || idx < 1 || idx > offer.length) {
    throw new dodCivilian.DodCivilianError('BAD_OPTION_INDEX', `必须选择 1~${offer.length} 号 Fate Option`, 400);
  }
  const chosen = offer[idx - 1];
  const result = dodCivilian.createCivilianIdentity(io, playerId, {
    deckIndex: idx,
    rng,
    background: chosen.background,
  });
  if (result.created) {
    db.prepare("UPDATE civilian_instance SET fate_choice = ?, updated_at = datetime('now') WHERE player_id = ?").run(
      JSON.stringify({
        optionName: chosen.name,
        loreReason: chosen.lore_reason,
        abilities: chosen.abilities.map((a) => a.key),
        traits: chosen.traits || [],
        personality: chosen.personality || [],
        background: chosen.background,
        selectedAt: new Date().toISOString(),
      }),
      playerId
    );
    // 阶段23：Fate 选择后检查 Synergy（Lore 级）
    try {
      require('./dodSynergy').checkAndSaveSynergies(playerId);
    } catch { /* Synergy 失败不阻塞选择 */ }
    // 阶段21：Identity Presentation 补建（外观/举止表现）
    try {
      const identitySvc = require('./dodIdentityPresentation');
      const civ = dodCivilian.getCivilian(playerId);
      identitySvc.saveIdentityProfile(playerId, identitySvc.buildIdentityProfile({ background: chosen.background, abilities: chosen.abilities.map((a) => a.key), personality: chosen.personality || [] }));
      void civ;
    } catch { /* 表现档案失败不阻塞 */ }
    const gameEvents = require('../quests/gameEvents');
    const player = db.prepare('SELECT room_id, name FROM players WHERE id = ?').get(playerId);
    gameEvents.emit(io, player ? player.room_id : null, {
      type: 'CIVILIAN_FATE_SELECTED',
      actor: player ? player.name : null,
      actorPlayerId: playerId,
      data: { optionName: chosen.name, abilities: chosen.abilities.map((a) => a.key), background: chosen.background, source: SOURCE },
    });
  }
  return { ...result, fate: { optionName: chosen.name, loreReason: chosen.lore_reason, abilities: chosen.abilities.map((a) => a.key) } };
}

/** 玩家的 Fate 选择视图（Context / REST 共用）。 */
function fateView(playerId) {
  const civ = getDb().prepare('SELECT fate_choice FROM civilian_instance WHERE player_id = ?').get(playerId);
  if (!civ || !civ.fate_choice) return null;
  const c = parseJson(civ.fate_choice, null);
  return c;
}

module.exports = {
  SOURCE,
  FATE_SYSTEM,
  FATE_TIERS,
  TIER_WEIGHTS,
  PAIR_NAMES,
  PAIR_LORE,
  FATE_AI_RULE: FATE_SYSTEM.ai_rule,
  ensureFateSeeded,
  getFateSystem,
  fatePool,
  fateWeight,
  fateLoreReason,
  fateOptionName,
  buildFateOptions,
  offerFate,
  selectFate,
  fateView,
};
