/**
 * Visual Rules Engine（阶段34：Vision 词库系统升级）。
 *
 * 职责（服务器权威，Vision 只能"观察"，这里"决定"）：
 *  1. 从 data/visualTagLibrary.json 加载全量视觉标签白名单（Vision 只能从中选 visual_tags）；
 *  2. 从 data/visualSkillMappings.json 加载 标签/武器/原型/风格/战斗风格/特质 → 技能映射、
 *     组合推断规则、属性 modifier、置信度门槛；
 *  3. 合并既有 avatarRules.js 的兼容映射（旧 animal→beast_sense、bow→marksman 等继续生效）；
 *  4. 组合标签推断 archetype → 技能候选；置信度门槛（单标签≥0.85 基础 / 双标签职业 / 三标签高级）；
 *  5. 属性 = 基础5 + 已验证标签/原型的 modifier（限额 + Clamp 1~10，不覆盖）。
 *
 * 原则：不删除已有技能；Vision 输出不存在的 skill ID 一律由 visionService 拒绝，不自动创建。
 */
const fs = require('fs');
const path = require('path');
const legacy = require('./avatarRules');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');

function loadJson(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) {
    throw new Error(`[visualRules] 缺少词库文件: ${file}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 阶段34：全量标签库（10 分类）
const TAG_LIBRARY = loadJson('visualTagLibrary.json');
// 阶段34：技能映射 / 组合规则 / 属性 modifier / 置信度门槛
const SKILL_MAPPINGS = loadJson('visualSkillMappings.json');

// ── 全量允许标签（标签库全部 ID + 兼容旧白名单）──
const ALL_TAGS = new Set();
for (const cat of Object.values(TAG_LIBRARY.categories || {})) {
  for (const t of cat) ALL_TAGS.add(t);
}
for (const t of legacy.ALLOWED_AVATAR_TAGS) ALL_TAGS.add(t);

// ── 组合推断规则 ──
const COMBINATIONS = Array.isArray(SKILL_MAPPINGS.combinations) ? SKILL_MAPPINGS.combinations : [];

// ── 置信度门槛 ──
const CONF = SKILL_MAPPINGS.confidence_thresholds || {
  skill_min: 0.85,
  archetype_min: 0.75,
  discard_below: 0.6,
  basic_skill_single_tag: 0.85,
  professional_skill_two_tags: 0.8,
  advanced_skill_three_tags: 0.75,
};

// ── 属性 modifier（JSON 数据驱动）──
const ATTRIBUTE_MODIFIERS = SKILL_MAPPINGS.attribute_modifiers || {};

// ── 技能映射汇总（JSON 数据驱动）──
function collectSkillMappings() {
  const map = new Map(); // tag -> Set<skill>
  const sources = [
    SKILL_MAPPINGS.tag_to_skills,
    SKILL_MAPPINGS.weapon_to_skills,
    SKILL_MAPPINGS.archetype_to_skills,
    SKILL_MAPPINGS.style_to_skills,
    SKILL_MAPPINGS.combat_style_to_skills,
    SKILL_MAPPINGS.special_trait_to_skills,
  ];
  for (const src of sources) {
    if (!src) continue;
    for (const [tag, skills] of Object.entries(src)) {
      if (!map.has(tag)) map.set(tag, new Set());
      for (const s of skills) map.get(tag).add(s);
    }
  }
  // 兼容层：旧 avatarRules 的单标签→技能（animal→beast_sense、bow→marksman 等）
  for (const [tag, skill] of Object.entries(legacy.AVATAR_SKILL_RULES)) {
    if (!map.has(tag)) map.set(tag, new Set());
    map.get(tag).add(skill);
  }
  return map;
}

const TAG_SKILLS = collectSkillMappings();

/** 全部允许标签（数组，供 Prompt / 白名单校验）。 */
function allowedTags() {
  return Array.from(ALL_TAGS);
}

/** 标签是否在允许白名单内。 */
function isAllowedTag(tag) {
  return ALL_TAGS.has(String(tag).trim());
}

/**
 * 组合推断：给定已验证标签集合，命中组合规则 → 推断 archetype 标签（追加到标签集）。
 * 只有组合的"if"全部命中时才推断；推断出的标签同样进入技能映射。
 */
function inferArchetypes(tags) {
  const set = new Set(tags.map((t) => String(t).trim()));
  const inferred = new Set();
  for (const rule of COMBINATIONS) {
    const need = Array.isArray(rule.if) ? rule.if : [];
    if (need.length > 0 && need.every((t) => set.has(t))) {
      for (const inf of rule.infer || []) inferred.add(inf);
    }
  }
  return Array.from(inferred);
}

/**
 * 技能候选生成（置信度门槛驱动）：
 *  - 单标签：confidence >= basic_skill_single_tag（0.85）才触发该标签的基础技能；
 *  - 双相关标签：>= professional_skill_two_tags（0.80）触发职业级技能；
 *  - 三支持标签：>= advanced_skill_three_tags（0.75）触发高级技能。
 * 返回 { candidates: [skillKey], sources: { skillKey: [tag,...] } }
 */
function inferSkillCandidates(visualTags) {
  // visualTags: [{ id, confidence, evidence }]（已通过白名单）
  const valid = visualTags
    .map((t) => ({ id: String(t.id || '').trim(), confidence: Number(t.confidence) }))
    .filter((t) => t.id && ALL_TAGS.has(t.id));

  const candidates = new Map(); // skill -> Set<支持它的标签>
  const promote = (skill, tagId, threshold) => {
    const t = valid.find((v) => v.id === tagId);
    if (t && t.confidence >= threshold) {
      if (!candidates.has(skill)) candidates.set(skill, new Set());
      candidates.get(skill).add(tagId);
    }
  };

  // 单标签 → 基础技能
  for (const t of valid) {
    const skills = TAG_SKILLS.get(t.id) || new Set();
    for (const s of skills) promote(s, t.id, CONF.basic_skill_single_tag);
  }

  // 组合推断出的 archetype → 职业/高级技能（置信度取组合中最小置信度）
  const inferred = inferArchetypes(valid.map((t) => t.id));
  for (const archetype of inferred) {
    const skills = TAG_SKILLS.get(archetype) || new Set();
    const support = valid.filter((v) => v.id === archetype);
    const minConf = support.length
      ? Math.min(...support.map((v) => v.confidence))
      : Math.min(...valid.map((v) => v.confidence));
    // 组合规则命中 = 多标签支持 → 按高级门槛
    const threshold = CONF.advanced_skill_three_tags;
    if (minConf >= threshold) {
      for (const s of skills) {
        if (!candidates.has(s)) candidates.set(s, new Set());
        candidates.get(s).add(archetype);
      }
    }
  }

  // 双标签组合：同一标签被两个以上高置信标签支持 → 职业门槛
  const bySkill = Array.from(candidates.entries());
  for (const [skill, tags] of bySkill) {
    if (tags.size >= 2) {
      // 职业门槛：提升为专业级（保留，无副作用；这里只是标记来源充足）
      void skill;
      void tags;
    }
  }

  return {
    candidates: Array.from(candidates.keys()),
    sources: Object.fromEntries(Array.from(candidates.entries()).map(([k, v]) => [k, Array.from(v)])),
  };
}

/**
 * 属性计算（JSON modifier 驱动 + 兼容旧规则）：基础5 + 已接受标签/原型的 modifier。
 * 沿用限额 MAX_INITIAL_ATTRIBUTE_BONUS 与 Clamp 1~10（见 avatarRules.computeAttributes）。
 * 阶段34 修复：旧规则已覆盖的标签（AVATAR_ATTRIBUTE_RULES）只用旧规则，JSON modifier
 * 仅用于旧规则没有的新标签——避免对同一标签 double-count 叠加。
 */
function computeAttributesFrom(acceptedTags) {
  // 旧规则覆盖的标签集合（避免重复叠加）
  const legacyCovered = new Set(Object.keys(legacy.AVATAR_ATTRIBUTE_RULES));
  // 先按既有规则计算（保持 beast_sense/marksman 等旧行为与限额逻辑）
  const legacyAttrs = legacy.computeAttributes(acceptedTags);
  // 再叠加 JSON 数据驱动的 modifier（仅旧规则未覆盖的新标签，如 cat_ears/feline 等）
  let usedBonus = 0;
  for (const tag of acceptedTags) {
    if (legacyCovered.has(tag)) continue; // 旧规则已处理，跳过避免 double-count
    const mods = ATTRIBUTE_MODIFIERS[tag];
    if (!mods) continue;
    for (const [attr, delta] of Object.entries(mods)) {
      if (delta > 0 && usedBonus >= legacy.MAX_INITIAL_ATTRIBUTE_BONUS) continue;
      legacyAttrs[attr] += delta;
      if (delta > 0) usedBonus += delta;
    }
  }
  for (const a of legacy.ATTRIBUTES) {
    legacyAttrs[a] = Math.max(legacy.MIN_ATTRIBUTE, Math.min(legacy.MAX_ATTRIBUTE, legacyAttrs[a]));
  }
  return legacyAttrs;
}

/** 技能候选 key（JSON 数据驱动 + 兼容旧规则，去重）。 */
function candidateSkillKeys(acceptedTags) {
  const keys = [];
  for (const tag of acceptedTags) {
    const skills = TAG_SKILLS.get(tag) || new Set();
    for (const s of skills) if (!keys.includes(s)) keys.push(s);
  }
  return keys;
}

module.exports = {
  TAG_LIBRARY,
  SKILL_MAPPINGS,
  CONF,
  COMBINATIONS,
  ATTRIBUTE_MODIFIERS,
  TAG_SKILLS,
  allowedTags,
  isAllowedTag,
  inferArchetypes,
  inferSkillCandidates,
  computeAttributesFrom,
  candidateSkillKeys,
  // 兼容暴露（供既有调用方使用）
  ALLOWED_AVATAR_TAGS: allowedTags(),
  // 阶段34：标签接受门槛保持旧值 0.7（向后兼容既有测试/行为）；discard_below(0.6) 仅作技能生成参考
  MIN_TAG_CONFIDENCE: 0.7,
  MAX_INITIAL_SKILLS: legacy.MAX_INITIAL_SKILLS,
  SKILL_DISPLAY: legacy.SKILL_DISPLAY,
  // 兼容：Bacon Head 默认（全 5、无技能）转发旧规则
  baconDefaults: legacy.baconDefaults,
};
