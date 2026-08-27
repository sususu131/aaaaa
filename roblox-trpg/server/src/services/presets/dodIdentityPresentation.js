/**
 * Die of Death 阶段21：Civilian Identity Presentation System。
 *
 * 目标：让 AI GM 根据 Civilian 的背景和 Ability 生成合理的人物表现（外观/举止/他人观察）。
 *
 * 设定纪律（必须遵守）：
 *  - 外观不是装备：不是"穿戴装备获得技能"，而是 Ability 反映这个人的经历
 *    （Caretaker→干净服饰与急救用品 = 医疗背景；BonusPad→工具与工作服 = 工程经验；
 *    Revolver→射击装备与安保风格 = 枪械训练）。无属性加成、无穿戴系统；
 *  - NPC 识别纪律：其他 NPC 看到 Civilian 时【不能知道具体 Ability 名称】，
 *    只能通过表现推测（错："你是Caretaker玩家"；对："你的医疗经验看起来很明显。"）；
 *  - Ability 影响人格倾向（Caretaker→Selfless/Calm/Protective；Punch→Confident/Aggressive/
 *    Competitive；Cloak→Careful/Secretive/Avoidant）——只影响叙事，不改变数值；
 *  - 限制：禁止超级英雄外观/职业战士模板/固定角色——Civilian 始终是普通 Robloxia 居民；
 *  - 生成流：Background → Traits → Ability → Appearance → Personality。
 */
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'DIE_OF_DEATH';

/** NPC 识别规则（写入 AI Context / SYSTEM_RULES）。 */
const NPC_IDENTIFICATION_RULE =
  'NPC（与玩家）不能直呼他人的 Ability 名称（"你是Caretaker玩家"是错误的）；只能通过观察到的表现推测（如"你的医疗经验看起来很明显。"）。';

/** 外观总规则：外观是人生经历的可视化，不是装备（无属性/无数值/无穿戴加成）。 */
const APPEARANCE_RULE =
  '外观不是装备：Ability 反映这个人的经历（视觉表现来自过去的人生，不提供任何数值或穿戴加成）。';

/** 限制规则（禁止英雄化）。 */
const IDENTITY_LIMIT_RULE =
  '禁止超级英雄外观/职业战士模板/固定角色：Civilian 始终保持普通 Robloxia 居民的样子。';

