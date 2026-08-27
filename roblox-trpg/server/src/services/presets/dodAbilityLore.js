/**
 * Die of Death 阶段19：Civilian Ability Lore Integration。
 *
 * 目标：让 AI GM 理解 DOD 世界中 Civilian【为什么】拥有这些 Ability。
 *
 * 设定纪律（必须遵守）：
 *  - Ability 不是魔法：Ability 代表 Civilian 过去的人生经历（格斗训练/医疗知识/枪械训练/工程经验……）；
 *    解释“为什么拥有”，绝不解释为“获得技能/魔法/超能力/凭空召唤”。
 *  - Lore 数据 ≠ 游戏技能系统：本模块不存任何战斗数值字段（无 Cooldown/Damage/HP/SP）、
 *    不做技能数值、不做技能 UI —— 只是 Lore 解释数据。
 *  - Background 只提高概率（权重），不是固定绑定：任何 Civilian 都可能获得任何 Ability（无职业锁定）。
 *  - Trait 解释：每个 Ability 的出现由 Trait 解释（如 Caretaker ← Medical Knowledge/Empathy/First Aid Experience）。
 *  - Synergy 只保存候选（synergy_candidates / possible_synergy），本阶段不实现任何 Synergy 逻辑。
 *  - 内容来自阶段19 设定输入 + 既有官方设定，不创造原创世界观。
 */
const { getDb } = require('@roblox-trpg/database');

const SOURCE = 'DIE_OF_DEATH';

/** Ability 解释总规则（写入 AI Context / 预设）。 */
const ABILITY_EXPLANATION_RULE =
  'Ability 不是魔法，代表 Civilian 过去的人生经历：解释“为什么拥有这种能力”（医疗知识/枪械训练/工程经验/身体训练等），而不是描述技能效果或数值。';

/** 关联背景的权重加成（只是概率提高，非锁定；其余背景保持基础权重 1）。 */
const LINKED_BACKGROUND_WEIGHT = 3;
const BASE_ABILITY_WEIGHT = 1;

