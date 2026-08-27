/**
 * Die of Death Lore Simulation（阶段18）。
 *
 * 这是 Lore Simulation —— 不是游戏玩法复刻：
 *  - 不实现：Round 系统 / Deck 抽卡 UI / 胜负条件 / Killers 玩法 / 竞技模式；
 *  - 目标：让 AI GM 能够模拟 Robloxia 世界中的居民（Civilian）与事件。
 *
 * 设定纪律：Civilian 没有固定身份（不是角色模板/英雄/特殊人物），代表一类居民；
 * Background 是人生经历（非职业系统）；Trait 决定 Ability 出现可能性；
 * Ability 不是魔法/超能力/技能树，是 Civilian 利用自身经历生存；
 * Synergy 是能力组合的大师级水平（不是升级/职业进化）；
 * 所有内容仅使用官方设定输入，不创造原创 Lore。
 */
const crypto = require('crypto');
const dodCivilian = require('./dodCivilian');

class DodLoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ── World Setting（官方）──
const WORLD_SETTING = {
  experience: 'Die of Death',
  world: 'Robloxia',
  era: 'Killers出现后的异常时期',
  player_role: '普通Civilian（不是英雄）',
};

// ── Trait 池（官方）：个人特点，决定 Ability 出现可能性 ──
const TRAIT_POOL = [
  'Medical Knowledge',
  'Physical Training',
  'Engineering Experience',
  'Weapon Familiarity',
  'Cooking Skill',
  'Special Habit',      // 阶段17 官方（Hotdog）
  'Support Facility',   // 阶段17 官方（BonusPad）
];

// Trait → Ability 权重映射（官方示例 + 阶段17 官方组合）
const TRAIT_ABILITY_AFFINITY = {
  'Medical Knowledge': ['Caretaker'],
  'Physical Training': ['Punch'],
  'Engineering Experience': ['BonusPad'],
  'Weapon Familiarity': ['Revolver'],
  'Cooking Skill': ['Hotdog'],
  'Special Habit': ['Hotdog'],
  'Support Facility': ['BonusPad'],
};

// Background → 倾向 Trait（官方：解释为什么拥有某种能力；不是职业系统）
const BACKGROUND_AFFINITY = {
  Engineer: 'Engineering Experience', // 建设相关能力
  Medic: 'Medical Knowledge',         // 治疗相关能力
  Athlete: 'Physical Training',       // 移动/身体能力
  Cook: 'Cooking Skill',              // 食物相关能力
  Security: 'Weapon Familiarity',     // 防御能力
  Artist: null,                       // 无固定倾向
};

// Ability 跨世界解释（官方示例：Caretaker 在 DOD=专业生存能力，普通世界=医疗经验）
// 阶段19 补充 Lore 目录扩展项（Block/Dash/Pie/Loveshot：Lore 解释数据，非发放技能）
const ABILITY_INTERPRETATIONS = {
  Punch: { dod: '专业生存能力', default: '强大的身体训练' },
  Caretaker: { dod: '专业生存能力', default: '医疗经验' },
  Revolver: { dod: '专业生存能力', default: '枪械使用经验' },
  Hotdog: { dod: '专业生存能力', default: '特殊习惯或个人能力' },
  BonusPad: { dod: '专业生存能力', default: '支援设施能力' },
  Dash: { dod: '专业生存能力', default: '敏捷与移动经验' },
  Block: { dod: '专业生存能力', default: '防护与工事经验' },
  Pie: { dod: '专业生存能力', default: '烘焙与烹饪经验' },
  CarePad: { dod: '大师级能力组合', default: '医疗知识 + 工程能力的组合' },
  Loveshot: { dod: '大师级能力组合', default: '射击经验 + 关怀之心的组合（预留）' },
};

// 未来扩展接口（预留，不实现）
const FUTURE_HOOKS = {
  Government: 'reserved',
  Bunker: 'reserved',
  Killer: 'reserved',
  WorldEvents: 'reserved',
  LoreLocations: 'reserved',
};

function pick(arr, roll) {
  return arr[Math.floor(roll * arr.length) % arr.length];
}

/** Ability 权重：Trait 决定出现可能性（1 基础 + 每个匹配 Trait +2）。 */
function abilityWeight(abilityKey, traits) {
  let w = 1;
  for (const t of traits) {
    if ((TRAIT_ABILITY_AFFINITY[t] || []).includes(abilityKey)) w += 2;
  }
  return w;
}