// ── Ability → 外观 Lore（视觉表现 + 经历解释 + NPC 观察语 + 人格倾向）──
// 字段全部是设定性描述，无任何数值。
const ABILITY_APPEARANCE = {
  Punch: {
    visual: ['结实的体格', '缠着护布的拳头', '便于活动的运动装'],
    lore: '这个人拥有格斗训练与体育经历。',
    npcObservation: '你的一身腱子肉和随手握拳的习惯，一看就是练过的。',
    personalityTendencies: ['Confident', 'Aggressive', 'Competitive'],
  },
  Caretaker: {
    visual: ['医疗相关物品', '干净服饰', '急救用品'],
    lore: '这个人拥有医疗背景。',
    npcObservation: '你的医疗经验看起来很明显。',
    personalityTendencies: ['Selfless', 'Calm', 'Protective'],
  },
  Revolver: {
    visual: ['射击相关装备', '安全人员风格'],
    lore: '这个人过去接触枪械训练。',
    npcObservation: '你检查装备的动作干净利落，像是受过安全训练的人。',
    personalityTendencies: ['Careful', 'Disciplined', 'Watchful'],
  },
  Hotdog: {
    visual: ['随身保温袋', '沾着酱汁的围裙', '便携餐具'],
    lore: '这个人保留着亲手准备食物的习惯。',
    npcObservation: '你身上总带着食物的香气，口袋里鼓鼓囊囊像装着零食。',
    personalityTendencies: ['Easygoing', 'Comforting'],
  },
  Pie: {
    visual: ['烘焙用手套', '沾面粉的围裙', '打包点心的纸盒'],
    lore: '这个人拥有烹饪与烘焙经验。',
    npcObservation: '你袖口的面粉和身上的甜香，说明你常下厨房。',
    personalityTendencies: ['Warm', 'Practical'],
  },
  BonusPad: {
    visual: ['工程工具', '建筑用品', '工作服'],
    lore: '这个人拥有建造和工程经验。',
    npcObservation: '你腰间的工具和那身工作服，一看就是干工程活的。',
    personalityTendencies: ['Practical', 'Creative', 'Cooperative'],
  },
  Dash: {
    visual: ['轻便跑鞋', '利落的束袖装束'],
    lore: '这个人长期进行奔跑与体育训练。',
    npcObservation: '你站姿放松、重心随时可动，跑起来一定很快。',
    personalityTendencies: ['Energetic', 'Alert'],
  },
  Block: {
    visual: ['厚实耐磨的外套', '宽厚的肩膀', '旧护具磨出的痕迹'],
    lore: '这个人接受过防护与体能训练。',
    npcObservation: '你习惯站在人群靠外的一侧，肩膀宽得让人安心。',
    personalityTendencies: ['Steady', 'Protective', 'Brave'],
  },
  Flashlight: {
    visual: ['户外背包', '随身手电', '徒步靴'],
    lore: '这个人常年在户外徒步探索。',
    npcObservation: '你的登山靴和随手一亮的手电，说明你走过不少夜路。',
    personalityTendencies: ['Curious', 'Easygoing', 'Observant'],
  },
  Adrenaline: {
    visual: ['轻便行装', '磨旧的跑鞋', '随身少物的口袋'],
    lore: '这个人早已习惯受惊即逃的生活。',
    npcObservation: '你对声响反应极快，像被吓过很多次的人。',
    personalityTendencies: ['Jumpy', 'QuickWitted'],
  },
  'Banana Peel': {
    visual: ['装着古怪小装置的口袋', '憋笑的表情'],
    lore: '这个人是个爱开玩笑的捣蛋鬼。',
    npcObservation: '你口袋里露出半截奇怪的发射器，脸上挂着憋不住的坏笑。',
    personalityTendencies: ['Playful', 'Witty'],
  },
  Cloak: {
    visual: ['深色斗篷', '安静的站姿', '少言的目光'],
    lore: '这个人了解并随身携带那件实验科技斗篷。',
    npcObservation: '你那件不像本地裁缝能做出来的斗篷，让人不太好捉摸。',
    personalityTendencies: ['Careful', 'Secretive', 'Avoidant'],
  },
  Taunt: {
    visual: ['夸张显眼的服饰', '随身的小喇叭或道具'],
    lore: '这个人习惯成为注意力中心。',
    npcObservation: '你穿得引人注目，说话总想逗出点反应。',
    personalityTendencies: ['Bold', 'Provocative'],
  },
  Bugle: {
    visual: ['随身号角', '打理整齐的乐器包'],
    lore: '这个人会吹奏号角、习惯鼓舞身边的人。',
    npcObservation: '你背上那把号角擦得锃亮，一看就被好好珍视。',
    personalityTendencies: ['Encouraging', 'Sociable'],
  },
};

/** Background → 穿着风格（不是装备；普通居民的日常穿着倾向）。 */
const BACKGROUND_CLOTHING = {
  Engineer: '耐磨实用的工作服，口袋里别着卷尺或笔',
  Medic: '洗得发白却干净的便装，随身收纳整齐的杂物包',
  Athlete: '便于活动的运动装束，脚上的鞋磨损得很快',
  Security: '整洁利落的安保风格外套，随身物品摆放规整',
  Cook: '常围一条围裙，袖口带着下厨的痕迹',
  Artist: '沾着颜料或黏土的随性便装',
};

/** 人格 → 外向表现（NPC 能观察到的举止）。 */
const PERSONALITY_EXPRESSION = {
  Brave: '遇险时下意识向前半步，挡在别人身前',
  Careful: '进门先看出口，摸过的地方都要回头看一眼',
  Selfless: '分东西时总把自己排到最后',
  Practical: '说话直奔重点，手里总在收拾有用的东西',
  Creative: '爱盯着寻常物件出神，嘴里念叨新点子',
  Nervous: '听到响动就停下手，眼睛快速扫过四周',
};

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

/** 单个 Ability 的外观档案（读取）。 */
function abilityAppearance(abilityKey) {
  return ABILITY_APPEARANCE[abilityKey] || null;
}

/**
 * 生成 Civilian 身份表现档案（Background → Traits → Ability → Appearance → Personality 的后两步）。
 * 输入已生成的背景/能力/人格；输出五字段落库结构。纯设定描述，无任何数值。
 */