// ── Ability Lore 目录（阶段19 设定输入 + 官方 Library 合集 2026-08-28）──
// 字段与 dod_abilities_lore 表一致；synergy 条目仅为结果登记（不实现逻辑）。
// 共 18 条：14 基础 Ability（含 Flashlight）+ 4 官方 Synergy 结果登记
// （CarePad/Loveshot/SweetTooth/Noisemaker）。library_excerpt 仅存官方 Library
// 的 Traits（性格/背景）段落——Functionality 段的使用机制与数值一律不入库。
const ABILITY_LORE_ENTRIES = [
  {
    id: 'punch',
    name: 'Punch',
    source: SOURCE,
    category: 'physical',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training'],
    possible_background: ['Athlete'],
    lore_description:
      '该Civilian拥有优秀身体素质，可能来自格斗训练、体育经历或长期锻炼；好斗的倾向让他们机敏且自尊心强，危急时刻凭身体本能保护自己与他人。',
    personality_connection:
      '自尊心强、街头聪明；表面疏远人群、固守小圈子，实则勇敢而不愚蠢——愿以自己的力量换取 Block 居民的安全保障或 Caretaker 居民的治疗；许多 Punch 居民已走出不良少年阶段，用那段经历学到的经验帮助他人。',
    synergy_candidates: [],
    synergy_result_of: [],
    library_excerpt:
      'Punch 平民往往疏远人群，固守自己的小圈子，他们危险的背景让很多人不愿过于接近，不过也有许多例外。虽然他们可能粗鲁无礼，但他们知道自己的位置，如果团队中有像 Block 平民这样的人担任领导角色，他们愿意成为团队一员——他们更偏向勇敢，但并不愚蠢。' +
      '他们主要只听从那些能给他们提供帮助的人，比如 Block 平民提供的安全保障，或 Caretaker 平民的治疗，用自己的力量换取他们的特殊能力。在许多不同的领域和专业中都很可能看到 Punch 平民，因为大多数 Punch 平民已经学会了从不良少年阶段成长，利用那段经历学到的经验来帮助他人。',
  },
  {
    id: 'caretaker',
    name: 'Caretaker',
    source: SOURCE,
    category: 'medical',
    core_trait: 'Medical Knowledge',
    explaining_traits: ['Medical Knowledge', 'Empathy', 'First Aid Experience'],
    possible_background: ['Medic'],
    lore_description:
      '该Civilian拥有医疗知识与照顾他人的经验；许多人在健康领域名列前茅、经多年训练才有今天的水准，能包扎伤口、判断伤情、在混乱中照护同伴。',
    personality_connection:
      '聪明且训练有素，能克服恐惧、把他人放在自己之前；深切关心团队，每倒下一名队友，维持其余人的难度就增加一分，因此常需做艰难的分流抉择——他们最不希望被队友视为粗心大意。',
    synergy_candidates: [
      { with: 'BonusPad', result: 'CarePad' },
      { with: 'Revolver', result: 'Loveshot' },
    ],
    synergy_result_of: [],
    library_excerpt:
      '每种其他类型的平民都知道自己的 Caretaker 平民有多重要，愿意冒着生命危险来保护他们和治疗能力，Block、Revolver 和 Punch 尤其注重保护他们的 Caretaker 朋友，让他们可以包扎许多伤口，使团队存活时间远超其他情况。' +
      '同样，Caretaker 平民深切关心自己的团队，每倒下一个队友，维持其他人的难度就增加一分。他们常常需要选择哪些人可以在没有治疗的情况下活得更久，或者尝试协调多人聚在一起，以便一次药水治疗所有人。考虑到他们工作的所有付出，以及保持队友存活的重要性，他们最不希望被看到的就是粗心大意。',
  },
  {
    id: 'revolver',
    name: 'Revolver',
    source: SOURCE,
    category: 'firearms',
    core_trait: 'Weapon Familiarity',
    explaining_traits: ['Weapon Familiarity', 'Marksmanship', 'Firearms Training'],
    possible_background: ['Security'],
    lore_description:
      '该Civilian拥有枪械训练、射击经验或安全职业背景（退伍军人、警官、法外之徒或射击场的老手）；懂得安全用枪，面对威胁时保持职业冷静。',
    personality_connection:
      '警惕、负责，习惯守护身边人的安全；任何形式的失败都会对他们造成沉重打击，因此深知生命脆弱、总是试图走在前面一步；与 Block、BonusPad 和 Caretaker 居民相处极好，连 Taunt 居民也喜欢他们——但他们绝不参与 Taunt 的把戏。',
    synergy_candidates: [{ with: 'Caretaker', result: 'Loveshot' }],
    synergy_result_of: [],
    library_excerpt:
      '与 Block 平民类似，Revolver 平民通常来自训练背景，要么是退伍军人、警官、法外之徒，要么是在射击场有大量经验的人。他们落入坏人手中会很危险，但许多人愿意帮助做正确的事，为无辜者提供掩护。' +
      '他们与 Block、BonusPad 和 Caretaker 平民相处得非常好，能够与许多其他人闲聊和友好相处，甚至在 Taunt 平民眼中很受欢迎——不过他们知道最好不要参与 Taunt 的把戏。任何形式的失败都会对 Revolver 平民造成沉重打击，但他们从自己的工作中知道生命是多么脆弱，总是试图走在前面一步。',
  },
  {
    id: 'hotdog',
    name: 'Hotdog',
    source: SOURCE,
    category: 'culinary',
    core_trait: 'Cooking Skill',
    explaining_traits: ['Cooking Skill', 'Special Habit'],
    possible_background: ['Cook'],
    lore_description:
      '该Civilian拥有烹饪经验与特殊习惯，新陈代谢极快——进食既是生活习惯，也是恢复元气的生存智慧；频繁进食让他们体型变大、更能承受冲击，足以成为拖延时间的干扰。',
    personality_connection:
      '常被误解为懒惰的贪吃者，即便还拥有其他特长也少有公开的友谊——除非用行动证明自己能为团队出力；实际上拥有惊人的职业道德，在未被选中部署时会坚持锻炼减肥；与 Pie 居民因热爱美食而投缘。',
    synergy_candidates: [{ with: 'Pie', result: 'SweetTooth' }],
    synergy_result_of: [],
    library_excerpt:
      'Hotdog 平民并不被看好，许多人视他们为懒惰的贪吃者，即使他们可能还拥有其他特质如 Revolver 或 Block。虽然很多人容忍他们，但很少有人建立公开的友谊，除非他们之前已经是某个小团体的一员，或者做了某些特别的事来证明他们能为团队出力。' +
      '不过，大多数人都惊讶于他们能承受多少伤害而不倒下，有时足以成为拖延时间的干扰，等待救援到来。他们还拥有惊人的职业道德，在未被选中部署时经常锻炼来减肥。',
  },
  {
    id: 'pie',
    name: 'Pie',
    source: SOURCE,
    category: 'culinary',
    core_trait: 'Cooking Skill',
    explaining_traits: ['Cooking Skill'],
    possible_background: ['Cook'],
    lore_description:
      '该Civilian多为厨师、糕点师，拥有烹饪与准备食物的经验；习惯带自制点心与认识的人分享，紧急时也能把点心当投射物干扰、迟滞攻击者。',
    personality_connection:
      '热爱各种形式的烹饪、是个美食家，对很多人非常友好——只要别严厉批评他们的厨艺；与 Hotdog 居民尤其投缘；他们的存在能像 Bugle 一样提振在场所有人的士气，哪怕是 Block 这样的居民。',
    synergy_candidates: [{ with: 'Hotdog', result: 'SweetTooth' }],
    synergy_result_of: [],
    library_excerpt:
      '如前所述，Pie 平民热爱各种形式的烹饪，通常是个美食家，对很多人非常友好——只要你不严厉批评他们的厨艺。' +
      '他们几乎随处可见，尤其与 Hotdog 平民和 SweetTooth 平民相处得更好，因为他们都热爱美食。他们的存在类似于 Bugle 平民，能提振所有在场者的士气，哪怕是像 Block 平民这样的人。',
  },
  {
    id: 'bonuspad',
    name: 'BonusPad',
    source: SOURCE,
    category: 'engineering',
    core_trait: 'Engineering Experience',
    explaining_traits: ['Engineering Experience', 'Support Facility'],
    possible_background: ['Engineer'],
    lore_description:
      '该Civilian拥有工程能力、建筑经验与创造辅助工具的能力，头脑胜过蛮力，能建造精巧的机械辅助装置帮同伴脱困；装置并不算坚固，被破坏后需要凭急智重建。',
    personality_connection:
      '乐于协作，是天生的协调者与团队领袖人选；不强壮、常需后援，但总能看到其他居民最好的一面，善于把别人的弱点转化为生存优势（比如欣赏 Banana Peel 与 Hotdog 居民）；弱点是巨大压力下容易崩溃，被单独针对时缺乏自保手段。',
    synergy_candidates: [{ with: 'Caretaker', result: 'CarePad' }],
    synergy_result_of: [],
    library_excerpt:
      'BonusPad 平民非常乐于协作，是非常出色的协调者或团队领袖人选。他们不是最强壮的，常常需要后援来应对杀手。虽然许多人嫌弃他们，但 BonusPad 平民能欣赏一些别人眼中是缺点的特性，比如 Banana Peel 或 Hotdog 平民。' +
      'BonusPad 平民与所有这些人都相处得不错，唯一通常难以说服来帮忙的是 Taunt 平民，因为他们常常只顾自己。无论如何，他们总能看到其他平民最好的一面，总是想着如何把别人的弱点转化为生存的优势。他们自身最大的缺点是：在巨大压力下容易崩溃瓦解，一旦被单独针对就没有真正的自卫手段——一个加速垫的耐用程度，全看建造者脑子转得够不够快。',
  },
  {
    id: 'dash',
    name: 'Dash',
    source: SOURCE,
    category: 'mobility',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training'],
    possible_background: ['Athlete'],
    lore_description:
      '该Civilian在人群中非常普通、并不特别，但敏捷度高于平均水平；快速移动的能力来自体育训练、长期奔逃的生存经验或旺盛的新陈代谢，代价是体力消耗得很快。',
    personality_connection:
      '接地气、平易近人，是各类居民中最"标准"的一类；常与 Adrenaline 居民互相赛跑取乐，其敏捷也常与 Hotdog 居民的旺盛食欲相伴出现。',
    synergy_candidates: [],
    synergy_result_of: [],
    library_excerpt:
      '如前所述，Dash 平民非常常见，可能与其他常见特征重叠，比如与 Adrenaline 平民的敏捷来自不断地逃跑，或者与 Hotdog 平民有关——在进食前后有巨大胃口，通过频繁跑步利用新陈代谢快速燃烧卡路里。' +
      '不过，Dash 平民比许多人更接地气，与其他类型的平民相比更平易近人和标准。',
  },
  {
    id: 'block',
    name: 'Block',
    source: SOURCE,
    category: 'defensive',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training', 'Engineering Experience'],
    possible_background: ['Engineer', 'Security'],
    lore_description:
      '该Civilian拥有防护意识与工事经验，身披盔甲、以坚韧著称，来自老兵的训练或常年健身举重的体格；勇敢地常驻前线，懂得挡在危险与无助者之间。',
    personality_connection:
      '外表冷漠、令人生畏，盔甲背后其实友善和蔼；尊重所有类型的居民，与 Punch、Caretaker 尤其相处融洽——但尊重有底线，对不自量力的挑衅者绝不客气。',
    synergy_candidates: [],
    synergy_result_of: [],
    library_excerpt:
      '许多 Block 平民外表冷漠、令人生畏，盔甲让很多人不敢靠近，但许多尝试建立友谊的人很快会发现，盔甲背后他们是多么友善和蔼。' +
      '许多 Block 平民出身于老兵背景，接受过专注与坚韧的训练，无论面对什么威胁。有些是天生的健身者或举重选手，拥有更强壮的身体来辅助格挡。' +
      'Block 平民对所有其他类型的平民都非常尊重，尤其与 Gunslinger、Punch 和 Caretaker 相处融洽。这种尊重是有底线的——值得注意的是，Taunt 平民经常试图挑衅 Block 平民，这些遭遇的结果可想而知，往往以 Taunt 平民趴在地上、被彻底打晕告终，因为他们太不自量力。',
  },
  {
    // 官方 Library（CANON）：Flashlight 居民来自各种背景，多数热爱徒步与探索；
    // 不少是向导或从事户外工作，偶有技工/水管工；方向感极佳，是导航者与组织者（不是战斗人员）。
    // 红线：使用机制（光锥/减速/闪光/治疗数值等）属于游戏玩法 —— 不存入 Lore，不实现。
    id: 'flashlight',
    name: 'Flashlight',
    source: SOURCE,
    category: 'exploration',
    core_trait: 'Outdoor Experience',
    explaining_traits: ['Outdoor Experience', 'Navigation'],
    possible_background: [], // 官方 Library："wide variety, from lots of different backgrounds" —— 无背景锁定
    lore_description:
      '该Civilian拥有徒步与户外探索的经历（远足/露营/向导/野外工作），习惯随身携带手电等装备；方向感极佳，熟悉黑暗与野外环境，是队伍中的向导与探路人。',
    personality_connection:
      '热爱冒险与探索，向往最深的丛林与最高的山峰；不是战斗人员，习惯走最熟悉的路线，善于用闲聊与趣闻安抚、组织同伴——是导航者与组织者，而非领袖或战士。',
    synergy_candidates: [], // 无官方 Synergy 数据，不虚构
    synergy_result_of: [],
    library_excerpt:
      'Flashlight civilians come in a wide variety, from lots of different backgrounds, though most simply, they enjoy hiking and general exploration. ' +
      'Many have a keen sense of adventure and wonder throughout their world, and wish to see into the darkest jungles and tallest peaks of the region. ' +
      'Though none of them are exactly fighters, they tend to stick to the road most traveled, rarely traveling off course unless they see something cool. ' +
      'While typically unhelpful during scuffles, they are always nice to have around as navigators. ' +
      'A good amount of Flashlight civilians are tour guides or otherwise work in nature to some extent, though there is the occasional mechanic or plumber amongst them as well. ' +
      'They are typically very skilled with their sense of direction, and are good at directing people on where to go to get to their destination. ' +
      'They have a decent understanding on how to manage other civilians with talking or fun facts, though ultimately are not considered a leader role; ' +
      'they are best suited as organizers or preparation, and are more or less required for parties of civilians exploring outside of a bunker.',
  },
  {
    // 官方 Library（2026-08-28 合集）：Adrenaline 居民容易受惊、靠爆发速度逃生后体力透支；
    // 背景普通（普通工作普通生活）；与 Dash 赛跑、是 Block 的粉丝、讨厌 Banana Peel/Taunt 的恶作剧。
    id: 'adrenaline',
    name: 'Adrenaline',
    source: SOURCE,
    category: 'mobility',
    core_trait: 'Physical Training',
    explaining_traits: ['Physical Training'],
    possible_background: [], // 官方 Library：背景通常并不显眼——普通平民、普通工作
    lore_description:
      '该Civilian拥有长期"受惊即逃"练出的反应与体能：容易被声响惊动，能在几秒内爆发出远超平常的移动速度，随后体力透支、被迫停下喘息恢复。',
    personality_connection:
      '友善外向但有点胆小，总是把自己放在第一位；容易被混乱的环境压垮，看到危险的第一反应就是逃跑；与 Dash 居民互相赛跑取乐，是 Block 居民的粉丝（Block 能拦住威胁给他们找掩护的时间），讨厌 Banana Peel 与 Taunt 居民的恶作剧——他们正是最容易受惊吓的"好欺负"对象。',
    synergy_candidates: [],
    synergy_result_of: [],
    library_excerpt:
      '许多拥有此特性的平民非常友善外向，虽然有点胆小，总是把自己放在第一位。他们容易被环境压垮，在局势过于混乱时退缩，很可能在看到杀手的第一时间就跑路。' +
      '拥有 Adrenaline 特性的平民背景通常并不显眼，他们一般只是普通平民，做着普通的工作，只想着过好自己的一天。' +
      '他们与拥有「Dash」特性的平民相处得非常好，没事的时候经常互相赛跑取乐。他们也是「Block」平民的粉丝，因为 Block 平民能拦住威胁，给他们更多时间找掩护。除了尊重 BonusPad / Caretaker 平民之外，他们绝对不喜欢 Banana Peel 平民或 Taunt 平民——那些人总喜欢吓唬别人寻开心，而 Adrenaline 平民正是最容易受惊吓的"好欺负"对象。',
  },
  {
    // 官方 Library：Banana Peel 居民是纯粹的捣蛋鬼（笑话/双关/挖苦），有"喜剧效果香蕉皮"小装置；
    // 与 Taunt 为伍但懂得界限；与 Bugle 同有表演/戏剧背景。
    id: 'banana_peel',
    name: 'Banana Peel',
    source: SOURCE,
    category: 'trap',
    core_trait: 'Special Habit',
    explaining_traits: ['Special Habit', 'Engineering Experience'], // 恶作剧习惯 + 香蕉皮小装置
    possible_background: ['Artist'], // 官方 Library（Bugle 条目）：与 Bugle 同有表演或戏剧的背景
    lore_description:
      '该Civilian是纯粹的捣蛋鬼：爱讲笑话、双关语、挖苦人，哪怕在最不该开玩笑的时候；随身带着专门摆放"喜剧效果香蕉皮"的小装置，能让粗心的自己或杀手滑倒摔晕，巧妙运用可以彻底封堵杀手想走的路线。',
    personality_connection:
      '喜欢一切能带来乐子的东西，哪怕以别人的不快为代价；许多居民讨厌他们，常与 Taunt 居民一起惹事——但与 Taunt 不同，他们清楚自己的界限，被找麻烦时会退让、把一切当"玩笑"带过（只是除了他们自己，没人在笑）；常在 Artful 的表演上起哄。',
    synergy_candidates: [{ with: 'Artful', result: 'Showtime' }],
    synergy_result_of: [],
    library_excerpt:
      'Banana Peel 平民喜欢一切能带来乐子的东西，哪怕是以别人的不快为代价。' +
      '许多其他类型的平民都讨厌他们，但他们经常和 Taunt 平民待在一起，因为两者都爱一起惹事。不过与 Taunt 平民不同，他们清楚自己的界限。如果有平民开始找他们麻烦，他们会退让，把一切当成"玩笑"带过——只是除了他们自己，没人在笑。' +
      '许多 Banana Peel 平民经常在 Artful 的表演上起哄，他们并不完全讨厌 Artful，很多人知道 Artful 已经学会如何配合他们的观众互动，不过从他上一次演出之后，显然他们可能玩得有点过火了……',
  },
  {
    // 官方 Library：Cloak 居民安静独处，掌握实验性政府科技（注入科技的隐形斗篷）；
    // 与 BonusPad 一起推进研究，用隐身近距离观察野生动物。
    id: 'cloak',
    name: 'Cloak',
    source: SOURCE,
    category: 'stealth',
    core_trait: 'Engineering Experience',
    explaining_traits: ['Engineering Experience', 'Outdoor Experience'], // 政府科技 + 野外观察
    possible_background: [], // 官方 Library：政府实验科技，非官方渠道的居民也能获得——不设背景锁定
    lore_description:
      '该Civilian掌握一种实验性政府科技——注入科技的特殊斗篷，裹住自己即可暂时隐形（科技并不完美，维持隐形消耗很大）；安静、喜欢独处，常与 BonusPad 居民一起推进研究，用隐身从更近的距离观察野生动物而不打扰它们，获取几乎无法研究的重要信息。',
    personality_connection:
      '安静内向、智力高于平均水平，是珍稀资讯的收集者；即便不是政府官员也有居民搞到这项技术——隐形既是研究工具，也是他们与人群保持距离的方式。',
    synergy_candidates: [],
    synergy_result_of: [],
    library_excerpt:
      '"Cloak"平民拥有高于平均水平的智力，经常与 BonusPad 平民一起推进研究，主要利用他们发明的斗篷从更近的距离观察野生动物而不打扰它们，从而获取许多以前被认为几乎不可能研究的重要信息。' +
      '然而，这项技术并不完美，维持隐形消耗大量能量，充能速度更慢。一些平民即使不是政府官员也搞到了这项技术——当然，要抓住他们比听起来困难得多，这让他们得以隐形。',
  },
  {
    // 官方 Library：Taunt 居民不受欢迎，以他人为代价博取一笑；挑衅后猛推；
    // 经营"恶作剧"媒体频道；不知何时收手、常被教训；与 Banana Peel 投缘。
    id: 'taunt',
    name: 'Taunt',
    source: SOURCE,
    category: 'disruption',
    core_trait: 'Special Habit',
    explaining_traits: ['Special Habit'],
    possible_background: [], // 官方 Library 未给出身背景（媒体频道/恶作剧者，不设背景锁定）
    lore_description:
      '该Civilian以尖刻与恶作剧为乐：最擅长吸引别人的注意——通常靠挑衅——然后猛地把对方推出去很远；不过熟悉他们的人能躲过推搡并反击回去。',
    personality_connection:
      '不受欢迎——过度尖刻、为了博取一笑什么都做（主要以为代价是别人）；少数合得来的是同样热爱廉价笑料的 Banana Peel 居民；经常不知道何时该收手，在很多情况下惹错了人并因此被教训；多数经营着展示"恶作剧"的媒体频道，但成功有限。',
    synergy_candidates: [{ with: 'Bugle', result: 'Noisemaker' }],
    synergy_result_of: [],
    library_excerpt:
      '如前所述，没有多少其他平民喜欢 Taunt 平民，许多人选择避开他们和他们的麻烦行为，不过 Banana Peel 平民是少数经常与 Taunt 平民相处融洽的人，因为他们都喜欢廉价的笑声和简单的娱乐。' +
      '尽管如此，Taunt 平民经常不知道何时该收手，在很多情况下，惹错了人并因此被教训。大多数时候，Taunt 平民拥有媒体频道，在上面展示他们的"恶作剧"，但成功有限。',
  },
  {
    // 官方 Library：Bugle 居民是"士气领袖"——号角声传得很远、鼓舞人心，但暴露位置且几乎无自保；
    // 大家保持理智的基石；与 Banana Peel 同有表演/戏剧背景。
    id: 'bugle',
    name: 'Bugle',
    source: SOURCE,
    category: 'morale',
    core_trait: 'Special Habit',
    explaining_traits: ['Special Habit'],
    possible_background: ['Artist'], // 官方 Library：与 Banana Peel 都有表演或戏剧的背景
    lore_description:
      '该Civilian扮演"士气领袖"：用号角吹奏出传得很远、鼓舞人心的声音，帮助身边居民在恐惧中保持专注——但吹奏也会暴露自己的位置，自身几乎没有防御能力，全靠同伴保护或及时撤离。',
    personality_connection:
      '通常对自己的工作缺乏经验（太容易被击杀），却是这个未知与恐惧时代里所有人保持理智的基石，居民们都非常喜欢他们的陪伴；幸存很久的 Bugle 居民总有直面死亡、死里逃生的精彩故事；与所有类型居民都相处极好，与同样有表演/戏剧背景的 Banana Peel 居民最投缘。',
    synergy_candidates: [{ with: 'Taunt', result: 'Noisemaker' }],
    synergy_result_of: [],
    library_excerpt:
      'Bugle 平民通常对自己的工作非常缺乏经验，这主要是因为太容易被击杀，尤其是他们经常用号角暴露自己的位置。尽管如此，所有其他平民都非常喜欢他们的陪伴，因为在这个充满未知和恐惧的时代，他们是保持理智的基石。' +
      '那些存活了很长时间（主要是因为他们团队的保护）的 Bugle 平民，通常有精彩的故事可讲——关于直面死亡、几乎毫发无伤地逃脱，或者至少没有致命伤。他们与所有其他类型的平民都相处得非常好，不过与 Banana Peel 平民相处得最完美，因为他们都有表演或戏剧的背景，共同回忆往事。',
  },
  // ── Synergy 结果登记（Lore 预留：只解释设定，不实现任何组合逻辑）──
  {
    id: 'carepad',
    name: 'CarePad',
    source: SOURCE,
    category: 'synergy',
    core_trait: 'Medical Knowledge',
    explaining_traits: ['Medical Knowledge', 'Engineering Experience'],
    possible_background: [],
    lore_description:
      '医疗知识与工程能力的组合达到大师级水平：既能照顾他人，又能搭建用于照护的辅助设施。',
    personality_connection: '关怀与动手能力的结合：把照顾他人做到专业水准的普通人。',
    synergy_candidates: [],
    synergy_result_of: ['Caretaker', 'BonusPad'],
  },
  {
    id: 'loveshot',
    name: 'Loveshot',
    source: SOURCE,
    category: 'synergy',
    core_trait: 'Marksmanship',
    explaining_traits: ['Marksmanship', 'Empathy'],
    possible_background: [],
    lore_description:
      '射击经验与关怀之心的组合（预留设定，当前不实现）：用职业本领守护所爱之人。',
    personality_connection: '外冷内热：以精准与温柔并存的普通人。',
    synergy_candidates: [],
    synergy_result_of: ['Revolver', 'Caretaker'],
  },
  {
    // 官方 Synergy 表：Hotdog + Pie → SweetTooth（热狗变为红蛋糕）——只登记结果，不实现逻辑。
    id: 'sweettooth',
    name: 'SweetTooth',
    source: SOURCE,
    category: 'synergy',
    core_trait: 'Cooking Skill',
    explaining_traits: ['Cooking Skill', 'Special Habit'],
    possible_background: [],
    lore_description:
      '烹饪天赋与旺盛食欲的组合达到大师级水平（预留设定，当前不实现）：把热狗升华为特制的红蛋糕点心，更滋养也更有代价。',
    personality_connection: '厨师与老饕的合而为一：对美食的热爱成为团队的甜蜜支柱。',
    synergy_candidates: [],
    synergy_result_of: ['Hotdog', 'Pie'],
  },
  {
    // 官方 Synergy 表：Taunt + Bugle → Noisemaker（号角改为多段吹奏表演）——只登记结果，不实现逻辑。
    id: 'noisemaker',
    name: 'Noisemaker',
    source: SOURCE,
    category: 'synergy',
    core_trait: 'Special Habit',
    explaining_traits: ['Special Habit'],
    possible_background: [],
    lore_description:
      '号角与挑衅表演的组合达到大师级水平（预留设定，当前不实现）：更喧闹、更具戏剧性的多段吹奏表演。',
    personality_connection: '表演欲与感染力的结合：把鼓舞士气变成一整场演出。',
    synergy_candidates: [],
    synergy_result_of: ['Taunt', 'Bugle'],
  },
];

