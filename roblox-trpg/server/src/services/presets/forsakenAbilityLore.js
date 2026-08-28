/**
 * Forsaken Ability Lore —— 镜像 dodAbilityLore.js。
 *
 * 目标：让 AI GM 理解 Forsaken 角色为什么拥有这些 Ability（= 人生经历 / 设定，
 * 不是魔法 / 技能系统）。每个 Survivor 的能力是其 CANON 固定设定，来源官方 Wiki。
 *
 * 纪律：
 *  - 不存 Cooldown / Damage / HP / SP 等战斗数值；只解释"为什么拥有"（人生经历/设定）；
 *  - owner 关联角色（Noob/Chance/Elliot/...），供 GM 按角色叙事；
 *  - category：survival / stealth / support / offensive / tech / mobility 等；
 *  - 不创造原创 Ability，全部来自官方 Wiki（lore_source=CANON）。
 */
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'FORSAKEN';

const ABILITY_EXPLANATION_RULE =
  'Forsaken 的 Ability 是角色 CANON 固定设定：解释该角色为什么拥有这种能力（过去的人生经历 / 设定），而不是描述技能效果或数值。';

// ── 官方 Ability Lore 条目（内容来自官方 Wiki；无战斗数值）──
const ABILITY_LORE_ENTRIES = [
  {
    id: 'noob_bloxy_cola',
    name: 'Bloxy Cola',
    owner: 'Noob',
    category: 'survival',
    core_trait: 'Food Survival',
    explaining_traits: ['Food Survival', 'Speed Training'],
    possible_background: ['Survivalist', 'Explorer'],
    lore_description:
      'Noob 是个贪吃的人，随身带着各种食物与饮料；喝下 Bloxy Cola 提神、加快脚步是它最熟悉的生活方式。',
    personality_connection: '贪吃又胆小，靠食物给自己打气，被吓得发抖却仍坚持向前。',
  },
  {
    id: 'noob_slateskin',
    name: 'Slateskin Potion',
    owner: 'Noob',
    category: 'survival',
    core_trait: 'Food Survival',
    explaining_traits: ['Food Survival'],
    possible_background: ['Survivalist'],
    lore_description:
      'Noob 随身带着各种稀奇古怪的食物道具，喝下 Slateskin 药水让身体像岩石一样结实，是它求生的土办法。',
    personality_connection: '胆小但韧性强，习惯用身边能找到的东西硬撑过去。',
  },
  {
    id: 'noob_ghostburger',
    name: 'Ghost Burger',
    owner: 'Noob',
    category: 'stealth',
    core_trait: 'Stealth Skill',
    explaining_traits: ['Stealth Skill', 'Food Survival'],
    possible_background: ['Explorer', 'Survivalist'],
    lore_description:
      'Noob 连幽灵汉堡都敢吃；吃了之后身体变得半透明，能悄悄溜过危险地带，是它一路躲藏逃命练出的本事。',
    personality_connection: '怂到极点反而不声不响——越是害怕，越懂得怎么不引人注意。',
  },
  {
    id: 'chance_coin_flip',
    name: 'Coin Flip',
    owner: 'Chance',
    category: 'luck',
    core_trait: 'Gambling Instinct',
    explaining_traits: ['Gambling Instinct', 'Risk Taking'],
    possible_background: ['Survivalist'],
    lore_description:
      'Chance 是个把身家性命押在硬币上的赌徒，靠抛硬币的运气和一点小把戏在险境里周旋。',
    personality_connection: '从容大胆、讲究排场，越危险越爱赌一把，对谁都客客气气却藏着机锋。',
  },
  {
    id: 'chance_one_shot',
    name: 'One Shot',
    owner: 'Chance',
    category: 'offensive',
    core_trait: 'Gambling Instinct',
    explaining_traits: ['Gambling Instinct', 'Weapon Familiarity'],
    possible_background: ['Survivalist'],
    lore_description:
      'Chance 随身带一把随时可能炸膛的老式燧发枪——他赌的就是这一发能不能命中，一如他赌自己的人生。',
    personality_connection: '把生死当成一场赌博，即使枪靠不住也从不慌张。',
  },
  {
    id: 'chance_reroll',
    name: 'Reroll',
    owner: 'Chance',
    category: 'luck',
    core_trait: 'Gambling Instinct',
    explaining_traits: ['Gambling Instinct'],
    possible_background: ['Survivalist'],
    lore_description:
      'Chance 不甘心既定的结果，总想再赌一次重来——它的人生就是不断重新下注。',
    personality_connection: '永不认输的赌徒心态，输了就再掷一次。',
  },
  {
    id: 'builderman_sentry',
    name: 'Sentry Construction',
    owner: 'Builderman',
    category: 'support',
    core_trait: 'Engineering Experience',
    explaining_traits: ['Engineering Experience', 'Administrative Access'],
    possible_background: ['Admin Associate'],
    lore_description:
      'Builderman 是罗布乐克最早的建造者与领袖，常年使用工具搭建，会快速架起哨兵来保护身边人。',
    personality_connection: '责任心强，总想亲手护住别人，弥补自己曾经忽视 bug 的过失。',
  },
  {
    id: 'builderman_dispenser',
    name: 'Dispenser Construction',
    owner: 'Builderman',
    category: 'support',
    core_trait: 'Engineering Experience',
    explaining_traits: ['Engineering Experience'],
    possible_background: ['Admin Associate'],
    lore_description:
      '凭借一手建造功夫，Builderman 能搭起补给器，为队友提供恢复——这是他照顾人的方式。',
    personality_connection: '温和可靠的长者，习惯用双手照顾身边所有人。',
  },
  {
    id: 'elliot_pizza_throw',
    name: 'Pizza Throw',
    owner: 'Elliot',
    category: 'support',
    core_trait: 'Cooking Skill',
    explaining_traits: ['Cooking Skill', 'Support Facility'],
    possible_background: ['Lobby Resident'],
    lore_description:
      'Elliot 在家族披萨店工作多年，最擅长做披萨；他把自己最拿手的东西扔给队友，用食物替他们疗伤打气。',
    personality_connection: '善良热心的服务者，永远把别人放在第一位，闲下来也乐意帮人。',
  },
  {
    id: 'elliot_rush_hour',
    name: 'Rush Hour',
    owner: 'Elliot',
    category: 'mobility',
    core_trait: 'Speed Training',
    explaining_traits: ['Speed Training', 'Support Facility'],
    possible_background: ['Lobby Resident'],
    lore_description:
      '常年送外卖、赶餐高峰让 Elliot 练就了一身脚程，能在危急关头飞快赶到需要帮助的人身边。',
    personality_connection: '风风火火却心思细腻，救人永远是第一优先。',
  },
  {
    id: '007n7_clone',
    name: 'Clone',
    owner: '007n7',
    category: 'tech',
    core_trait: 'Tech Knowledge',
    explaining_traits: ['Tech Knowledge', 'Hacking Experience'],
    possible_background: ['Ex-Hacker'],
    lore_description:
      '作为曾经的顶尖黑客，007n7 深谙脚本之道，能造出一个分身迷惑追兵、替自己挡一挡。',
    personality_connection: '改过自新后沉默寡言，只用自己最熟的黑客本事保护身边的人。',
  },
  {
    id: '007n7_c00lgui',
    name: 'c00lgui',
    owner: '007n7',
    category: 'tech',
    core_trait: 'Tech Knowledge',
    explaining_traits: ['Tech Knowledge'],
    possible_background: ['Ex-Hacker'],
    lore_description:
      '这套 c00lgui 是 007n7 年轻时用来搞破坏的老工具，如今被他用来快速脱身、躲开危险。',
    personality_connection: '把过去的"坏本事"变成了保护别人的手段，只求不再辜负儿子。',
  },
  {
    id: 'dusekkar_spawn_protection',
    name: 'Spawn Protection',
    owner: 'Dusekkar',
    category: 'support',
    core_trait: 'Magic Familiarity',
    explaining_traits: ['Magic Familiarity', 'Administrative Access'],
    possible_background: ['Admin Associate', 'Former Spawn Cultist'],
    lore_description:
      'Dusekkar 曾是罗布乐克管理员、深谙魔法，即便进入领域后魔力大减，仍能用残余的力量给队友套上护盾。',
    personality_connection: '睿智而寡言，知道很多却藏而不露，一心护住所有人平安回去。',
  },
  {
    id: 'dusekkar_plasma_beam',
    name: 'Plasma Beam',
    owner: 'Dusekkar',
    category: 'support',
    core_trait: 'Magic Familiarity',
    explaining_traits: ['Magic Familiarity'],
    possible_background: ['Admin Associate'],
    lore_description:
      'Dusekkar 能凝聚残存的魔力射出一道等离子光束，为队友加速或拖住逼近的威胁。',
    personality_connection: '沉稳大气的导师型人物，越危急越冷静。',
  },
  {
    id: 'g1337_block',
    name: 'Block',
    owner: 'Guest 1337',
    category: 'defensive',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training', 'Weapon Familiarity'],
    possible_background: ['Survivalist'],
    lore_description:
      'Guest 1337 是打过仗的老兵，习惯挺身而出、用身体替队友挡下攻击，受过伤也不改分毫。',
    personality_connection: '坚强可靠的守护者，为了别人可以一再牺牲自己。',
  },
  {
    id: 'g1337_charge',
    name: 'Charge',
    owner: 'Guest 1337',
    category: 'offensive',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training'],
    possible_background: ['Survivalist'],
    lore_description:
      '战场上的冲锋本能让他能一肩撞开逼近的威胁，为队友争取逃跑的空档。',
    personality_connection: '果敢刚毅，冲锋永远冲在最前面。',
  },
  {
    id: 'g1337_punch',
    name: 'Punch',
    owner: 'Guest 1337',
    category: 'offensive',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training', 'Weapon Familiarity'],
    possible_background: ['Survivalist'],
    lore_description:
      '老兵练就的铁拳，用来逼退靠得太近的威胁，护住身后的人。',
    personality_connection: '刚强而不鲁莽，出手都是为了让别人更安全。',
  },
  {
    id: 'taph_tripwire',
    name: 'Tripwire',
    owner: 'Taph',
    category: 'support',
    core_trait: 'Engineering Experience',
    explaining_traits: ['Engineering Experience', 'Stealth Skill'],
    possible_background: ['Explorer'],
    lore_description:
      'Taph 曾是炸毁违规体验的哑巴爆破专家，习惯布置绊线延缓威胁、提醒同伴。',
    personality_connection: '沉默寡言、只用手语交流，用布置精巧的机关默默护住大家。',
  },
  {
    id: 'taph_tripmine',
    name: 'Subspace Tripmine',
    owner: 'Taph',
    category: 'support',
    core_trait: 'Engineering Experience',
    explaining_traits: ['Engineering Experience'],
    possible_background: ['Explorer'],
    lore_description:
      '惯于摆弄爆炸物的 Taph 会设下亚空间地雷，既能拖住威胁也能在紧要关头制造转机。',
    personality_connection: '低调寡言，行动永远比言语更可靠。',
  },
  {
    id: 'twotime_dagger',
    name: 'Sacrificial Dagger',
    owner: 'Two Time',
    category: 'offensive',
    core_trait: 'Cult Lore',
    explaining_traits: ['Cult Lore', 'Stealth Skill'],
    possible_background: ['Former Spawn Cultist'],
    lore_description:
      '作为 Spawn Cult 的重生信徒，Two Time 惯用匕首在暗处行动，靠"献祭"换取重生的机会。',
    personality_connection: '偏执痴迷于礼赞其神，面上笑着，心里却藏着杀死同伴的黑暗秘密。',
  },
  {
    id: 'twotime_crouch',
    name: 'Crouch',
    owner: 'Two Time',
    category: 'stealth',
    core_trait: 'Stealth Skill',
    explaining_traits: ['Stealth Skill'],
    possible_background: ['Former Spawn Cultist'],
    lore_description:
      '习惯在暗处行事、潜行靠近目标，是 Two Time 从小就熟练的隐匿本事。',
    personality_connection: '悄无声息、神出鬼没，让人捉摸不透。',
  },
  {
    id: 'veeronica_vandalism',
    name: 'VANDALISM',
    owner: 'Veeronica',
    category: 'tech',
    core_trait: 'Tech Knowledge',
    explaining_traits: ['Tech Knowledge', 'Special Habit'],
    possible_background: ['Explorer'],
    lore_description:
      '爱滑板的叛逆机器人 Veeronica 爱用喷漆在墙上留下涂鸦，既是表达自我，也悄悄布下自己的活动区域。',
    personality_connection: '叛逆独立、我行我素，宁愿靠自己也不愿欠人情。',
  },
  {
    id: 'veeronica_sk8',
    name: 'Sk8',
    owner: 'Veeronica',
    category: 'mobility',
    core_trait: 'Speed Training',
    explaining_traits: ['Speed Training'],
    possible_background: ['Explorer'],
    lore_description:
      'Veeronica 视滑板如命，能在自己的涂鸦区域里滑行耍特技，敏捷地躲开逼近的威胁。',
    personality_connection: '热情张扬，用速度和风格表达自己的存在。',
  },
  {
    id: 'martialartist_combo',
    name: 'Combo',
    owner: 'Martial Artist',
    category: 'offensive',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training'],
    possible_background: ['Survivalist'],
    lore_description:
      'Martial Artist 是练家子，身手矫健，能用一连串拳脚把靠太近的威胁逼退。',
    personality_connection: '身手矫健、自信果决，是队伍里靠得住的近战担当。',
  },
];

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
    owner: row.owner,
    category: row.category,
    core_trait: row.core_trait,
    explaining_traits: parseJson(row.explaining_traits, []),
    possible_background: parseJson(row.possible_background, []),
    lore_description: row.lore_description,
    personality_connection: row.personality_connection,
  };
}

