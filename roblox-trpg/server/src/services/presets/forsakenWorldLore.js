/**
 * Forsaken 世界档案（World Lore Foundation）——镜像 dodWorldLore.js。
 *
 * 目标：让 AI GM 理解 Forsaken 发生在哪里（The Spectre 创造的黑暗领域）、
 * Survivor 为什么需要生存、这个世界有哪些阵营与威胁。
 *
 * 设定纪律（必须遵守）：
 *  - 只实现世界背景数据库：不实现对局系统 / 计时 / 目标 UI / 胜负条件 / 角色升级 / 竞技模式；
 *  - The Spectre's Realm：由无实体存在 The Spectre 创造的猎杀领域，被绑架的罗布乐克人与地点在此进行无限循环的猎杀游戏；
 *  - Survivor 不是英雄——只是被困在领域中、拥有不同人生经验的平民；
 *  - Killer 为 CANON 威胁（可作遭遇参考），不实现对局玩法；
 *  - Spectre 为预留 Lore 接口（public_information + secret_information 字段就位，secret = reserved）；
 *  - 内容仅使用官方设定输入（lore_source=CANON），不创造原创世界设定。
 */
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'FORSAKEN';
const EXPERIENCE_KEY = 'forsaken';

// ── Forsaken World Rules（镜像 DOD World Rules 口径）──
const WORLD_RULES = [
  'Survivor 能力来自自身经历。',
  '普通幸存者不是英雄。',
  '生存优先于战斗。',
  '能力不能违反世界逻辑。',
  'AI 生成剧情必须符合普通人的视角。',
];