/** Background → 人生经历短语（用于生成 Lore Explanation）。 */
const BACKGROUND_EXPERIENCE = {
  Engineer: '拥有建筑经验',
  Medic: '拥有医疗与照护经验',
  Athlete: '拥有长期体育训练的经历',
  Cook: '拥有烹饪与准备食物的经验',
  Security: '拥有安全职业训练的经历',
  Artist: '拥有艺术创作与观察生活的经历',
};

/** Ability → 能力表现短语（解释“因此能够……”）。 */
const ABILITY_PHRASE = {
  Punch: '能凭借优秀身体素质应对威胁',
  Caretaker: '能照顾与救治身边的人',
  Revolver: '熟悉枪械并懂得安全使用',
  Hotdog: '保留着亲手准备食物的习惯',
  Pie: '能用有限食材做出让人安心的食物',
  BonusPad: '能够制作临时辅助设施',
  Dash: '能快速移动脱离危险',
  Block: '能构筑防护挡住危险',
  Flashlight: '能在黑暗中引路探明方向',
  Adrenaline: '能在受惊时爆发出逃命的速度',
  'Banana Peel': '能用恶作剧装置打乱威胁者的脚步',
  Cloak: '能借助科技斗篷隐匿行踪',
  Taunt: '能以挑衅转移威胁者的注意力',
  Bugle: '能用号角声提振身边人的士气',
  SweetTooth: '能把食物变成鼓舞人心的特制点心',
  Noisemaker: '能把鼓舞人心变成一整场演出',
};

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
    category: row.category,
    core_trait: row.core_trait,
    explaining_traits: parseJson(row.explaining_traits, []),
    possible_background: parseJson(row.possible_background, []),
    lore_description: row.lore_description,
    personality_connection: row.personality_connection,
    synergy_candidates: parseJson(row.synergy_candidates, []),
    possible_synergy: parseJson(row.synergy_candidates, []), // 别名（Synergy 预留命名）
    synergy_result_of: parseJson(row.synergy_result_of, []),
    library_excerpt: row.library_excerpt || null, // 官方 Library 文本（CANON；无战斗数值）
  };
}

