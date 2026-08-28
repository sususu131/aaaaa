/**
 * Vision Service：对 Vision 输出做服务器端二次验证（UNTRUSTED_MODEL_OUTPUT）。
 * Vision 只输出候选；标签/技能白名单、置信度、数量上限全部由服务器执行。
 * 禁止从 Vision 输出中读取任何属性数值（STR=999 之类一律无视）。
 * 阶段34：标签白名单来自 data/visualTagLibrary.json（visualRules）；技能映射来自
 * data/visualSkillMappings.json；组合推断 + 置信度门槛见 visualRules。
 */
const legacy = require('./avatarRules');
const rules = require('./visualRules');

/**
 * 从 Vision 输出提取视觉标签（兼容新 visual_tags 数组 / 旧 candidate_tags）。
 * visual_tags: [{id, confidence, evidence}]；candidate_tags: ["tag"] + confidence{tag:0.x}
 */
function extractRawTags(raw) {
  const tags = [];
  const confidence = raw.confidence && typeof raw.confidence === 'object' ? raw.confidence : {};
  if (Array.isArray(raw.visual_tags)) {
    for (const t of raw.visual_tags) {
      if (!t || typeof t !== 'object') continue;
      const id = String(t.id || '').trim();
      if (!id) continue;
      tags.push({ id, confidence: Number(t.confidence ?? confidence[id]), evidence: t.evidence || '' });
    }
  } else if (Array.isArray(raw.candidate_tags)) {
    for (const t of raw.candidate_tags) {
      const id = String(t).trim();
      if (!id) continue;
      tags.push({ id, confidence: Number(confidence[id]) });
    }
  }
  return { tags, confidence };
}

/**
 * 验证 Vision 输出。
 * @returns {{acceptedTags, rejectedTags, acceptedSkillKeys, rejectedSkills, inferredArchetypes}}
 */
function validateVisionOutput(raw, { allowedSkillKeys }) {
  const acceptedTags = [];
  const rejectedTags = [];

  const { tags } = extractRawTags(raw);

  for (const t of tags) {
    const tag = t.id;
    if (!rules.isAllowedTag(tag)) {
      rejectedTags.push({ tag, reason: 'REJECTED_UNKNOWN_TAG' });
      continue;
    }
    if (acceptedTags.includes(tag)) continue;
    const conf = Number(t.confidence);
    // 未提供置信度视为不可验证 → 拒绝（宁可空，不猜测）
    if (!Number.isFinite(conf) || conf < rules.MIN_TAG_CONFIDENCE) {
      rejectedTags.push({ tag, reason: 'REJECTED_LOW_CONFIDENCE', confidence: Number.isFinite(conf) ? conf : null });
      continue;
    }
    acceptedTags.push(tag);
  }

  // 组合推断（多标签 → archetype）：推断出的原型加入 acceptedTags（走技能映射）
  const inferredArchetypes = rules.inferArchetypes(acceptedTags);
  for (const a of inferredArchetypes) {
    if (!acceptedTags.includes(a)) acceptedTags.push(a);
  }

  // 技能候选：只接受 allowed_skill_keys 内的（god_mode/admin 等一律 REJECTED_UNKNOWN_SKILL）
  const acceptedSkillKeys = [];
  const rejectedSkills = [];
  const rawSkills = Array.isArray(raw.candidate_skill_ids) ? raw.candidate_skill_ids : [];
  for (const s of rawSkills) {
    const key = String(s).trim();
    if (!key) continue;
    if (!allowedSkillKeys.includes(key)) {
      rejectedSkills.push({ skill: key, reason: 'REJECTED_UNKNOWN_SKILL' });
      continue;
    }
    if (!acceptedSkillKeys.includes(key)) acceptedSkillKeys.push(key);
  }

  return { acceptedTags, rejectedTags, acceptedSkillKeys, rejectedSkills, inferredArchetypes };
}

/**
 * 最终计算（规范第二十条 + 阶段34 数据驱动）：
 *   属性 = base + 已验证标签修正（JSON modifier + 限额 + Clamp 1~10）
 *   技能 = 已接受标签 → 服务器技能映射（JSON 数据驱动 + 旧 avatarRules 兼容）→ 数据库验证 → 限 2 个
 * 技能完全由"标签 → 服务器规则"决定；Vision 的 candidate_skill_ids 仅作为
 * 受校验的参考信号（非法者记入 rejected），不作为发放闸门。
 */
function computeFinalState(acceptedTags, validatedSkillKeys, dbSkillRowsByName) {
  const attributes = rules.computeAttributesFrom(acceptedTags);

  // 权威来源：标签 → 服务器技能映射规则（JSON 数据驱动 + 兼容旧规则）
  const merged = rules.candidateSkillKeys(acceptedTags);

  const accepted = [];
  const rejected = [];
  for (const key of merged) {
    const row = dbSkillRowsByName.get(key);
    if (!row) {
      rejected.push({ skill: key, reason: 'REJECTED_NOT_IN_DATABASE' });
      continue;
    }
    if (accepted.length >= rules.MAX_INITIAL_SKILLS) {
      rejected.push({ skill: key, reason: 'REJECTED_SKILL_LIMIT' });
      continue;
    }
    accepted.push({ key, skillId: row.id, display: rules.SKILL_DISPLAY[key] || key });
  }

  return { attributes, acceptedSkills: accepted, rejectedComputedSkills: rejected };
}

module.exports = { validateVisionOutput, computeFinalState };
