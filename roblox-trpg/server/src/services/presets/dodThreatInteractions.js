/**
 * Die of Death 阶段25：Threat Interactions（居民能力 × 杀手威胁 的官方特殊效果）。
 *
 * 依据官方 Lore 登记"对策"互动（Lore + 结构化标记）：
 *  - 强光（Flashlight）直照隐身中的 Pursuer → 拟态被锁定：立即现形并僵直；
 *  - 水 → Pursuer 极度厌恶水，会为避免浸水而放弃追猎；
 *  - 噪音（Bugle/Taunt 等）→ 吸引并加速激怒 Harken（噪音是她的资源与恐惧）；
 *  - 持续压力 → Artful 的召唤物（墙/音乐盒/傀儡）不耐用，随时间/受击碎裂；
 *  - 远离机械 → Badware 会感染并夺走附近设备的控制权。
 *
 * 纪律：这是 Lore 层数据与 GM 叙事规则——Killer 战斗/AI 本身仍未实现；
 * 不入库任何技能数值表（冷却/伤害/属性）。
 */
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'DIE_OF_DEATH';

const THREAT_INTERACTIONS = [
  {
    id: 'flashlight_pursuer',
    ability_key: 'flashlight',
    threat_key: 'pursuer',
    effect: '隐身中会现形并僵直',
    lore_explanation:
      'Pursuer 的隐形依靠重组骨骼与改变肤色细胞拟态（类似章鱼）——强光直照会锁定其拟态状态：正在隐身（潜行）的 Pursuer 立即现形，并因拟态被打断而短暂僵直。',
    flags: { reveal_stealth: true, stun: true, requires_stealth: true },
  },
  {
    id: 'water_pursuer',
    ability_key: 'water',
    threat_key: 'pursuer',
    effect: '驱退（放弃追猎）',
    lore_explanation:
      'Pursuer 极度厌恶水，会因避免浸水而放弃追猎——水域是摆脱它的可靠手段（官方 Library：幸存者证词）。',
    flags: { repel: true },
  },
  {
    id: 'noise_harken',
    ability_key: 'noise',
    threat_key: 'harken',
    effect: '吸引 + 加速激怒',
    lore_explanation:
      '噪音是 Harken 的资源也是她的恐惧（她的维度里噪音会引来更危险的构造体）。Bugle/Taunt 等制造声响的能力会立刻吸引她的注意，并加速她的狂暴；保持安静才能真正躲开她。',
    flags: { attract: true, enrage: true },
  },
  {
    id: 'pressure_artful',
    ability_key: 'sustained_pressure',
    threat_key: 'artful',
    effect: '召唤物碎裂',
    lore_explanation:
      'Artful 显现的墙体、音乐盒与傀儡并不耐用：随时间化为尘土、或受压碎裂。拖延与持续施压可以破解他的区域封锁。',
    flags: { decay_constructs: true },
  },
  {
    id: 'machinery_badware',
    ability_key: 'avoid_machinery',
    threat_key: 'badware',
    effect: '避免设备倒戈',
    lore_explanation:
      'Badware 能向附近机械注入病毒并完全控制——枪械火箭在使用前就开始为它而战。远离机械设备、不依赖附近机械是唯一的稳妥对策。',
    flags: { avoid_devices: true },
  },
];

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

function rowToInteraction(row) {
  if (!row) return null;
  return {
    id: row.id,
    abilityKey: row.ability_key,
    threatKey: row.threat_key,
    effect: row.effect,
    loreExplanation: row.lore_explanation,
    flags: parseJson(row.flags_json, {}),
    loreSource: row.lore_source,
  };
}

/** 幂等播种官方互动目录（按 id 覆盖更新）。 */
function ensureInteractionSeeded() {
  const db = getDb();
  for (const it of THREAT_INTERACTIONS) {
    db.prepare(
      `INSERT INTO ability_threat_interactions (id, ability_key, threat_key, effect, lore_explanation, flags_json, lore_source, source)
       VALUES (?, ?, ?, ?, ?, ?, 'CANON', ?)
       ON CONFLICT(id) DO UPDATE SET
         ability_key = excluded.ability_key, threat_key = excluded.threat_key, effect = excluded.effect,
         lore_explanation = excluded.lore_explanation, flags_json = excluded.flags_json`
    ).run(it.id, it.ability_key, it.threat_key, it.effect, it.lore_explanation, JSON.stringify(it.flags), SOURCE);
  }
  return THREAT_INTERACTIONS;
}

function listInteractions() {
  ensureInteractionSeeded();
  return getDb().prepare('SELECT * FROM ability_threat_interactions ORDER BY id').all().map(rowToInteraction);
}

/** 按能力/威胁查询互动（如 Flashlight 的持有者能看到哪些对策）。 */
function findInteractions({ ability = null, threat = null } = {}) {
  return listInteractions().filter(
    (i) => (!ability || i.abilityKey === String(ability).toLowerCase()) && (!threat || i.threatKey === String(threat).toLowerCase())
  );
}

// 能力别名：制造声响的能力（Bugle/Taunt 等）都映射到 noise 互动
const ABILITY_ALIASES = {
  noise: ['noise', 'bugle', 'taunt'],
};

/** GM 叙事文本：房间内居民持有能力对应的对策清单。 */
function interactionBrief(abilityKeys) {
  const owned = new Set((abilityKeys || []).map((k) => String(k).toLowerCase()));
  for (const [key, aliases] of Object.entries(ABILITY_ALIASES)) {
    if (aliases.some((a) => owned.has(a))) owned.add(key);
  }
  const lines = [];
  for (const i of listInteractions()) {
    if (owned.has(i.abilityKey)) lines.push(`- ${i.abilityKey} × ${i.threatKey}：${i.effect}——${i.loreExplanation}`);
  }
  return lines;
}

module.exports = {
  SOURCE,
  THREAT_INTERACTIONS,
  ABILITY_ALIASES,
  ensureInteractionSeeded,
  listInteractions,
  findInteractions,
  interactionBrief,
};