// ── Forsaken World Profile（官方设定）──
const FORSAKEN_WORLD_PROFILE = {
  id: 'forsaken',
  experience_key: EXPERIENCE_KEY,
  name: 'Forsaken Realm',
  description:
    'The Spectre 创造的黑暗领域：被绑架的罗布乐克人与地点被拉入其中，进行扭曲而残酷的猎杀游戏。',
  setting: 'Spectre\'s Realm（由无实体的存在创建，赤红色噩梦天幕下的猎杀领域）',
  era: '无限循环的猎杀游戏（每局随机地图，完成目标削弱时间）',
  factions: [
    {
      name: 'Survivors',
      role: 'civilian',
      description: '被困在 Spectre 领域中的平民，互相保护求生；在大厅生活，被拖入对局完成目标并躲避杀手。',
      lore_source: 'CANON',
    },
    {
      name: 'Killers',
      role: 'threat_concept',
      description: '被 Spectre 绑架的暴力存在，猎杀幸存者；进入对局前处于 Limbo 状态，重温生命中的关键时刻。',
      lore_source: 'CANON',
    },
    {
      name: 'Roblox Admins',
      role: 'faction',
      description: '罗布洛西亚的统治者（如 Builderman 负责建造），被 Spectre 逐一绑架。',
      lore_source: 'CANON',
    },
    {
      name: 'Hackers',
      role: 'faction',
      description: '拥有强大脚本、与管理员对抗的破坏者（如 007n7）。',
      lore_source: 'CANON',
    },
    {
      name: 'Family Home for The Reborn',
      role: 'faction',
      description: '崇拜 Spawn 符号的宗教，相信献身可获得重生（Two Time / Azure 曾追随）。',
      lore_source: 'CANON',
    },
    {
      name: 'The Spectre',
      role: 'reserved',
      description: '领域的创造者与主宰，无实体的存在；以他人的痛苦为食，操控幸存者与杀手的能力（nerf/buff）。',
      public_information:
        '用超自然力量将罗布乐克人和地点拉入领域；起源于 Roblox HQ 服务器中的一段腐败代码；操控对局。',
      secret_information: 'reserved（本阶段只创建 Lore 接口，不实现具体剧情）',
      lore_source: 'CANON',
    },
  ],
  known_threats: [
    {
      concept: 'Killer',
      description: '被 Spectre 绑架的暴力存在，猎杀幸存者。普通幸存者需要逃离、隐藏、合作，并利用自身能力生存。',
      resident_response: ['逃离', '隐藏', '合作', '利用自身能力生存'],
      implementation: 'reserved', // 不实现 Killer 对局 AI / 玩法
      // 官方已知的杀手（CANON：仅登记概念与动机；不实现玩法）
      known_entities: [
        { name: 'C00lkidd', pronouns: 'He/Him', motive: '007n7 的养子、team c00lkidd 领袖，靠 Walkspeed Override 与 Pizza Delivery 分而治之' },
        { name: 'Slasher', pronouns: 'Any/All', motive: '被 Necrobloxicon 复活的培根头士兵实验体，母亲的声音指引他' },
        { name: '1x1x1x1', pronouns: 'Any/All', motive: 'The Adversary，仇恨的具象化，源于 Shedletsky 接触 Necrobloxicon' },
        { name: 'John Doe', pronouns: 'He/Him', motive: '被故障代码寄生虫腐化的前 Roblox HQ 员工，Jane Doe 的丈夫' },
        { name: 'Guest 666', pronouns: 'Any/All', motive: '被诅咒的游客，曾是 Noob 的朋友，被 Forsaken 后成为嗜血野兽' },
        { name: 'Noli', pronouns: 'Mirror Pronouns', motive: '臭名昭著的 Roblox 黑客，视 Forsaken 为舞台，Void Star 持有者' },
        { name: 'Nosferatu', pronouns: 'He/Him', motive: '源自 Necrobloxicon 的吸血鬼，与 Spectre 达成交易进入领域' },
        { name: 'Azure', pronouns: 'He/They', motive: '被伴侣献祭、由 Spectre 复活的 Spawn Cult 成员，受控于活体帽子' },
      ],
    },
  ],
  civilian_life: {
    大厅: '被森林环绕的小岛，有木屋，幸存者与 NPC 在此生活',
    对局: '幸存者被拖入随机地图，完成目标并躲避杀手',
    杀手: '进入对局前处于 Limbo 状态，重温生命中的关键时刻',
    note: 'Survivor 不是英雄——只是被困在领域中、拥有不同人生经验的平民。',
  },
  world_rules: WORLD_RULES,
  government: {
    name: 'The Spectre',
    description: '领域的创造者与主宰，无实体的存在；以他人的痛苦为食。',
    public_information:
      '用超自然力量将罗布乐克人和地点拉入领域；操控幸存者与杀手的能力（nerf/buff）；起源于 Roblox HQ 服务器中的腐败代码。',
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
  const p = FORSAKEN_WORLD_PROFILE;
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
  return FORSAKEN_WORLD_PROFILE;
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
 * Survivor 与世界关联：该幸存者生活在 Spectre 领域的哪个侧面。
 * Background → civilian_life 场所提示（供 GM 叙事"他过去在领域里做什么"）。
 */
const BACKGROUND_LIFE_TIE = {
  'Lobby Resident': '大厅（日常起居）',
  'Admin Associate': '大厅与管理员据点（协理事务）',
  'Ex-Hacker': '领域边缘与系统暗区（曾破坏系统）',
  'Former Spawn Cultist': '重生信徒据点（曾追随 Spawn Cult）',
  Survivalist: '对局（逃生与求生）',
  Explorer: '领域各处（探索与寻路）',
};

function survivorWorldTie(background) {
  const profile = getWorldProfile();
  return {
    world: "The Spectre's Realm",
    era: profile ? profile.era : null,
    background,
    lifeTie: BACKGROUND_LIFE_TIE[background] || '领域（日常生活）',
    note: 'Survivor 不是英雄——只是被困在领域中、拥有不同人生经验的平民。',
  };
}

/** Forsaken World Rules 文本（AI Context 用）。 */
function worldRulesText() {
  return WORLD_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

module.exports = {
  SOURCE,
  EXPERIENCE_KEY,
  WORLD_RULES,
  FORSAKEN_WORLD_PROFILE,
  BACKGROUND_LIFE_TIE,
  ensureWorldProfileSeeded,
  getWorldProfile,
  listWorldProfiles,
  survivorWorldTie,
  worldRulesText,
};
