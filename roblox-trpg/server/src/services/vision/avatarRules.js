/**
 * Avatar Rules Engine（服务器权威）：标签白名单 / 属性规则 / 技能映射 / 限额。
 * Vision 只能"观察"（输出候选），这里"决定"（验证+计算+限额）。
 * Vision 永远不能修改本文件的规则。
 */

// ── 常量 ──
const ATTRIBUTES = ['STR', 'DEX', 'CON', 'PER', 'INT', 'LUK'];
const BASE_ATTRIBUTE = 5;
const MIN_ATTRIBUTE = 1;
const MAX_ATTRIBUTE = 10;
const MAX_INITIAL_ATTRIBUTE_BONUS = 6;   // 单次 Avatar 最多产生的总加成
const MAX_INITIAL_SKILLS = 2;            // 初始技能上限
const MIN_TAG_CONFIDENCE = 0.7;          // 低置信度拒绝

// ── 允许的 Avatar 标签（Vision 只能从中选择）──
const ALLOWED_AVATAR_TAGS = [
  'heavy_armor', 'light_armor', 'shield', 'sword', 'greatsword', 'bow',
  'fire', 'ice', 'water', 'electric', 'magic', 'wings',
  'ninja', 'warrior', 'pirate', 'robot', 'mechanical', 'technology',
  'stealth', 'military', 'royal', 'scientist', 'animal',
];

// ── 标签 → 属性修正（服务器规则）──
const AVATAR_ATTRIBUTE_RULES = {
  heavy_armor: { STR: 2, CON: 2, DEX: -1 },
  light_armor: { DEX: 1 },
  shield: { CON: 1 },
  sword: { STR: 1 },
  greatsword: { STR: 2, DEX: -1 },
  bow: { DEX: 1, PER: 1 },
  ninja: { DEX: 2, PER: 1, CON: -1 },
  warrior: { STR: 1, CON: 1 },
  wings: { DEX: 1 },
  robot: { CON: 1, INT: 1 },
  mechanical: { INT: 1 },
  technology: { INT: 1 },
  stealth: { DEX: 1, PER: 1 },
  magic: { INT: 1, PER: 1 },
  scientist: { INT: 2 },
  fire: { STR: 1 },
  ice: { CON: 1 },
  water: { PER: 1 },
  electric: { DEX: 1 },
  pirate: { STR: 1, PER: 1 },
  military: { STR: 1, CON: 1 },
  royal: { INT: 1, PER: 1 },
  animal: { DEX: 1, PER: 1 },
};

// ── 标签 → 初始技能（候选，最终必须在 skills 表 approved 且限 2 个）──
const AVATAR_SKILL_RULES = {
  fire: 'fire_affinity',
  ice: 'ice_affinity',
  electric: 'electric_affinity',
  water: 'water_affinity',
  heavy_armor: 'heavy_combat',
  greatsword: 'heavy_combat',
  ninja: 'ninja_mobility',
  stealth: 'ninja_mobility',
  wings: 'aerial_adaptation',
  mechanical: 'mechanical_affinity',
  robot: 'mechanical_affinity',
  technology: 'mechanical_affinity',
  pirate: 'pirate_instinct',
  magic: 'magic_affinity',
  bow: 'marksman',
  royal: 'royal_command',
  animal: 'beast_sense',
  military: 'military_drill',
  warrior: 'heavy_combat',
  scientist: 'mechanical_affinity',
};

/** Bacon Head 默认：全 5，无技能。 */
function baconDefaults() {
  const attributes = {};
  for (const a of ATTRIBUTES) attributes[a] = BASE_ATTRIBUTE;
  return { attributes, skillKeys: [] };
}

/**
 * 由已接受标签计算最终属性：
 * base + 规则修正，总正加成不超过 MAX_INITIAL_ATTRIBUTE_BONUS，最后 Clamp 1~10。
 */
function computeAttributes(acceptedTags) {
  const attributes = baconDefaults().attributes;
  let usedBonus = 0;
  for (const tag of acceptedTags) {
    const mods = AVATAR_ATTRIBUTE_RULES[tag];
    if (!mods) continue;
    for (const [attr, delta] of Object.entries(mods)) {
      if (delta > 0 && usedBonus >= MAX_INITIAL_ATTRIBUTE_BONUS) continue; // 正加成额度用尽
      attributes[attr] += delta;
      if (delta > 0) usedBonus += delta;
    }
  }
  for (const a of ATTRIBUTES) {
    attributes[a] = Math.max(MIN_ATTRIBUTE, Math.min(MAX_ATTRIBUTE, attributes[a]));
  }
  return attributes;
}

/** 由已接受标签导出候选技能 key（保序、去重）。 */
function candidateSkillKeys(acceptedTags) {
  const keys = [];
  for (const tag of acceptedTags) {
    const key = AVATAR_SKILL_RULES[tag];
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** 技能中文名（展示用）。 */
const SKILL_DISPLAY = {
  fire_affinity: '火焰亲和',
  ice_affinity: '寒冰亲和',
  electric_affinity: '雷电亲和',
  water_affinity: '流水亲和',
  heavy_combat: '重装战斗',
  ninja_mobility: '忍者身法',
  aerial_adaptation: '空中适应',
  mechanical_affinity: '机械亲和',
  pirate_instinct: '海盗直觉',
  magic_affinity: '魔法亲和',
  marksman: '神射手',
  royal_command: '王室威仪',
  beast_sense: '野兽感知',
  military_drill: '军事训练',
};

module.exports = {
  ATTRIBUTES,
  BASE_ATTRIBUTE,
  MIN_ATTRIBUTE,
  MAX_ATTRIBUTE,
  MAX_INITIAL_ATTRIBUTE_BONUS,
  MAX_INITIAL_SKILLS,
  MIN_TAG_CONFIDENCE,
  ALLOWED_AVATAR_TAGS,
  AVATAR_ATTRIBUTE_RULES,
  AVATAR_SKILL_RULES,
  SKILL_DISPLAY,
  baconDefaults,
  computeAttributes,
  candidateSkillKeys,
};
