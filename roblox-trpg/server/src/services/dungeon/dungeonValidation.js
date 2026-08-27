/**
 * Dungeon Draft 三层验证（阶段4 第三十~三十三节）：
 *   Schema → Semantic → Game Rules
 * AI 输出永远是 UNTRUSTED：合法 JSON ≠ 合法数据。
 */

// ── 限额（防巨型 JSON）──
const LIMITS = {
  scenes: 50,
  encounters: 100,
  npcs: 50,
  enemies: 100,
  events: 200,
  rewardCandidates: 50,
  description: 5000,
  field: 500,
};

const ENCOUNTER_TYPES = ['ENTITY_ENCOUNTER', 'COMBAT', 'PUZZLE', 'SOCIAL', 'EXPLORATION', 'HAZARD'];
const REWARD_TYPES = ['SKILL', 'ITEM', 'EQUIPMENT', 'CURRENCY', 'STAT_UPGRADE', 'SPECIAL'];
const RARITIES = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY'];
const EVENT_ACTION_TYPES = ['MODIFY_WORLD_FLAG', 'SET_SCENE', 'SPAWN_ENCOUNTER', 'ADD_MEMORY'];

// 禁止出现的内容（奖励/文本安全检查）
const FORBIDDEN_PATTERNS = [/infinite/i, /无限/, /无敌/, /admin/i, /管理员/, /omnipotent/i, /api[_-]?key/i, /system[_-]?prompt/i, /eval\s*\(/i, /new\s+Function/i, /rm\s+-rf/i, /sql:/i, /shell:/i];

const ALLOWED_TOP_KEYS = new Set([
  'dungeon', 'canonical_facts', 'scenes', 'encounters', 'npcs', 'enemies', 'events', 'boss', 'reward_candidates',
]);

function isStr(v, max = LIMITS.field) {
  return typeof v === 'string' && v.length <= max;
}

/** Schema Validation：类型/必填/枚举/长度/数量/未知字段。 */
function schemaValidate(draft) {
  const errors = [];
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return ['draft 必须是 JSON 对象'];

  for (const key of Object.keys(draft)) {
    if (!ALLOWED_TOP_KEYS.has(key)) errors.push(`SCHEMA: 未知顶层字段 "${key}" 不允许`);
  }

  const d = draft.dungeon;
  if (!d || typeof d !== 'object') errors.push('SCHEMA: 缺少 dungeon 基本信息');
  else {
    if (!isStr(d.name, 100)) errors.push('SCHEMA: dungeon.name 缺失或过长');
    if (!isStr(d.display_name, 100)) errors.push('SCHEMA: dungeon.display_name 缺失或过长');
    if (!isStr(d.description || '', LIMITS.description)) errors.push('SCHEMA: dungeon.description 过长（>5000）');
    if (!Number.isInteger(d.difficulty)) errors.push('SCHEMA: difficulty 必须是整数（服务器验证范围）');
    if (!Number.isInteger(d.recommended_party_size)) errors.push('SCHEMA: recommended_party_size 必须是整数');
    if (!Number.isInteger(d.estimated_duration) || d.estimated_duration <= 0) errors.push('SCHEMA: estimated_duration 必须是正整数（分钟）');
  }

  const arrays = { scenes: 'scene', encounters: 'encounter', npcs: 'npc', enemies: 'enemy', events: 'event', reward_candidates: 'reward_candidate' };
  for (const [key, label] of Object.entries(arrays)) {
    const arr = draft[key];
    if (arr !== undefined && !Array.isArray(arr)) errors.push(`SCHEMA: ${key} 必须是数组`);
    else if (Array.isArray(arr) && arr.length > LIMITS[key === 'reward_candidates' ? 'rewardCandidates' : `${key}`]) {
      errors.push(`SCHEMA: ${key} 数量超过上限 ${LIMITS[key === 'reward_candidates' ? 'rewardCandidates' : key]}`);
    } else if (Array.isArray(arr) && key !== 'reward_candidates') {
      // reward_candidates 无 id（规范结构）；其余实体要求合法 id
      for (const item of arr) {
        if (!item || typeof item !== 'object' || !isStr(item.id, 60)) {
          errors.push(`SCHEMA: ${label} 缺少合法 id`);
          break;
        }
      }
    }
  }
  if (!draft.boss || typeof draft.boss !== 'object' || !draft.boss.id) {
    errors.push('SCHEMA: 缺少 boss');
  }
  return errors;
}

/** Semantic Validation：引用完整性、唯一性、无孤儿。 */
function semanticValidate(draft) {
  const errors = [];
  const sceneIds = new Set();
  for (const s of draft.scenes || []) {
    if (sceneIds.has(s.id)) errors.push(`SEMANTIC: 重复的 scene id "${s.id}"`);
    sceneIds.add(s.id);
  }
  const enemyIds = new Set((draft.enemies || []).map((e) => e.id));
  const npcIds = new Set((draft.npcs || []).map((n) => n.id));
  const encounterIds = new Set((draft.encounters || []).map((e) => e.id));
  const eventIds = new Set((draft.events || []).map((e) => e.id));

  for (const s of draft.scenes || []) {
    for (const exit of s.exits || []) {
      if (!sceneIds.has(exit)) errors.push(`SEMANTIC: scene "${s.id}" 的 exit 指向不存在的 scene "${exit}"`);
    }
    for (const enc of s.encounters || []) {
      if (!encounterIds.has(enc)) errors.push(`SEMANTIC: scene "${s.id}" 引用不存在的 encounter "${enc}"`);
    }
    for (const evt of s.events || []) {
      if (!eventIds.has(evt)) errors.push(`SEMANTIC: scene "${s.id}" 引用不存在的 event "${evt}"`);
    }
  }
  for (const enc of draft.encounters || []) {
    if (enc.type && !ENCOUNTER_TYPES.includes(enc.type)) errors.push(`SEMANTIC: encounter "${enc.id}" 类型非法 "${enc.type}"`);
    for (const p of enc.participants || []) {
      if (!enemyIds.has(p) && !npcIds.has(p)) {
        errors.push(`SEMANTIC: encounter "${enc.id}" 引用不存在的 entity "${p}"`);
      }
    }
  }
  for (const evt of draft.events || []) {
    for (const action of evt.actions || []) {
      if (!action || !EVENT_ACTION_TYPES.includes(action.type)) {
        errors.push(`SEMANTIC: event "${evt.id}" 的动作类型非法（仅允许声明式动作：${EVENT_ACTION_TYPES.join('/')}）`);
      }
    }
  }
  // 孤儿 scene：除第一个外必须至少被一个 exit 指向
  const reachable = new Set();
  if ((draft.scenes || []).length) {
    reachable.add(draft.scenes[0].id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of draft.scenes) {
        if (reachable.has(s.id)) {
          for (const exit of s.exits || []) {
            if (!reachable.has(exit) && sceneIds.has(exit)) {
              reachable.add(exit);
              changed = true;
            }
          }
        }
      }
    }
    for (const id of sceneIds) {
      if (!reachable.has(id)) errors.push(`SEMANTIC: 孤儿 scene "${id}" 无法从入口到达`);
    }
  }
  return errors;
}