/**
 * 按 Trait 权重抽取 Ability（服务器随机；可注入种子）。
 * 阶段19：可选 background 参数 —— 关联背景提高该 Ability 概率（权重 +2），
 * 其余 Ability 保持基础权重：只是概率提高，不是固定绑定（任何背景都可能抽到任何 Ability）。
 */
function rollAbilitiesByTraits(traits, count = 2, rng = null, background = null) {
  let seed = rng === null ? null : Number(rng) % 1;
  const nextRoll = () => {
    if (seed === null) return crypto.randomInt(0, 100000) / 100000;
    seed = (seed + 0.137) % 1;
    return seed;
  };
  const picks = [];
  let guard = 0;
  while (picks.length < count && guard < 200) {
    guard += 1;
    const catalog = dodCivilian.ABILITY_CATALOG;
    const abilityLore = require('./dodAbilityLore');
    const weights = catalog.map((a) => {
      let w = abilityWeight(a.key, traits);
      if (background) w += Math.max(0, abilityLore.backgroundAbilityWeight(a.key, background) - 1);
      return w;
    });
    const total = weights.reduce((s, w) => s + w, 0);
    let roll = nextRoll() * total;
    for (let i = 0; i < catalog.length; i += 1) {
      roll -= weights[i];
      if (roll < 0) {
        if (!picks.some((p) => p.key === catalog[i].key)) picks.push(catalog[i]);
        break;
      }
    }
  }
  return picks;
}

/** 生成人格特点：主特点来自 Background 倾向 + 次特点随机（官方池）。 */
function rollPersonalityTraits(background, rng = null) {
  let seed = rng === null ? null : Number(rng) % 1;
  const nextRoll = () => {
    if (seed === null) return crypto.randomInt(0, 100000) / 100000;
    seed = (seed + 0.137) % 1;
    return seed;
  };
  const traits = [];
  const primary = BACKGROUND_AFFINITY[background];
  if (primary) traits.push(primary);
  let guard = 0;
  while (traits.length < 2 && guard < 100) {
    guard += 1;
    const t = pick(TRAIT_POOL, nextRoll());
    if (!traits.includes(t)) traits.push(t);
  }
  return traits;
}

/** 人生经历（模板化叙述：仅使用官方世界设定要素，不创造剧情）。 */
function generateLifeExperience(background) {
  return `灾变前是一名${background}。${WORLD_SETTING.era}，凭借这段人生经历在${WORLD_SETTING.world}生存。`;
}

/**
 * 生成 Civilian 身份（Lore Simulation 路径：无 Deck 抽卡）。
 * 玩家进入 DOD 世界 = 成为普通 Civilian（不是英雄）。幂等。
 */
function generateCivilianLore(io, playerId, { rng = null, background = null } = {}) {
  const db = require('@roblox-trpg/database').getDb();
  const existing = dodCivilian.getCivilian(playerId);
  if (existing) return { created: false, reason: 'ALREADY_HAS_IDENTITY', civilian: existing };
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) throw new DodLoreError('PLAYER_NOT_FOUND', '玩家不存在', 404);

  dodCivilian.ensureSeeded();
  let seed = rng === null ? null : Number(rng) % 1;
  const nextRoll = () => {
    if (seed === null) return crypto.randomInt(0, 100000) / 100000;
    seed = (seed + 0.137) % 1;
    return seed;
  };

  const bg = background || pick(dodCivilian.BACKGROUNDS, nextRoll());
  if (!dodCivilian.BACKGROUNDS.includes(bg)) throw new DodLoreError('BAD_BACKGROUND', `背景必须是：${dodCivilian.BACKGROUNDS.join('/')}`, 400);
  const personalityTraits = rollPersonalityTraits(bg, nextRoll());
  // 阶段19：背景关联只提高概率（+权重），不锁定 —— 任何背景仍可能获得任何 Ability
  const abilities = rollAbilitiesByTraits(personalityTraits, 2, nextRoll(), bg);
  const lifeExperience = generateLifeExperience(bg);

  db.prepare(
    `INSERT INTO civilian_instance (player_id, background, traits, abilities, synergy_state, source, life_experience, personality_traits)
     VALUES (?, ?, ?, ?, 'NONE', ?, ?, ?)`
  ).run(
    playerId,
    bg,
    JSON.stringify(personalityTraits),
    JSON.stringify(abilities.map((a) => a.key)),
    dodCivilian.SOURCE,
    lifeExperience,
    JSON.stringify(personalityTraits)
  );

  const characterService = require('../character/characterService');
  const dungeon = dodCivilian.ensureSeeded();
  const grants = [];
  for (const a of abilities) {
    const skill = db.prepare("SELECT * FROM skills WHERE name = ? AND status = 'approved'").get(a.key);
    if (!skill) throw new DodLoreError('ABILITY_NOT_FOUND', `Ability ${a.key} 未登记`, 500);
    grants.push({ ability: a.key, ...characterService.grantSkill(playerId, skill.id, { sourceType: dodCivilian.SOURCE, sourceId: 'lore_sim', obtainedFromDungeonId: dungeon.id }) });
  }

  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, player.room_id, {
    type: 'CIVILIAN_CREATED',
    actor: player.name,
    actorPlayerId: playerId,
    data: { background: bg, personalityTraits, abilities: abilities.map((a) => a.key), via: 'lore_simulation', source: dodCivilian.SOURCE },
  });

  const synergy = dodCivilian.checkSynergy(io, playerId);
  return { created: true, civilian: dodCivilian.getCivilian(playerId), grants, synergy };
}

