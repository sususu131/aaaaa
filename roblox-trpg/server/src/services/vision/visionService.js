/**
 * Vision Service：对 Vision 输出做服务器端二次验证（UNTRUSTED_MODEL_OUTPUT）。
 * Vision 只输出候选；标签/技能白名单、置信度、数量上限全部由服务器执行。
 * 禁止从 Vision 输出中读取任何属性数值（STR=999 之类一律无视）。
 */
const rules = require('./avatarRules');

/**
 * 验证 Vision 输出。
 * @returns {{acceptedTags, rejectedTags, acceptedSkillKeys, rejectedSkills}}
 */
function validateVisionOutput(raw, { allowedSkillKeys }) {
  const acceptedTags = [];
  const rejectedTags = [];

  const rawTags = Array.isArray(raw.candidate_tags) ? raw.candidate_tags : [];
  const confidence = raw.confidence && typeof raw.confidence === 'object' ? raw.confidence : {};

  for (const t of rawTags) {
    const tag = String(t).trim();
    if (!tag) continue;
    if (!rules.ALLOWED_AVATAR_TAGS.includes(tag)) {
      rejectedTags.push({ tag, reason: 'REJECTED_UNKNOWN_TAG' });
      continue;
    }
    if (acceptedTags.includes(tag)) continue;
    const conf = Number(confidence[tag]);
    // 未提供置信度视为不可验证 → 拒绝（宁可空，不猜测）
    if (!Number.isFinite(conf) || conf < rules.MIN_TAG_CONFIDENCE) {
      rejectedTags.push({ tag, reason: 'REJECTED_LOW_CONFIDENCE', confidence: Number.isFinite(conf) ? conf : null });
      continue;
    }
    acceptedTags.push(tag);
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

  return { acceptedTags, rejectedTags, acceptedSkillKeys, rejectedSkills };
}

/**
 * 最终计算（规范第二十条）：
 *   属性 = base + 已验证标签修正（限额 + Clamp 1~10）
 *   技能 = 已接受标签 → 服务器 avatar_skill_rules → 数据库验证 → 限 2 个
 * 技能完全由"标签 → 服务器规则"决定；Vision 的 candidate_skill_ids 仅作为
 * 受校验的参考信号（非法者记入 rejected），不作为发放闸门。
 */
function computeFinalState(acceptedTags, validatedSkillKeys, dbSkillRowsByName) {
  const attributes = rules.computeAttributes(acceptedTags);

  // 权威来源：标签 → 服务器技能映射规则
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