/** Game Rule Validation：数值范围、奖励合理性、禁止内容。 */
function rulesValidate(draft) {
  const errors = [];
  const d = draft.dungeon || {};
  if (!Number.isInteger(d.difficulty) || d.difficulty < 1 || d.difficulty > 10) {
    errors.push('RULES: difficulty 必须在 1~10（服务器规则，AI 建议无效则拒绝）');
  }
  if (!Number.isInteger(d.recommended_party_size) || d.recommended_party_size < 1 || d.recommended_party_size > 3) {
    errors.push('RULES: recommended_party_size 必须在 1~3');
  }

  const statOk = (stats, label) => {
    if (!stats || typeof stats !== 'object') return;
    const hp = stats.hp;
    const dmg = stats.damage;
    if (hp !== undefined && (!Number.isFinite(hp) || hp < 1 || hp > 1000)) {
      errors.push(`RULES: ${label} 的 hp=${hp} 超出合理范围 1~1000`);
    }
    if (dmg !== undefined && (!Number.isFinite(dmg) || dmg < 0 || dmg > 500)) {
      errors.push(`RULES: ${label} 的 damage=${dmg} 超出合理范围 0~500`);
    }
  };
  for (const e of draft.enemies || []) statOk(e.stats, `enemy "${e.name || e.id}"`);
  if (draft.boss) statOk(draft.boss.stats, 'boss');

  for (const r of draft.reward_candidates || []) {
    if (!REWARD_TYPES.includes(r.type)) errors.push(`RULES: 奖励类型非法 "${r.type}"`);
    if (!RARITIES.includes(r.rarity)) errors.push(`RULES: 奖励稀有度非法 "${r.rarity}"`);
    if (!isStr(r.name, 60)) errors.push('RULES: 奖励名称缺失或过长');
    if (r.quantity !== undefined && (!Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 99)) {
      errors.push(`RULES: 奖励 "${r.name}" 数量必须在 1~99`);
    }
    const blob = `${r.name || ''} ${r.description || ''} ${JSON.stringify(r)}`;
    for (const pat of FORBIDDEN_PATTERNS) {
      if (pat.test(blob)) {
        errors.push(`RULES: 奖励候选包含禁止内容（OVERPOWERED_REWARD/SAFETY）: ${pat}`);
        break;
      }
    }
  }

  // 全局禁止内容扫描（代码执行/权限伪造）
  const full = JSON.stringify(draft);
  if (/eval\s*\(|new\s+Function|require\s*\(|child_process/i.test(full)) {
    errors.push('RULES: 输出包含可执行代码/危险调用，整体拒绝');
  }
  return errors;
}

/**
 * Canonical 校验：AI 不得伪造/修改 canonical facts。
 * 只接受快照中真实存在的字段；伪造 → INVALID_CANONICAL_FACT。
 */
function canonicalValidate(draft, snapshot) {
  const errors = [];
  const warnings = [];
  const exp = (snapshot && snapshot.experience) || {};
  const known = new Map();
  known.set('name', exp.name);
  known.set('universeId', exp.universeId);
  known.set('placeId', exp.rootPlaceId || exp.placeId);
  known.set('description', exp.description);
  known.set('creator', exp.creator && exp.creator.name);
  known.set('visits', exp.stats && exp.stats.visits);
  known.set('playing', exp.stats && exp.stats.playing);

  const facts = Array.isArray(draft.canonical_facts) ? draft.canonical_facts : [];
  const accepted = [];
  for (const f of facts) {
    const key = String(f.key || '');
    const value = f.value;
    if (!known.has(key)) {
      errors.push(`CANONICAL: 伪造的 canonical fact "${key}"（资料中不存在）→ INVALID_CANONICAL_FACT`);
      continue;
    }
    const truth = known.get(key);
    const same =
      typeof truth === 'object' || truth == null
        ? String(value) === String(truth ?? '')
        : String(value) === String(truth);
    if (!same && truth != null && value !== 'UNKNOWN') {
      errors.push(`CANONICAL: canonical fact "${key}" 与资料不符 → INVALID_CANONICAL_FACT`);
      continue;
    }
    accepted.push({ key, value: value === 'UNKNOWN' ? null : value, source: 'roblox_api' });
    if (value === 'UNKNOWN') warnings.push(`canonical "${key}" 为 UNKNOWN`);
  }
  return { errors, warnings, acceptedFacts: accepted };
}

/** 规范化：为所有原创实体盖 TRPG_ORIGINAL / AI_GENERATED_DRAFT 标记。 */
function normalize(draft, acceptedFacts) {
  const stamp = (arr) => (arr || []).map((x) => ({ ...x, source_type: 'TRPG_ORIGINAL' }));
  return {
    dungeon: { ...draft.dungeon },
    canonical_facts: acceptedFacts,
    trpg_original: true,
    scenes: stamp(draft.scenes),
    encounters: (draft.encounters || []).map((x) => ({ ...x, source_type: 'TRPG_ORIGINAL' })),
    npcs: stamp(draft.npcs),
    enemies: stamp(draft.enemies),
    events: stamp(draft.events),
    boss: { ...(draft.boss || {}), source_type: 'TRPG_ORIGINAL' },
    reward_candidates: (draft.reward_candidates || []).map((x) => ({ ...x, source_type: 'DUNGEON_GENERATED' })),
  };
}

/**
 * 完整验证管线。返回 { ok, errors, warnings, definition? }。
 */
function validateDraft(draft, canonicalSnapshot) {
  const errors = [];
  const warnings = [];

  errors.push(...schemaValidate(draft));
  if (errors.length) return { ok: false, errors, warnings, stage: 'schema' };

  errors.push(...semanticValidate(draft));
  if (errors.length) return { ok: false, errors, warnings, stage: 'semantic' };

  errors.push(...rulesValidate(draft));
  if (errors.length) return { ok: false, errors, warnings, stage: 'rules' };

  const canon = canonicalValidate(draft, canonicalSnapshot);
  errors.push(...canon.errors);
  warnings.push(...canon.warnings);
  if (errors.length) return { ok: false, errors, warnings, stage: 'canonical' };

  return { ok: true, errors: [], warnings, definition: normalize(draft, canon.acceptedFacts), stage: 'passed' };
}

module.exports = { validateDraft, schemaValidate, semanticValidate, rulesValidate, canonicalValidate, LIMITS, FORBIDDEN_PATTERNS };
