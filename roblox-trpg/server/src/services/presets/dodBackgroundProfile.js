/**
 * Die of Death 阶段20：Civilian Background & Personality Simulation。
 *
 * 目标：让 AI GM 能根据 Civilian 的 Ability 推断这个人的人生背景。
 *
 * 设定纪律（必须遵守）：
 *  - Background 不是职业：代表 Civilian 过去的人生经历（无职业等级/职业技能树/职业装备）；
 *  - Trait 不是技能：表示人格、经历、知识（绝不入 skills 表、不产生数值）；
 *  - Personality（Brave/Careful/…）只影响 GM 叙事、NPC 互动、剧情选择——绝不改变属性数值；
 *  - Ability 解释纪律：GM 不能说"你获得了X技能"，应说"你过去接受过X训练/经历，因此你知道如何…"；
 *  - 一个 Ability 可来自多种人生（如 Caretaker：护士/医生/志愿者/照顾家人）——禁止 1 Ability = 1 职业；
 *    Ability → Background 只是概率与推断，不是绑定；
 *  - 不生成英雄身份：Background 池仍是官方 6 项，人格池全部是普通人特质。
 */
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'DIE_OF_DEATH';

/** 人格池（官方输入）：普通人特质，无英雄化词汇。 */
const PERSONALITY_POOL = ['Brave', 'Careful', 'Selfless', 'Practical', 'Creative', 'Nervous'];

/** GM 用语总规则（写入 AI Context / SYSTEM_RULES 同步）。 */
const GM_PHRASING_RULE =
  'GM 不能说"你获得了X技能"；应说"你过去接受过X训练/经历过X，因此你知道如何…"（Ability = 人生经历，不是技能发放）。';

// ── Background 档案（阶段20 设定输入；Artist 补全官方 6 背景池）──
const BACKGROUND_PROFILES = [
  {
    id: 'engineer',
    background_type: 'Engineer',
    description: '拥有机械、建筑或者创造经验的人。',
    possible_traits: ['Engineering Knowledge', 'Problem Solving', 'Construction Experience'],
    possible_abilities: ['BonusPad', 'Block'],
    personality_patterns: ['Practical', 'Creative', 'Careful'],
    survival_lore: '这个Civilian过去靠双手和头脑解决问题，在Killers出现后，他的工程经验成为生存优势。',
  },
  {
    id: 'medic',
    background_type: 'Medic',
    // 官方要求：Caretaker 可来自 护士/医生/志愿者/照顾家人 —— 多种人生，不是一种职业
    description: '拥有医疗、护理或者帮助他人经验的人（可能是护士、医生、志愿者，或曾长期照顾家人）。',
    possible_traits: ['Medical Knowledge', 'Empathy', 'First Aid'],
    possible_abilities: ['Caretaker'],
    personality_patterns: ['Selfless', 'Careful', 'Brave'],
    survival_lore: '这个Civilian过去负责帮助伤员，在Killers出现后，他的经验成为生存优势。',
  },
  {
    id: 'athlete',
    background_type: 'Athlete',
    description: '长期进行体育训练的人。',
    possible_traits: ['Physical Training', 'Endurance', 'Fast Reaction'],
    possible_abilities: ['Punch', 'Dash', 'Adrenaline'],
    personality_patterns: ['Brave', 'Practical', 'Nervous'],
    survival_lore: '这个Civilian过去长期进行体育训练，在Killers出现后，他的身体素质成为生存优势。',
  },
  {
    id: 'security',
    background_type: 'Security',
    description: '接触安全、防卫或者危险环境的人。',
    possible_traits: ['Weapon Familiarity', 'Awareness', 'Defense Training'],
    possible_abilities: ['Revolver', 'Block'],
    personality_patterns: ['Brave', 'Careful', 'Practical'],
    survival_lore: '这个Civilian过去在危险环境中工作，在Killers出现后，他的警觉与训练成为生存优势。',
  },
  {
    id: 'cook',
    background_type: 'Cook',
    description: '拥有料理经验的人。',
    possible_traits: ['Cooking', 'Food Knowledge'],
    possible_abilities: ['Hotdog', 'Pie'],
    personality_patterns: ['Practical', 'Creative', 'Selfless'],
    survival_lore: '这个Civilian过去以料理喂养身边的人，在Killers出现后，他的厨艺成为生存优势。',
  },
  {
    id: 'artist',
    background_type: 'Artist',
    description: '拥有艺术创作与观察生活经验的人。',
    possible_traits: ['Creative Expression', 'Observation'],
    possible_abilities: ['Banana Peel', 'Bugle'], // 官方 Library：表演/戏剧背景
    personality_patterns: ['Creative', 'Nervous'],
    survival_lore: '这个Civilian过去以创作和观察生活为乐，在Killers出现后，他的观察力成为生存优势。',
  },
];