function buildIdentityProfile({ background, abilities, personality }) {
  const abilityKeys = (abilities || []).filter((k) => ABILITY_APPEARANCE[k]);
  const appearanceTraits = [];
  const visualMarkers = [];
  const abilitySignatures = [];
  const tendencies = [];
  for (const key of abilityKeys) {
    const ap = ABILITY_APPEARANCE[key];
    for (const v of ap.visual) if (!appearanceTraits.includes(v)) appearanceTraits.push(v);
    abilitySignatures.push({ ability: key, observation: ap.npcObservation });
    for (const t of ap.personalityTendencies) if (!tendencies.includes(t)) tendencies.push(t);
    // 视觉标记：取每能力最具辨识度的一项（首个视觉表现）作为远观标记
    if (ap.visual[0] && !visualMarkers.includes(ap.visual[0])) visualMarkers.push(ap.visual[0]);
  }
  const clothing = BACKGROUND_CLOTHING[background] || '普通 Robloxia 居民的日常穿着';
  const personalityExpression = [];
  for (const word of personality || []) {
    if (PERSONALITY_EXPRESSION[word] && !personalityExpression.includes(PERSONALITY_EXPRESSION[word])) {
      personalityExpression.push(PERSONALITY_EXPRESSION[word]);
    }
  }
  if (tendencies.length) {
    personalityExpression.push(`经历带来的倾向：${tendencies.join('、')}（只影响举止神态，不改变能力）`);
  }
  return {
    appearance_traits: appearanceTraits,
    clothing_style: clothing,
    visual_markers: visualMarkers,
    personality_expression: personalityExpression,
    ability_signatures: abilitySignatures,
  };
}

/** 保存/覆盖身份表现档案（每玩家单行，幂等）。 */
function saveIdentityProfile(playerId, profile) {
  const db = getDb();
  db.prepare(
    `INSERT INTO civilian_identity_profile
       (player_id, appearance_traits, clothing_style, visual_markers, personality_expression, ability_signatures, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET
       appearance_traits = excluded.appearance_traits, clothing_style = excluded.clothing_style,
       visual_markers = excluded.visual_markers, personality_expression = excluded.personality_expression,
       ability_signatures = excluded.ability_signatures, updated_at = datetime('now')`
  ).run(
    playerId,
    JSON.stringify(profile.appearance_traits),
    profile.clothing_style,
    JSON.stringify(profile.visual_markers),
    JSON.stringify(profile.personality_expression),
    JSON.stringify(profile.ability_signatures),
    SOURCE
  );
  return getIdentityProfile(playerId);
}

/** 为已有 Civilian 补建身份表现档案（幂等；读取 civilian_instance 生成）。 */
function ensureIdentityProfile(playerId) {
  const db = getDb();
  const existing = getIdentityProfile(playerId);
  const civ = db.prepare('SELECT * FROM civilian_instance WHERE player_id = ?').get(playerId);
  if (existing && civ) return existing;
  if (!civ) return null;
  const profile = buildIdentityProfile({
    background: civ.background,
    abilities: parseJson(civ.abilities, []),
    personality: parseJson(civ.personality && civ.personality !== '[]' ? civ.personality : civ.traits, []),
  });
  return saveIdentityProfile(playerId, profile);
}

/** 读取身份表现档案（结构化视图）。 */
function getIdentityProfile(playerId) {
  const row = getDb().prepare('SELECT * FROM civilian_identity_profile WHERE player_id = ?').get(playerId);
  if (!row) return null;
  return {
    playerId,
    appearanceTraits: parseJson(row.appearance_traits, []),
    clothingStyle: row.clothing_style,
    visualMarkers: parseJson(row.visual_markers, []),
    personalityExpression: parseJson(row.personality_expression, []),
    abilitySignatures: parseJson(row.ability_signatures, []),
    source: row.source,
  };
}

module.exports = {
  SOURCE,
  NPC_IDENTIFICATION_RULE,
  APPEARANCE_RULE,
  IDENTITY_LIMIT_RULE,
  ABILITY_APPEARANCE,
  BACKGROUND_CLOTHING,
  PERSONALITY_EXPRESSION,
  abilityAppearance,
  buildIdentityProfile,
  saveIdentityProfile,
  ensureIdentityProfile,
  getIdentityProfile,
};