/** 幂等播种 forsaken_abilities_lore（内容可随设定输入更新，按 id 覆盖）。 */
function ensureAbilityLoreSeeded() {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO forsaken_abilities_lore
       (id, name, source, owner, category, core_trait, explaining_traits, possible_background,
        lore_description, personality_connection)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, source = excluded.source, owner = excluded.owner, category = excluded.category,
       core_trait = excluded.core_trait, explaining_traits = excluded.explaining_traits,
       possible_background = excluded.possible_background, lore_description = excluded.lore_description,
       personality_connection = excluded.personality_connection`
  );
  for (const e of ABILITY_LORE_ENTRIES) {
    ins.run(
      e.id,
      e.name,
      e.source || SOURCE,
      e.owner,
      e.category,
      e.core_trait,
      JSON.stringify(e.explaining_traits || []),
      JSON.stringify(e.possible_background || []),
      e.lore_description,
      e.personality_connection
    );
  }
  return ABILITY_LORE_ENTRIES.length;
}

/** 读取单个 Ability Lore（按 name 或 id）。 */
function getAbilityLore(key) {
  if (!key) return null;
  ensureAbilityLoreSeeded();
  const row = getDb().prepare('SELECT * FROM forsaken_abilities_lore WHERE name = ? OR id = ?').get(key, String(key).toLowerCase());
  return rowToLore(row);
}

/** 全部 Ability Lore（按 id 排序）。 */
function listAbilityLore() {
  ensureAbilityLoreSeeded();
  return getDb().prepare('SELECT * FROM forsaken_abilities_lore ORDER BY id').all().map(rowToLore);
}

/** 按角色列出 Ability Lore（供 GM 按角色叙事）。 */
function listByOwner(owner) {
  if (!owner) return [];
  ensureAbilityLoreSeeded();
  return getDb().prepare('SELECT * FROM forsaken_abilities_lore WHERE owner = ? ORDER BY id').all(owner).map(rowToLore);
}

module.exports = {
  SOURCE,
  ABILITY_EXPLANATION_RULE,
  ABILITY_LORE_ENTRIES,
  ensureAbilityLoreSeeded,
  getAbilityLore,
  listAbilityLore,
  listByOwner,
};
