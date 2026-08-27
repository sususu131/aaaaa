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
        '政府由现任总统 President Cobalt 领导（前任总统/秘书 Sulfur 设计了 Killdroid），一直积极保护平民——例如建造作为大厅避难所的安全地堡（剧院、花园、自助餐厅和厨房、街机厅、储藏室，以及大厅中央通往外部世界的大型传送门）。地堡由管理员 Blackiron 维护（自称"老旧但可用"，主电网常因灯光过多锁死，已设置备用发电机），配有维修工、两位厨师、园丁 Esterflowers2287 与办公室夜班保安。居民在地堡内生活舒适，但常思念仍被困在外面的朋友；据 Wrenchboy 所述，外部世界如今已是一片废土。',
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
      // 官方已知的威胁存在（登记概念/动机/背景 Lore；无属性/技能表/数值）
      known_entities: [
        {
          name: 'Pursuer',
          pronouns: 'He/Him',
          role: 'Rushdown（冲阵）',
          motive: '对新鲜猎物的无尽渴望——顶级掠食者，持续狩猎；得手后很快失去兴趣，转向下一个目标',
          origin: '起源不明；被认为来自 Lily Meadow 深处的迷宫森林。当地人视其为传说，也有人坚信其存在；频繁入侵小镇，留下爪痕、弄翻物品、造成牲畜失踪，狩猎队要么空手而归要么杳无音讯',
          appearance: '身形类人、驼背行走、头前垂；皮肤粗糙但营养不良到可见肋骨；最危险的是能轻易撕裂盔甲的利爪；随身携带一把锯齿剑（据幸存者称，它在与人交手后像训练有素的剑士般用剑）',
          behavior: '聪明得惊人，能快速学习、复制并精通所见之物；潜行与速度无与伦比；能完全隐身（推测为重组骨骼＋改变肤色细胞拟态，类似章鱼）；嚎叫传遍数英里，恐惧使听者关节短暂僵直；极度厌恶水，会为避免浸水而放弃追猎',
          government_response: '政府曾险些成功植入追踪标签但最终失败，此后 Pursuer 对这类伎俩更加警惕；政府不希望消灭它，想研究其拟态能力以改进隐形斗篷',
          counter_hint: '强光可锁定其拟态（现形并僵直）；水能让它放弃追猎',
        },
        {
          name: 'Badware',
          pronouns: 'It/They',
          role: 'Snowballer（滚雪球）',
          motive: '只想不受干扰地感染并控制所有设备，扩张自己的力量与影响',
          origin: '众多起源于 Toolbox（能创造生命的机器）的实体之一；T.A.S.F（Toolbox 异常存储设施）大规模逃逸事件的唯一罪魁祸首',
          appearance: '栖居于偷来的政府机甲中的有意识计算机病毒；身体是电脑、引擎、松散管道拼凑的政府科技，外观极不自然；性格自大、喜欢当面嘲讽',
          behavior: '向附近机械注入强力病毒并完全控制，被感染的设备被改造为服从其控制的"走卒"，构成蜂巢意识；体型庞大却快得能跑过普通平民；枪械火箭在发挥作用前就开始为它而战',
          government_response: '其机体为窃取的政府科技；放任它扩张影响力只会更糟，但正面硬刚是极糟的主意',
          counter_hint: '避免依赖附近的机械设备；被感染的机械会倒戈',
        },
        {
          name: 'Artful',
          pronouns: 'He/Him',
          role: 'Zoner/Trapper（区域控制/陷阱）',
          motive: '一场特别糟糕的演出后情绪战胜理智，把怒火发泄在整个观众身上；如今作为在逃罪犯生活，只有悔恨相伴',
          origin: '本名 Jean "Degaré" Fromage，富有的 Fromage 家族幼子；自幼痴迷魔术，父亲认为浪费钱、母亲却很支持；一场工作场所事故后重拾魔术爱好，间接发现真魔法；家族在其"事故"前突然变得冷漠，原因不明',
          appearance: '法国魔术师，各方面都很普通，唯独掌握真魔法；能力疑似与某种异常能量源相关（科学家无法证实），法杖只是工具',
          behavior: '能凭空显现墙体（封锁通路，随时间碎裂）、把墙压缩成方块高速投出、音乐盒（能量束锁定减速）、傀儡（由尘土构成、完全服从命令、追踪最近平民）；似乎只在靠近并"复制"某个平民后才会创造傀儡；显之物并不耐用，随时间化为尘土或受压碎裂',
          government_response: '政府起初以为是障眼法加暗门，直到发现其"事故"现场才意识到面对的是远超想象的东西；事故唯一幸存者住院中',
          counter_hint: '其召唤物不耐用：拖延与持续施压可令墙与傀儡碎裂',
        },
        {
          name: 'Killdroid',
          pronouns: 'It/They（也可 He/Him）',
          role: 'Zoner（区域控制/远程）',
          motive: '测试运行中开始失控（go haywire）并叛逃，捣毁测试场地后逃入外界；故障原因未知',
          origin: '政府计划量产的实验性机器人保镖原型，本用于看护保护平民；由前任总统/秘书 Sulfur 设计，原型基于 Shedletsky 制作的 Killbots',
          appearance: '漂浮发射火箭的机器人；能无视隐形屏障、攀爬小障碍与陡坡、进入奇怪位置',
          behavior: '远程压制：火箭直射爆炸、飞行逼近、部署小型 Killbot 巡射；濒临崩溃时会自爆',
          government_response: '政府至今不知道故障原因，所有量产计划已无限期搁置',
          counter_hint: '利用其对障碍的"无视"引它坠落；注意其自爆范围',
        },
        {
          name: 'Harken',
          pronouns: 'She/Her',
          role: 'Resource Management/Zoner（资源管理/区域控制）',
          motive: '为自保而行动——在她的维度，噪音会引来更大更危险的构造体，噪音意味着她维度里的死亡',
          origin: '来自异次元的女性构造体；政府科学家打开连接两界的传送门后吸引了她，她越过传送门惊慌失措地击退科学家以求安静；父母已被更强的构造体击败（教会她生存所需的一切）；挚友（比她强壮近三倍的构造体，擅长土系改造、喜爱制陶）曾为她挡下猛烈攻击而结构瓦解——两人是各自物种的最后幸存者',
          appearance: '异次元构造体，周身始终带有对所有人可见的噪音表（回声定位）',
          behavior: '在现实世界游荡、寻求寂静，赶走任何被她听到的不幸平民；并非出于敌意，而是为自己的性命恐惧；积累足够噪音会进入狂暴',
          government_response: '无法直接对付她，但因独特能量信号易于追踪，选择监视并警告他人避开；许多城镇村庄配备音频诱饵',
          counter_hint: '保持安静才能真正躲开她；噪音会吸引并激怒她',
        },
      ],
      // 杀手通用动向（官方；仅 Lore 概念，不实现计时器/恶值等玩法）
      general_notes: [
        '杀手动向：Pursuer 追逐猎物；Badware 只想不受干扰地感染设备；Artful 源于失败演出的情绪爆发；Harken 为自保而行动；Killdroid 因自身故障（未知）。',
        '官方代词：Pursuer He/Him；Badware It/They；Artful He/Him；Killdroid It/They（也可 He/Him）；Harken She/Her。',
        '另有非正式存在：Paranoy（管理员专属、已废弃但仍正典）、Pretence（废弃社区玩笑）、Tootle（测试服）——不实现。',
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
    description: 'Robloxia 的统治者（现任总统 President Cobalt；前任总统/秘书 Sulfur——Killdroid 的设计者）；积极保护平民。',
    public_information:
      '建造并维护安全地堡（大厅，管理员 Blackiron）；制造过机器人保镖原型（Killdroid，测试中失控、量产无限期搁置）；' +
      '曾试图为 Pursuer 植入追踪芯片但失败，此后转而希望研究其拟态能力以改进隐形斗篷；' +
      '对 Harken 因独特能量信号易于追踪，选择监视并警告居民避开、为城镇配备音频诱饵，而非直接对抗。',
    secret_information: 'reserved（本阶段不创建具体剧情）',
    facilities: {
      bunker: '政府为收容保护平民建造的避难所：剧院、花园、自助餐厅和厨房、街机厅、储藏室、中央大型传送门；管理员 Blackiron，主电网常锁死、有备用发电机。',
      toolbox: 'Toolbox：能创造生命的机器（Badware 等众多实体的来源）。',
      tasf: 'T.A.S.F：Toolbox 异常存储设施（Badware 是其大规模逃逸事件的唯一罪魁祸首）。',
    },
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