/** 幂等播种 dod_abilities_lore（内容可随设定输入更新，按 id 覆盖）。 */
function ensureAbilityLoreSeeded() {
  const db = getDb();
  const hasCol = (col) => db.prepare('PRAGMA table_info(dod_abilities_lore)').all().some((c) => c.name === col);
  const withLibrary = hasCol('library_excerpt');
  const ins = db.prepare(
    `INSERT INTO dod_abilities_lore
       (id, name, source, category, core_trait, explaining_traits, possible_background,
        lore_description, personality_connection, synergy_candidates, synergy_result_of${withLibrary ? ', library_excerpt' : ''})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${withLibrary ? ', ?' : ''})
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, source = excluded.source, category = excluded.category,
       core_trait = excluded.core_trait, explaining_traits = excluded.explaining_traits,
       possible_background = excluded.possible_background, lore_description = excluded.lore_description,
       personality_connection = excluded.personality_connection,
       synergy_candidates = excluded.synergy_candidates, synergy_result_of = excluded.synergy_result_of${withLibrary ? ', library_excerpt = excluded.library_excerpt' : ''}`
  );
  for (const e of ABILITY_LORE_ENTRIES) {
    const base = [
      e.id,
      e.name,
      e.source,
      e.category,
      e.core_trait,
      JSON.stringify(e.explaining_traits || []),
      JSON.stringify(e.possible_background || []),
      e.lore_description,
      e.personality_connection,
      JSON.stringify(e.synergy_candidates || []),
      JSON.stringify(e.synergy_result_of || []),
    ];
    if (withLibrary) base.push(e.library_excerpt || null);
    ins.run(...base);
  }
  return ABILITY_LORE_ENTRIES.length;
}