/** Ability 的 GM 第二人称解释（"你过去…因此你知道…"；禁止"获得技能"句式）。 */
const ABILITY_GM_PHRASING = {
  Punch: '你长期锻炼身体、也经历过街头冲突，因此你有底气挥拳自保',
  Caretaker: '你过去接受过医疗训练，因此你知道如何处理伤员',
  Revolver: '你过去接受过枪械训练，因此你知道如何安全而冷静地用枪',
  Hotdog: '你习惯亲手准备食物，因此你能用一顿热食恢复自己和同伴的元气',
  Pie: '你有烘焙与料理的经验，因此你能做出让人安心的食物',
  BonusPad: '你有工程与动手的经验，因此你能搭建临时辅助设施',
  Dash: '你常年奔跑移动，因此你能在危险逼近时迅速脱身',
  Block: '你接受过防护与体能训练，因此你能挡在危险面前保护他人',
  Flashlight: '你常年在户外徒步探索，因此你熟悉黑暗、懂得引路',
  Adrenaline: '你早已习惯受惊即逃的生活，因此你在危急时刻能爆发出逃命的速度',
  'Banana Peel': '你是个爱开玩笑的捣蛋鬼，因此你总有办法让追捕者摔个跟头',
  Cloak: '你了解那件实验科技斗篷，因此你能隐匿自己的行踪',
  Taunt: '你擅长吸引众人注意，因此你能把威胁从同伴身上引开',
  Bugle: '你会吹奏号角，因此你能在恐惧中鼓舞身边的人',
};

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

function rowToProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    background_type: row.background_type,
    description: row.description,
    possible_traits: parseJson(row.possible_traits, []),
    possible_abilities: parseJson(row.possible_abilities, []),
    personality_patterns: parseJson(row.personality_patterns, []),
    source: row.source,
  };
}

