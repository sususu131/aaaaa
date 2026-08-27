/**
 * Die of Death 阶段23：Civilian Ability Relationship System（Synergy Lore System）。
 *
 * 目标：让 AI GM 理解——为什么某些 Civilian 的能力组合会形成特殊状态。
 *
 * 定义：Civilian 拥有多个高度相关能力时，这些能力会产生特殊使用方式。
 * Synergy 不是：新职业 / 超能力 / 等级提升 / 技能树；
 * 它代表：一个 Civilian 对自身经验的极致结合。
 *
 * 纪律：
 *  - 只使用数据库已有组合（官方 Canon：CarePad / Loveshot），不创造新 Synergy；
 *  - Synergy"改变"既有 Ability 的使用方式（changed_ability），不发放新能力、不写 player_skills；
 *  - 无任何数值字段（无伤害/冷却/等级/解锁链）；
 *  - GM 描述禁止"你升级成CarePad"式句式（见 AI_DESCRIPTIONS 正确示例）。
 */
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'DIE_OF_DEATH';

// ── 官方 Canon Synergy（内容全部来自官方设定输入）──
const CANON_SYNERGIES = [
  {
    id: 'carepad',
    name: 'CarePad',
    source_abilities: ['BonusPad', 'Caretaker'],
    changed_ability: 'BonusPad',
    lore_explanation:
      '一个同时拥有工程经验和医疗经验的 Civilian。他不只是建造辅助设施，而是将设施改造成帮助幸存者恢复的工具。',
    trait_requirements: ['Medical Knowledge', 'Engineering Experience'],
  },
  {
    id: 'loveshot',
    name: 'Loveshot',
    source_abilities: ['Revolver', 'Caretaker'],
    changed_ability: 'Revolver',
    lore_explanation:
      '一个同时拥有枪械经验和医疗经验的 Civilian。他的攻击方式不再只是伤害，而是结合保护和救援理念。',
    trait_requirements: ['Medical Knowledge', 'Firearms Training'],
  },
];

// ── GM 描述示例（官方句式：经验的结合，不是升级/获得）──
const AI_DESCRIPTIONS = {
  carepad: '你的医疗知识和工程经验结合，让你的设备拥有了新的用途。',
  loveshot: '你的医疗知识和枪械经验结合，让你的攻击方式带上了保护和救援的意义。',
};

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

function rowToSynergy(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    sourceAbilities: parseJson(row.source_abilities_json, []),
    changedAbility: row.changed_ability,
    loreExplanation: row.lore_explanation,
    traitRequirements: parseJson(row.trait_requirements_json, []),
    loreSource: row.lore_source,
    aiDescription: AI_DESCRIPTIONS[row.id] || null,
  };
}

/** 幂等播种官方 Synergy 目录（按 id 覆盖更新，内容随官方设定输入演进）。 */
function ensureSynergySeeded() {
  const db = getDb();
  for (const s of CANON_SYNERGIES) {
    db.prepare(
      `INSERT INTO ability_synergies (id, name, source_abilities_json, changed_ability, lore_explanation, trait_requirements_json, lore_source, source)
       VALUES (?, ?, ?, ?, ?, ?, 'CANON', ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, source_abilities_json = excluded.source_abilities_json,
         changed_ability = excluded.changed_ability, lore_explanation = excluded.lore_explanation,
         trait_requirements_json = excluded.trait_requirements_json`
    ).run(
      s.id,
      s.name,
      JSON.stringify(s.source_abilities),
      s.changed_ability,
      s.lore_explanation,
      JSON.stringify(s.trait_requirements),
      SOURCE
    );
  }
  return CANON_SYNERGIES;
}

function listSynergies() {
  ensureSynergySeeded();
  return getDb().prepare('SELECT * FROM ability_synergies ORDER BY id').all().map(rowToSynergy);
}

function getSynergy(idOrName) {
  ensureSynergySeeded();
  const row = getDb().prepare('SELECT * FROM ability_synergies WHERE id = ? OR name = ?').get(
    String(idOrName).toLowerCase(),
    String(idOrName)
  );
  return rowToSynergy(row);
}

/**
 * 组合检测：玩家的 Ability 集合 ⊇ 某条 Synergy 的全部来源能力 → 命中。
 * 只读取数据库已有目录；部分匹配不命中；绝不发明新组合。
 * 加固：来源能力不足 2 项的脏数据一律不命中（Synergy 必然是"多个高度相关能力"的组合）。
 */
function detectSynergies(abilityKeys) {
  const owned = new Set((abilityKeys || []).map(String));
  return listSynergies().filter(
    (s) => Array.isArray(s.sourceAbilities) && s.sourceAbilities.length >= 2 && s.sourceAbilities.every((a) => owned.has(a))
  );
}

/**
 * 生成流第 4 步（Background → Traits → Abilities → 检查 Synergy）：
 * 检测并保存到 civilian_instance.synergies（Lore 状态；幂等；不发技能）。
 */
function checkAndSaveSynergies(playerRowId) {
  const db = getDb();
  const civ = db.prepare('SELECT * FROM civilian_instance WHERE player_id = ?').get(playerRowId);
  if (!civ) return [];
  const detected = detectSynergies(parseJson(civ.abilities, []));
  const ids = detected.map((s) => s.id);
  const stored = parseJson(civ.synergies, []);
  if (JSON.stringify(stored) !== JSON.stringify(ids)) {
    db.prepare("UPDATE civilian_instance SET synergies = ?, updated_at = datetime('now') WHERE player_id = ?").run(
      JSON.stringify(ids),
      playerRowId
    );
  }
  return detected;
}

/** 玩家 Synergy 视图（Context / REST 共用）。 */
function synergyView(playerRowId) {
  const db = getDb();
  const civ = db.prepare('SELECT * FROM civilian_instance WHERE player_id = ?').get(playerRowId);
  if (!civ) return [];
  const byId = Object.fromEntries(listSynergies().map((s) => [s.id, s]));
  return parseJson(civ.synergies, [])
    .map((id) => byId[id])
    .filter(Boolean)
    .map((s) => ({
      name: s.name,
      sourceAbilities: s.sourceAbilities,
      changedAbility: s.changedAbility,
      loreExplanation: s.loreExplanation,
      traitRequirements: s.traitRequirements,
      aiDescription: s.aiDescription,
    }));
}

module.exports = {
  SOURCE,
  CANON_SYNERGIES,
  AI_DESCRIPTIONS,
  ensureSynergySeeded,
  listSynergies,
  getSynergy,
  detectSynergies,
  checkAndSaveSynergies,
  synergyView,
};
