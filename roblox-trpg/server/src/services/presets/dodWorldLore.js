/**
 * Die of Death 阶段22：World Lore Foundation（世界背景数据库）。
 *
 * 目标：让 AI GM 理解 Die of Death 发生在哪里、Civilian 为什么需要生存、
 * 这个世界有哪些基础组织和环境。
 *
 * 设定纪律（必须遵守）：
 *  - 只实现世界背景数据库：不实现 Killer AI / 战斗 / 副本流程 / 地图 / 任务；
 *  - Robloxia：一个由普通居民组成的世界（普通市民/工作人员/研究人员/建设者/商人），
 *    大多数人没有战斗能力——Civilian 不是战士，只是拥有不同人生经验的人；
 *  - Killer 当前只作为世界威胁概念（不实现具体 Killer：不生成实体/NPC/AI/数值）；
 *  - Government 为预留 Lore 接口（public_information + secret_information 字段就位，
 *    secret = reserved：本阶段不创建具体剧情）；
 *  - 内容仅使用官方设定输入（lore_source=CANON），不创造原创世界设定。
 */
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'DIE_OF_DEATH';
const EXPERIENCE_KEY = 'dod';

// ── DOD World Rules（官方输入 5 条）──
const WORLD_RULES = [
  'Civilian 能力来自自身经历。',
  '普通居民不是英雄。',
  '生存优先于战斗。',
  '能力不能违反世界逻辑。',
  'AI 生成剧情必须符合普通人的视角。',
];

// ── Die of Death World Profile（官方设定）──
const DOD_WORLD_PROFILE = {
  id: 'dod',
  experience_key: EXPERIENCE_KEY,
  name: 'Die of Death World',
  description:
    'Robloxia：一个由普通居民组成的世界。居民包括普通市民、工作人员、研究人员、建设者、商人——大多数人没有战斗能力。',
  setting: 'Robloxia（普通城市世界：依靠居民各自的生活技能运转）',
  era: 'Killers出现后的异常时期',
  factions: [
    {
      name: 'Robloxia Citizens',
      role: 'civilian',
      description: '居住在 Robloxia 的普通公民，不得不忍受四处杀人的 Killers；结合各自生活技能生存。',
      lore_source: 'CANON',
    },
    {
      name: 'Government',
      role: 'reserved',
      description: 'Robloxian Government（罗布洛政府）：Robloxia 的统治者，积极保护平民（如建造作为大厅的安全地堡）。',
      public_information:
        '政府由总统领导，一直积极保护平民——例如建造作为避难所的安全地堡（内含剧院、花园、自助餐厅、街机厅等生活设施与通往外部世界的传送门），地堡有管理员与维修、厨师、园丁、保安等工作人员。',
      secret_information: 'reserved（本阶段只创建 Lore 接口，不实现具体剧情）',
      lore_source: 'CANON',
    },
    {
      name: 'Killers',
      role: 'threat_concept',
      description: '世界威胁概念：某些异常存在会攻击 Robloxia 居民（当前不实现具体 Killer）。',
      lore_source: 'CANON',
    },
  ],
  known_threats: [
    {
      concept: 'Killer',
      description: '某些异常存在会攻击 Robloxia 居民。普通居民需要逃离、隐藏、合作，并利用自身能力生存。',
      resident_response: ['逃离', '隐藏', '合作', '利用自身能力生存'],
      implementation: 'reserved', // 不实现 Killer AI / 战斗
      // 官方已知的威胁存在（仅登记概念与动机，无属性/技能/数值）
      known_entities: [
        { name: 'Pursuer', pronouns: 'He/Him', motive: '对新鲜猎物的无尽渴望——顶级掠食者，来自 Lily Meadow 深处的迷宫森林' },
        { name: 'Badware', pronouns: 'It/They', motive: '源自 Toolbox 的有意识病毒，只想不受干扰地感染并控制更多设备' },
        { name: 'Artful', pronouns: 'He/Him', motive: '法国魔术师，一场失败演出后的情绪爆发（Jean "Degaré" Fromage）' },
        { name: 'Killdroid', pronons_note: 'It/They（也可 He/Him）', motive: '政府制造的机器人保镖原型，测试中失控叛逃（原因未知）' },
        { name: 'Harken', pronouns: 'She/Her', motive: '来自"噪音会引来更危险构造体"的异次元，为自保而杀死发出声响者' },
      ],
    },
  ],
  civilian_life: {
    城市与聚落: 'Robloxia 的城市由普通居民共同维持运转',
    住宅区: '居民居住的街区，灾变后成为互助据点',
    商业区域: '商店与市集，物资交换的中心',
    公共设施: '政府建造的避难所（如安全地堡）等公共空间',
    工作场所: '居民各自凭借职业与生活技能工作',
    note: 'Civilian 不是战士。他们只是拥有不同人生经验的人。',
  },
  world_rules: WORLD_RULES,
  government: {
    name: 'Robloxian Government',
    description: 'Robloxia 的统治者（现任总统 Cobalt，前任 Sulfur）；积极保护平民。',
    public_information:
      '建造并维护安全地堡（大厅）；制造过机器人保镖原型（Killdroid，测试中失控）；追踪某些异常存在的信号并警告居民避开。',
    secret_information: 'reserved（本阶段不创建具体剧情）',
  },
  lore_source: 'CANON',
};

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