/**
 * NPC 生成规则：NPC 也使用 Civilian 规则（不创建固定英雄，除非 Lore 明确存在）。
 * 返回模板（不持久化、无名字）——由 GM 在叙事中按需使用。
 */
function rollCivilianNpcTemplate(rng = null) {
  let seed = rng === null ? null : Number(rng) % 1;
  const nextRoll = () => {
    if (seed === null) return crypto.randomInt(0, 100000) / 100000;
    seed = (seed + 0.137) % 1;
    return seed;
  };
  const background = pick(dodCivilian.BACKGROUNDS, nextRoll());
  const traits = rollPersonalityTraits(background, nextRoll());
  const abilities = rollAbilitiesByTraits(traits, 2, nextRoll(), background);
  return {
    background,
    traits,
    abilities: abilities.map((a) => a.key),
    note: 'Civilian 规则模板：普通居民，无固定身份/名字（不是英雄）。',
  };
}

/** Ability 在当前世界的解释（DOD = 专业生存能力；其他世界 = 原本的人生经验）。 */
function interpretAbility(abilityKey, experienceName = null) {
  const table = ABILITY_INTERPRETATIONS[abilityKey];
  if (!table) return null;
  const isDod = experienceName && String(experienceName).toLowerCase() === dodCivilian.DOD_EXPERIENCE.toLowerCase();
  return isDod ? table.dod : table.default;
}

/** Lore 视图（GM Context / UI 共用；含跨世界解释 + 阶段19 Ability Lore 解释）。 */
function loreView(playerId, experienceName = null) {
  const db = require('@roblox-trpg/database').getDb();
  const abilityLore = require('./dodAbilityLore');
  const civ = dodCivilian.getCivilian(playerId);
  if (!civ) return null;
  const parse = (s, fb) => {
    try {
      return JSON.parse(s || '') || fb;
    } catch {
      return fb;
    }
  };
  return {
    playerId,
    background: civ.background,
    lifeExperience: civ.life_experience,
    personalityTraits: parse(civ.personality_traits && civ.personality_traits !== '[]' ? civ.personality_traits : civ.traits, []),
    abilities: parse(civ.abilities, []).map((key) => {
      const lore = abilityLore.getAbilityLore(key);
      return {
        key,
        interpretation: interpretAbility(key, experienceName),
        effectiveMultiplier: dodCivilian.dodAbilityMultiplier(experienceName),
        // 阶段19：为什么拥有这个 Ability（人生经历解释，非魔法/技能描述）
        category: lore ? lore.category : null,
        coreTrait: lore ? lore.core_trait : null,
        explainingTraits: lore ? lore.explaining_traits : [],
        linkedBackgrounds: lore ? lore.possible_background : [],
        backgroundLinked: lore ? lore.possible_background.includes(civ.background) : false,
        loreExplanation: abilityLore.abilityLoreExplanation(key, civ.background),
      };
    }),
    synergyState: civ.synergy_state,
    source: civ.source,
    world: WORLD_SETTING,
    abilityExplanationRule: abilityLore.ABILITY_EXPLANATION_RULE,
    note: '普通居民/幸存者/拥有特殊经验的人（禁止描述为超级英雄/救世主/传奇战士）。',
  };
}

module.exports = {
  DodLoreError,
  WORLD_SETTING,
  TRAIT_POOL,
  TRAIT_ABILITY_AFFINITY,
  BACKGROUND_AFFINITY,
  ABILITY_INTERPRETATIONS,
  FUTURE_HOOKS,
  abilityWeight,
  rollAbilitiesByTraits,
  rollPersonalityTraits,
  generateLifeExperience,
  generateCivilianLore,
  rollCivilianNpcTemplate,
  interpretAbility,
  loreView,
};