/** 读取单个 Ability Lore（按 name 或 id）。 */
function getAbilityLore(key) {
  if (!key) return null;
  ensureAbilityLoreSeeded();
  const db = getDb();
  const row = db.prepare('SELECT * FROM dod_abilities_lore WHERE name = ? OR id = ?').get(key, String(key).toLowerCase());
  return rowToLore(row);
}

/** 全部 Ability Lore（按 id 排序）。 */
function listAbilityLore() {
  ensureAbilityLoreSeeded();
  return getDb().prepare('SELECT * FROM dod_abilities_lore ORDER BY id').all().map(rowToLore);
}

/**
 * Ability → Background 权重：关联背景 = 3（概率提高），其余 = 1（基础概率，仍可获得）。
 * 不是固定绑定：任何 Background 的权重都 ≥ 1，任何 Civilian 都可能获得任何 Ability。
 */
function backgroundAbilityWeight(abilityKey, background) {
  const lore = getAbilityLore(abilityKey);
  if (!lore) return BASE_ABILITY_WEIGHT;
  if (background && lore.possible_background.includes(background)) return LINKED_BACKGROUND_WEIGHT;
  return BASE_ABILITY_WEIGHT;
}

/** Background → 关联 Ability 列表（权重提高项；来自 Lore 数据，非硬编码）。 */
function linkedAbilities(background) {
  return listAbilityLore()
    .filter((l) => l.category !== 'synergy' && l.possible_background.includes(background))
    .map((l) => l.name);
}