/** 幂等播种 civilian_background_profiles（按 id 覆盖更新）。 */
function ensureBackgroundProfilesSeeded() {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO civilian_background_profiles
       (id, background_type, description, possible_traits, possible_abilities, personality_patterns, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       background_type = excluded.background_type, description = excluded.description,
       possible_traits = excluded.possible_traits, possible_abilities = excluded.possible_abilities,
       personality_patterns = excluded.personality_patterns, source = excluded.source`
  );
  for (const p of BACKGROUND_PROFILES) {
    ins.run(
      p.id,
      p.background_type,
      p.description,
      JSON.stringify(p.possible_traits),
      JSON.stringify(p.possible_abilities),
      JSON.stringify(p.personality_patterns),
      SOURCE
    );
  }
  return BACKGROUND_PROFILES.length;
}

function getProfile(backgroundType) {
  if (!backgroundType) return null;
  ensureBackgroundProfilesSeeded();
  const row = getDb()
    .prepare('SELECT * FROM civilian_background_profiles WHERE background_type = ? OR id = ?')
    .get(backgroundType, String(backgroundType).toLowerCase());
  return rowToProfile(row);
}

function listProfiles() {
  ensureBackgroundProfilesSeeded();
  return getDb().prepare('SELECT * FROM civilian_background_profiles ORDER BY id').all().map(rowToProfile);
}

/** 全部档案 Trait 并集（多样性来源：任何居民都可能出现任何经历特点）。 */
function allProfileTraits() {
  return [...new Set(listProfiles().flatMap((p) => p.possible_traits))];
}

/** 档案内部结构（survival_lore 不入库，仅服务层使用）。 */
function survivalLore(backgroundType) {
  const p = BACKGROUND_PROFILES.find((x) => x.background_type === backgroundType);
  return p ? p.survival_lore : null;
}

function pick(arr, roll) {
  return arr[Math.floor(roll * arr.length) % arr.length];
}

/**
 * 背景特点生成（Trait 不是技能：人格/经历/知识）。
 * 主特点来自该背景档案；次特点从全档案并集随机（任何居民都可能有任何经历）。
 */
function rollProfileTraits(backgroundType, rng = null) {
  const crypto = require('crypto');
  let seed = rng === null ? null : Number(rng) % 1;
  const nextRoll = () => {
    if (seed === null) return crypto.randomInt(0, 100000) / 100000;
    seed = (seed + 0.137) % 1;
    return seed;
  };
  const profile = getProfile(backgroundType);
  const traits = [];
  if (profile && profile.possible_traits.length) traits.push(pick(profile.possible_traits, nextRoll()));
  const union = allProfileTraits();
  let guard = 0;
  while (traits.length < 2 && guard < 50) {
    guard += 1;
    const t = pick(union, nextRoll());
    if (!traits.includes(t)) traits.push(t);
  }
  return traits;
}

/**
 * 人格生成：主人格来自背景档案的常见倾向；次人格从官方人格池随机。
 * 人格只影响 GM 叙事 / NPC 互动 / 剧情选择，不改变任何数值。
 */
function rollPersonality(backgroundType, rng = null) {
  const crypto = require('crypto');
  let seed = rng === null ? null : Number(rng) % 1;
  const nextRoll = () => {
    if (seed === null) return crypto.randomInt(0, 100000) / 100000;
    seed = (seed + 0.137) % 1;
    return seed;
  };
  const profile = getProfile(backgroundType);
  const traits = [];
  if (profile && profile.personality_patterns.length) traits.push(pick(profile.personality_patterns, nextRoll()));
  let guard = 0;
  while (traits.length < 2 && guard < 50) {
    guard += 1;
    const t = pick(PERSONALITY_POOL, nextRoll());
    if (!traits.includes(t)) traits.push(t);
  }
  return traits;
}

/**
 * Ability → Background 推断（供 GM 理解"这个人可能的人生"）。
 * 计分：Ability Lore 关联背景 +2/项；档案 possible_abilities 命中 +1/项。
 * 返回排序候选 —— 只是推断，不构成职业绑定（同一能力可来自多种人生）。
 */
function inferBackgroundFromAbilities(abilityKeys) {
  const abilityLore = require('./dodAbilityLore');
  const keys = Array.isArray(abilityKeys) ? abilityKeys : [];
  const candidates = listProfiles()
    .map((p) => {
      let score = 0;
      const matched = [];
      for (const key of keys) {
        const lore = abilityLore.getAbilityLore(key);
        const linked = lore && lore.possible_background.includes(p.background_type);
        const inProfile = p.possible_abilities.includes(key);
        if (linked) {
          score += 2;
          matched.push(key);
        } else if (inProfile) {
          score += 1;
          matched.push(key);
        }
      }
      return { background: p.background_type, score, matchedAbilities: matched };
    })
    .sort((a, b) => b.score - a.score || a.background.localeCompare(b.background));
  const top = candidates.length && candidates[0].score > 0 ? candidates[0].background : null;
  return {
    top,
    candidates,
    note: '推断仅供参考：Ability 反映人生经历而不是职业；同一能力可来自多种人生（如 Caretaker 可来自护士/医生/志愿者/照顾家人），不构成职业绑定。',
  };
}

/** Ability 的 GM 第二人称解释。 */
function gmAbilityPhrasing(abilityKey) {
  return ABILITY_GM_PHRASING[abilityKey] || null;
}

module.exports = {
  SOURCE,
  PERSONALITY_POOL,
  GM_PHRASING_RULE,
  BACKGROUND_PROFILES,
  ABILITY_GM_PHRASING,
  ensureBackgroundProfilesSeeded,
  getProfile,
  listProfiles,
  allProfileTraits,
  survivalLore,
  rollProfileTraits,
  rollPersonality,
  inferBackgroundFromAbilities,
  gmAbilityPhrasing,
};
