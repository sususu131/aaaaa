/**
 * Die of Death 阶段19：Civilian Ability Lore Integration。
 *
 * 目标：让 AI GM 理解 DOD 世界中 Civilian【为什么】拥有这些 Ability。
 *
 * 设定纪律（必须遵守）：
 *  - Ability 不是魔法：Ability 代表 Civilian 过去的人生经历（格斗训练/医疗知识/枪械训练/工程经验……）；
 *    解释“为什么拥有”，绝不解释为“获得技能/魔法/超能力/凭空召唤”。
 *  - Lore 数据 ≠ 游戏技能系统：本模块不存任何战斗数值字段（无 Cooldown/Damage/HP/SP）、
 *    不做技能数值、不做技能 UI —— 只是 Lore 解释数据。
 *  - Background 只提高概率（权重），不是固定绑定：任何 Civilian 都可能获得任何 Ability（无职业锁定）。
 *  - Trait 解释：每个 Ability 的出现由 Trait 解释（如 Caretaker ← Medical Knowledge/Empathy/First Aid Experience）。
 *  - Synergy 只保存候选（synergy_candidates / possible_synergy），本阶段不实现任何 Synergy 逻辑。
 *  - 内容来自阶段19 设定输入 + 既有官方设定，不创造原创世界观。
 */
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'DIE_OF_DEATH';

/** Ability 解释总规则（写入 AI Context / 预设）。 */
const ABILITY_EXPLANATION_RULE =
  'Ability 不是魔法，代表 Civilian 过去的人生经历：解释“为什么拥有这种能力”（医疗知识/枪械训练/工程经验/身体训练等），而不是描述技能效果或数值。';

/** 关联背景的权重加成（只是概率提高，非锁定；其余背景保持基础权重 1）。 */
const LINKED_BACKGROUND_WEIGHT = 3;
const BASE_ABILITY_WEIGHT = 1;