/** Ability → Trait 解释列表（该能力体现的人生特点）。 */
function abilityExplainingTraits(abilityKey) {
  const lore = getAbilityLore(abilityKey);
  return lore ? lore.explaining_traits : [];
}

/** Ability 的 Synergy 候选（只读数据；本阶段不实现任何 Synergy 逻辑）。 */
function synergyCandidates(abilityKey) {
  const lore = getAbilityLore(abilityKey);
  return lore ? lore.synergy_candidates : [];
}

/**
 * 生成 Lore Explanation（AI Context 用）：
 *  - 背景关联 → “该居民过去拥有建筑经验，因此能够制作临时辅助设施。”
 *  - 背景无关联 → 通用经历解释 + 明确无职业锁定（任何背景都可能拥有）。
 */
function abilityLoreExplanation(abilityKey, background = null) {
  const lore = getAbilityLore(abilityKey);
  if (!lore) return null;
  const phrase = ABILITY_PHRASE[abilityKey];
  if (background && lore.possible_background.includes(background)) {
    const bgPhrase = BACKGROUND_EXPERIENCE[background] || '拥有相关人生经历';
    return `该居民过去${bgPhrase}，因此${phrase || '展现出这种能力'}。`;
  }
  if (background) {
    return `${lore.lore_description}（${background}背景与它没有固定绑定：任何背景的居民都可能拥有这种经历。）`;
  }
  return lore.lore_description;
}

module.exports = {
  SOURCE,
  ABILITY_EXPLANATION_RULE,
  LINKED_BACKGROUND_WEIGHT,
  BASE_ABILITY_WEIGHT,
  ABILITY_LORE_ENTRIES,
  BACKGROUND_EXPERIENCE,
  ABILITY_PHRASE,
  ensureAbilityLoreSeeded,
  getAbilityLore,
  listAbilityLore,
  backgroundAbilityWeight,
  linkedAbilities,
  abilityExplainingTraits,
  synergyCandidates,
  abilityLoreExplanation,
};