/** 幂等播种世界档案（按 id 覆盖更新，内容随官方设定输入演进）。 */
function ensureWorldProfileSeeded() {
  const db = getDb();
  const p = DOD_WORLD_PROFILE;
  db.prepare(
    `INSERT INTO experience_world_profiles
       (id, experience_key, name, description, setting, era, factions_json, known_threats_json,
        civilian_life_json, world_rules_json, government_json, lore_source, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, description = excluded.description, setting = excluded.setting,
       era = excluded.era, factions_json = excluded.factions_json, known_threats_json = excluded.known_threats_json,
       civilian_life_json = excluded.civilian_life_json, world_rules_json = excluded.world_rules_json,
       government_json = excluded.government_json, lore_source = excluded.lore_source, source = excluded.source`
  ).run(
    p.id,
    p.experience_key,
    p.name,
    p.description,
    p.setting,
    p.era,
    JSON.stringify(p.factions),
    JSON.stringify(p.known_threats),
    JSON.stringify(p.civilian_life),
    JSON.stringify(p.world_rules),
    JSON.stringify(p.government),
    p.lore_source,
    SOURCE
  );
  return DOD_WORLD_PROFILE;
}

function rowToProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    experienceKey: row.experience_key,
    name: row.name,
    description: row.description,
    setting: row.setting,
    era: row.era,
    factions: parseJson(row.factions_json, []),
    knownThreats: parseJson(row.known_threats_json, []),
    civilianLife: parseJson(row.civilian_life_json, {}),
    worldRules: parseJson(row.world_rules_json, []),
    government: parseJson(row.government_json, {}),
    loreSource: row.lore_source,
    source: row.source,
  };
}

/** 读取世界档案（按 experience_key 或 id）。 */
function getWorldProfile(key = EXPERIENCE_KEY) {
  ensureWorldProfileSeeded();
  const row = getDb()
    .prepare('SELECT * FROM experience_world_profiles WHERE experience_key = ? OR id = ?')
    .get(String(key), String(key).toLowerCase());
  return rowToProfile(row);
}

function listWorldProfiles() {
  ensureWorldProfileSeeded();
  return getDb().prepare('SELECT * FROM experience_world_profiles ORDER BY id').all().map(rowToProfile);
}

/**
 * Civilian 与世界关联：该居民生活在 Robloxia 的哪个侧面。
 * Background → civilian_life 场所提示（供 GM 叙事"他过去在城市里做什么"）。
 */
const BACKGROUND_LIFE_TIE = {
  Engineer: '工作场所（建设与维修）',
  Medic: '公共设施（照护与救助）',
  Athlete: '城市与学校（训练与赛事）',
  Security: '商业区域与公共设施（安保值守）',
  Cook: '商业区域（厨房与市集）',
  Artist: '城市（创作与表演）',
};

function civilianWorldTie(background) {
  const profile = getWorldProfile();
  return {
    world: 'Robloxia',
    era: profile ? profile.era : null,
    background,
    lifeTie: BACKGROUND_LIFE_TIE[background] || '城市（日常生活）',
    note: 'Civilian 不是战士——只是拥有不同人生经验的 Robloxia 普通居民。',
  };
}

/** DOD World Rules 文本（AI Context 用）。 */
function worldRulesText() {
  return WORLD_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

module.exports = {
  SOURCE,
  EXPERIENCE_KEY,
  WORLD_RULES,
  DOD_WORLD_PROFILE,
  BACKGROUND_LIFE_TIE,
  ensureWorldProfileSeeded,
  getWorldProfile,
  listWorldProfiles,
  civilianWorldTie,
  worldRulesText,
};