// ── Ability Lore 目录（阶段19 设定输入）──
// 字段与 dod_abilities_lore 表一致；synergy 条目仅为结果登记（不实现逻辑）。
const ABILITY_LORE_ENTRIES = [
  {
    id: 'punch',
    name: 'Punch',
    source: SOURCE,
    category: 'physical',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training'],
    possible_background: ['Athlete'],
    lore_description:
      '该Civilian拥有优秀身体素质，可能来自格斗训练、体育经历或长期锻炼；危急时刻凭身体本能保护自己与他人。',
    personality_connection: '自律、坚韧、直接面对问题；长期锻炼养成了遇事不逃的行动习惯。',
    synergy_candidates: [],
    synergy_result_of: [],
  },
  {
    id: 'caretaker',
    name: 'Caretaker',
    source: SOURCE,
    category: 'medical',
    core_trait: 'Medical Knowledge',
    explaining_traits: ['Medical Knowledge', 'Empathy', 'First Aid Experience'],
    possible_background: ['Medic'],
    lore_description:
      '该Civilian拥有医疗知识与照顾他人的经验；能包扎伤口、判断伤情、在混乱中照护同伴。',
    personality_connection: '关怀、冷静、把同伴的安危放在心上；同理心是其行动的驱动力。',
    synergy_candidates: [],
    synergy_result_of: [],
  },
  {
    id: 'revolver',
    name: 'Revolver',
    source: SOURCE,
    category: 'firearms',
    core_trait: 'Weapon Familiarity',
    explaining_traits: ['Weapon Familiarity', 'Marksmanship', 'Firearms Training'],
    possible_background: ['Security'],
    lore_description:
      '该Civilian拥有枪械训练、射击经验或安全职业背景；懂得安全用枪，面对威胁时保持职业冷静。',
    personality_connection: '警惕、负责、习惯守护身边人的安全；对危险有职业敏感。',
    synergy_candidates: [{ with: 'Caretaker', result: 'Loveshot' }],
    synergy_result_of: [],
  },
  {
    id: 'hotdog',
    name: 'Hotdog',
    source: SOURCE,
    category: 'culinary',
    core_trait: 'Cooking Skill',
    explaining_traits: ['Cooking Skill', 'Special Habit'],
    possible_background: ['Cook'],
    lore_description:
      '该Civilian拥有烹饪经验与特殊习惯；亲手准备食物既是个人习惯，也是安抚同伴的生存智慧。',
    personality_connection: '乐观、念旧、习惯用食物维系士气；异常时期仍保持生活气息。',
    synergy_candidates: [],
    synergy_result_of: [],
  },
  {
    id: 'pie',
    name: 'Pie',
    source: SOURCE,
    category: 'culinary',
    core_trait: 'Cooking Skill',
    explaining_traits: ['Cooking Skill'],
    possible_background: ['Cook'],
    lore_description:
      '该Civilian拥有烹饪与准备食物的经验；能把有限食材变成让人安心的食物。',
    personality_connection: '细心、念家、擅长用小手艺维持身边人的士气。',
    synergy_candidates: [],
    synergy_result_of: [],
  },
  {
    id: 'bonuspad',
    name: 'BonusPad',
    source: SOURCE,
    category: 'engineering',
    core_trait: 'Engineering Experience',
    explaining_traits: ['Engineering Experience', 'Support Facility'],
    possible_background: ['Engineer'],
    lore_description:
      '该Civilian拥有工程能力、建筑经验与创造辅助工具的能力；能就地取材搭建临时辅助设施帮助同伴。',
    personality_connection: '务实、爱钻研、遇事先想办法；习惯用双手改善身边人的处境。',
    synergy_candidates: [{ with: 'Caretaker', result: 'CarePad' }],
    synergy_result_of: [],
  },
  {
    id: 'dash',
    name: 'Dash',
    source: SOURCE,
    category: 'mobility',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training'],
    possible_background: ['Athlete'],
    lore_description:
      '该Civilian拥有敏捷的身体与快速移动能力，来自体育训练或长期奔逃的生存经验。',
    personality_connection: '反应快、机敏、习惯先脱离危险再想办法。',
    synergy_candidates: [],
    synergy_result_of: [],
  },
  {
    id: 'block',
    name: 'Block',
    source: SOURCE,
    category: 'defensive',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training', 'Engineering Experience'],
    possible_background: ['Engineer', 'Security'],
    lore_description:
      '该Civilian拥有防护意识与工事经验，来自安全职业训练或工程背景；懂得用身体与结构挡在危险面前。',
    personality_connection: '沉稳、保护欲强、愿意站在危险与同伴之间。',
    synergy_candidates: [],
    synergy_result_of: [],
  },
  // ── Synergy 结果登记（Lore 预留：只解释设定，不实现任何组合逻辑）──
  {
    id: 'carepad',
    name: 'CarePad',
    source: SOURCE,
    category: 'synergy',
    core_trait: 'Medical Knowledge',
    explaining_traits: ['Medical Knowledge', 'Engineering Experience'],
    possible_background: [],
    lore_description:
      '医疗知识与工程能力的组合达到大师级水平：既能照顾他人，又能搭建用于照护的辅助设施。',
    personality_connection: '关怀与动手能力的结合：把照顾他人做到专业水准的普通人。',
    synergy_candidates: [],
    synergy_result_of: ['Caretaker', 'BonusPad'],
  },
  {
    id: 'loveshot',
    name: 'Loveshot',
    source: SOURCE,
    category: 'synergy',
    core_trait: 'Marksmanship',
    explaining_traits: ['Marksmanship', 'Empathy'],
    possible_background: [],
    lore_description:
      '射击经验与关怀之心的组合（预留设定，当前不实现）：用职业本领守护所爱之人。',
    personality_connection: '外冷内热：以精准与温柔并存的普通人。',
    synergy_candidates: [],
    synergy_result_of: ['Revolver', 'Caretaker'],
  },
];

/** Background → 人生经历短语（用于生成 Lore Explanation）。 */
const BACKGROUND_EXPERIENCE = {
  Engineer: '拥有建筑经验',
  Medic: '拥有医疗与照护经验',
  Athlete: '拥有长期体育训练的经历',
  Cook: '拥有烹饪与准备食物的经验',
  Security: '拥有安全职业训练的经历',
  Artist: '拥有艺术创作与观察生活的经历',
};

/** Ability → 能力表现短语（解释“因此能够……”）。 */
const ABILITY_PHRASE = {
  Punch: '能凭借优秀身体素质应对威胁',
  Caretaker: '能照顾与救治身边的人',
  Revolver: '熟悉枪械并懂得安全使用',
  Hotdog: '保留着亲手准备食物的习惯',
  Pie: '能用有限食材做出让人安心的食物',
  BonusPad: '能够制作临时辅助设施',
  Dash: '能快速移动脱离危险',
  Block: '能构筑防护挡住危险',
};

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

function rowToLore(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    category: row.category,
    core_trait: row.core_trait,
    explaining_traits: parseJson(row.explaining_traits, []),
    possible_background: parseJson(row.possible_background, []),
    lore_description: row.lore_description,
    personality_connection: row.personality_connection,
    synergy_candidates: parseJson(row.synergy_candidates, []),
    possible_synergy: parseJson(row.synergy_candidates, []), // 别名（Synergy 预留命名）
    synergy_result_of: parseJson(row.synergy_result_of, []),
  };
}

/** 幂等播种 dod_abilities_lore（内容可随设定输入更新，按 id 覆盖）。 */
function ensureAbilityLoreSeeded() {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO dod_abilities_lore
       (id, name, source, category, core_trait, explaining_traits, possible_background,
        lore_description, personality_connection, synergy_candidates, synergy_result_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, source = excluded.source, category = excluded.category,
       core_trait = excluded.core_trait, explaining_traits = excluded.explaining_traits,
       possible_background = excluded.possible_background, lore_description = excluded.lore_description,
       personality_connection = excluded.personality_connection,
       synergy_candidates = excluded.synergy_candidates, synergy_result_of = excluded.synergy_result_of`
  );
  for (const e of ABILITY_LORE_ENTRIES) {
    ins.run(
      e.id,
      e.name,
      e.source,
      e.category,
      e.core_trait,
      JSON.stringify(e.explaining_traits || []),
      JSON.stringify(e.possible_background || []),
      e.lore_description,
      e.personality_connection,
      JSON.stringify(e.synergy_candidates || []),
      JSON.stringify(e.synergy_result_of || [])
    );
  }
  return ABILITY_LORE_ENTRIES.length;
}

/** 读取单个 Ability Lore（按 name 或 id）。 */
function getAbilityLore(key) {
  if (!key) return null;
  ensureAbilityLoreSeeded();
  const db = getDb();
  const row = db.prepare('SELECT * FROM dod_abilities_lore WHERE name = ? OR id = ?').get(key, String(key).toLowerCase());
  return rowToLore(row);
}

/** 全部 Ability Lore（按 id 排序）。 */
function listAbilityLore() {
  ensureAbilityLoreSeeded();
  return getDb().prepare('SELECT * FROM dod_abilities_lore ORDER BY id').all().map(rowToLore);
}

/**
 * Ability → Background 权重：关联背景 = 3（概率提高），其余 = 1（基础概率，仍可获得）。
 * 不是固定绑定：任何 Background 的权重都 ≥ 1，任何 Civilian 都可能获得任何 Ability。
 */
function backgroundAbilityWeight(abilityKey, background) {
  const lore = getAbilityLore(abilityKey);
  if (!lore) return BASE_ABILITY_WEIGHT;
  if (background && lore.possible_background.includes(background)) return LINKED_BACKGROUND_WEIGHT;
  return BASE_ABILITY_WEIGHT;
}

/** Background → 关联 Ability 列表（权重提高项；来自 Lore 数据，非硬编码）。 */
function linkedAbilities(background) {
  return listAbilityLore()
    .filter((l) => l.category !== 'synergy' && l.possible_background.includes(background))
    .map((l) => l.name);
}

/** Ability → Trait 解释列表（该能力体现的人生特点）。 */
function abilityExplainingTraits(abilityKey) {
  const lore = getAbilityLore(abilityKey);
  return lore ? lore.explaining_traits : [];
}

/** Ability 的 Synergy 候选（只读数据；本阶段不实现任何 Synergy 逻辑）。 */
function synergyCandidates(abilityKey) {
  const lore = getAbilityLore(abilityKey);
  return lore ? lore.synergy_candidates : [];
}

/**
 * 生成 Lore Explanation（AI Context 用）：
 *  - 背景关联 → “该居民过去拥有建筑经验，因此能够制作临时辅助设施。”
 *  - 背景无关联 → 通用经历解释 + 明确无职业锁定（任何背景都可能拥有）。
 */
function abilityLoreExplanation(abilityKey, background = null) {
  const lore = getAbilityLore(abilityKey);
  if (!lore) return null;
  const phrase = ABILITY_PHRASE[abilityKey];
  if (background && lore.possible_background.includes(background)) {
    const bgPhrase = BACKGROUND_EXPERIENCE[background] || '拥有相关人生经历';
    return `该居民过去${bgPhrase}，因此${phrase || '展现出这种能力'}。`;
  }
  if (background) {
    return `${lore.lore_description}（${background}背景与它没有固定绑定：任何背景的居民都可能拥有这种经历。）`;
  }
  return lore.lore_description;
}

module.exports = {
  SOURCE,
  ABILITY_EXPLANATION_RULE,
  LINKED_BACKGROUND_WEIGHT,
  BASE_ABILITY_WEIGHT,
  ABILITY_LORE_ENTRIES,
  BACKGROUND_EXPERIENCE,
  ABILITY_PHRASE,
  ensureAbilityLoreSeeded,
  getAbilityLore,
  listAbilityLore,
  backgroundAbilityWeight,
  linkedAbilities,
  abilityExplainingTraits,
  synergyCandidates,
  abilityLoreExplanation,
};
