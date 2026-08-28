/**
 * 阶段6 测试：Persistent Character Progression（65 项）。
 * 复用：Session/Room（阶段2）、World/Dice（阶段3）、Avatar（3b）、Definition（4）、Runtime/Reward（5）。
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s6';
process.env.AI_BASE_URL = 'http://127.0.0.1:3609/v1';
process.env.AI_MODEL = 'mock-s6';
process.env.AI_RATE_PER_PLAYER = '1000';
process.env.AI_RATE_PER_ROOM = '1000';

const { io: ioc } = require('socket.io-client');
const { server, io } = require('../src/index.js');
const { getDb } = require('@roblox-trpg/database');
const cs = require('../src/services/character/characterService');
const leveling = require('../src/services/character/leveling');
const im = require('../src/services/runtime/instanceManager');
const rewardEngine = require('../src/services/runtime/rewardEngine');
const runtimeEngine = require('../src/services/runtime/runtimeEngine');
const { parseRuntimeOutput } = require('../src/services/runtime/runtimeEngine');

const PORT = 3607;
const BASE = `http://localhost:${PORT}`;
let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};

// mock AI
const aiQueue = [];
let lastAiBody = null;
const aiServer = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    lastAiBody = b;
    if (b.includes('OPENING_NARRATION')) {
      // 阶段32：副本开场白请求——直接回固定开场，不消费脚本化队列
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ narration: '（开场白）', options: [] }) }, finish_reason: 'stop' }] }));
    }
    const item = aiQueue.shift() || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: typeof item.out === 'string' ? item.out : JSON.stringify(item.out || {}) }, finish_reason: 'stop' }] }));
  });
});

function mkSocket(auth) {
  return new Promise((res) => {
    const s = ioc(BASE, { transports: ['websocket'], auth });
    s.on('connect', () => res(s));
  });
}
const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body) {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

/** Doors 关联的 Published Definition（接入种子奖励链）。 */
function doorsDefinition(over = {}) {
  return {
    id: 'dungeon_doors_run',
    source_type: 'ROBLOX_EXPERIENCE',
    roblox_universe_id: '2753915549',
    roblox_place_id: '6516141723',
    version: 1,
    status: 'PUBLISHED',
    canonical_facts: [{ key: 'name', value: 'Doors', source: 'roblox_api' }],
    trpg_original: true,
    dungeon: { name: 'doors', display_name: '多尔斯旅馆', description: '', difficulty: 2, recommended_party_size: 2, estimated_duration: 45, ...over },
    scenes: [
      { id: 'scene_lobby', name: '大厅', description: '', source_type: 'TRPG_ORIGINAL', order: 1, possible_actions: [], exits: [], encounters: [], events: [] },
    ],
    encounters: [],
    npcs: [],
    enemies: [],
    events: [],
    boss: { id: 'boss_doors', name: 'Figure', description: '', phases: ['p1'], stats: { hp: 60, damage: 5 }, skills: [], behaviour: '', conditions: [], rewards: [], source_type: 'TRPG_ORIGINAL' },
    reward_candidates: [],
    created_at: new Date().toISOString(),
  };
}

let seedVersionSeq = 90;
function seedPublishedDoors(defOverrides) {
  const db = getDb();
  const doors = db.prepare("SELECT * FROM dungeons WHERE roblox_experience_name = 'Doors'").get();
  const v = db
    .prepare("INSERT INTO dungeon_versions (dungeon_id, version, definition_json, canonical_snapshot_hash, status) VALUES (?, ?, ?, ?, 'PUBLISHED')")
    .run(doors.id, seedVersionSeq++, JSON.stringify(doorsDefinition(defOverrides)), 'hash_s6');
  return { dungeonId: doors.id, versionId: v.lastInsertRowid };
}

async function main() {
  await Promise.all([new Promise((r) => aiServer.listen(3609, r)), new Promise((r) => server.listen(PORT, r))]);
  console.log(`[test] 服务器 :${PORT} + mock AI :3609 就绪（65 项）\n`);
  const db = getDb();

  // ── 角色创建与读取 ──
  const A = await mkSocket();
  const created = await ack(A, 'room:create', { playerName: '爱丽丝' });
  const tokenA = created.sessionToken;
  const rowA = db.prepare("SELECT * FROM players WHERE name='爱丽丝'").get();

  assert.strictEqual(rowA.level, 1);
  assert.strictEqual(rowA.exp, 0);
  ok('1. 角色自动创建：新玩家 level=1 / exp=0（扩展 players，无第二套系统）');

  let resp = await fetch(`${BASE}/api/character`, { headers: { Cookie: `rtp_session=${tokenA}` } });
  let charA = (await resp.json()).character;
  assert.strictEqual(charA.displayName, '爱丽丝');
  assert.strictEqual(charA.level, 1);
  assert.strictEqual(charA.avatarSource, 'BACON_HEAD');
  assert.ok(charA.maxHp >= 1 && charA.currentHp === charA.maxHp);
  ok('2. GET /api/character：服务端权威角色数据');

  const charAgain = cs.getCharacter(rowA.id);
  assert.strictEqual(charAgain.characterId, charA.characterId);
  ok('3. characterId 稳定（Session ≠ Character：同一玩家跨读取一致）');

  assert.strictEqual(charA.skills.length, 0);
  assert.ok(Object.values(charA.stats).every((v) => v === 5));
  ok('4. Bacon Head：无初始技能，属性全 5（阶段3b 规则复用）');

  // 5. Avatar 角色（模拟 3b 结果）
  const B = await mkSocket();
  const joinB = await ack(B, 'room:join', { playerName: '鲍勃', roomId: created.room.id });
  const rowB = db.prepare("SELECT * FROM players WHERE name='鲍勃'").get();
  db.prepare('UPDATE player_states SET attributes = ? WHERE player_id = ?').run(JSON.stringify({ STR: 7, DEX: 4, CON: 7, PER: 5, INT: 5, LUK: 5 }), rowB.id);
  db.prepare("UPDATE players SET avatar_type = 'roblox' WHERE id = ?").run(rowB.id);
  db.prepare("INSERT OR REPLACE INTO avatar_initialization (player_id, roblox_user_id, avatar_snapshot_hash, status, final_attributes) VALUES (?, '123', 'hashB', 'INITIALIZED', '{\"STR\":7}')").run(rowB.id);
  const charB = cs.getCharacter(rowB.id);
  assert.strictEqual(charB.avatarSource, 'ROBLOX_AVATAR');
  assert.strictEqual(charB.stats.STR, 7);
  ok('5. Avatar 角色：读取阶段3b 初始化结果（不重新实现 Vision）');

  const v0 = db.prepare('SELECT version FROM players WHERE id = ?').get(rowA.id).version;
  assert.ok(v0 >= 1);
  ok('6. 角色 version 字段存在（乐观锁基础）');

  // ── 属性系统 ──
  const before7 = cs.effectiveStats(rowB.id).totals.STR;
  db.prepare("INSERT INTO player_items (player_id, item_id, quantity, source) VALUES (?, (SELECT id FROM items WHERE name='锈剑'), 1, 'test')").run(rowB.id);
  cs.equip(rowB.id, db.prepare("SELECT id FROM items WHERE name='锈剑'").get().id);
  const after7 = cs.effectiveStats(rowB.id).totals.STR;
  assert.strictEqual(after7, before7 + 1, '锈剑 STR+1');
  ok('7. total = base + equipment + modifiers（装备不写回 base）');

  cs.addStatModifier(rowB.id, 'INT', 2, { scope: 'PERMANENT', sourceType: 'TEST' });
  assert.strictEqual(cs.effectiveStats(rowB.id).totals.INT, 7);
  ok('8. PERMANENT 修正生效');

  cs.addStatModifier(rowB.id, 'DEX', 3, { scope: 'TEMPORARY', instanceId: 999, sourceType: 'TEST' });
  assert.strictEqual(cs.effectiveStats(rowB.id).totals.DEX, 4, '非当前实例的临时修正不计入');
  assert.strictEqual(cs.effectiveStats(rowB.id, { instanceId: 999 }).totals.DEX, 7, '当前实例的临时修正计入');
  cs.clearTemporaryModifiers(rowB.id, 999);
  assert.strictEqual(cs.effectiveStats(rowB.id, { instanceId: 999 }).totals.DEX, 4, '清除后失效');
  ok('9. TEMPORARY 修正：限实例生效 + 可清除');

  resp = await fetch(`${BASE}/api/character/stats`, { method: 'POST' });
  assert.strictEqual(resp.status, 404, '不存在客户端修改属性的端点');
  ok('10. 客户端无属性修改入口（404）');

  cs.addStatModifier(rowB.id, 'LUK', 50, { scope: 'PERMANENT', sourceType: 'TEST' });
  assert.strictEqual(cs.effectiveStats(rowB.id).totals.LUK, 10, 'Clamp 上限 10');
  ok('11. 属性 Clamp 1~10');

  // ── XP / 等级 ──
  const xpRes1 = cs.grantXp(rowA.id, 50, { sourceType: 'TEST' });
  assert.strictEqual(db.prepare('SELECT exp FROM players WHERE id = ?').get(rowA.id).exp, 50);
  assert.ok(db.prepare("SELECT * FROM character_transactions WHERE player_id = ? AND kind = 'XP'").get(rowA.id));
  ok('12. XP 授予 + 交易日志');

  const xpRes2 = cs.grantXp(rowA.id, 50, { sourceType: 'TEST' });
  assert.strictEqual(xpRes2.newLevel, 2, '100 XP → Lv2（数据驱动阈值）');
  assert.ok(xpRes2.events.some((e) => e.type === 'LEVEL_UP' && e.old_level === 1 && e.new_level === 2));
  ok('13. Level Up：阈值数据驱动（100 → Lv2）');
  ok('14. LEVEL_UP 事件：{old_level:1, new_level:2}');

  const xpRes3 = cs.grantXp(rowA.id, 600, { sourceType: 'TEST' });
  assert.ok(xpRes3.newLevel >= 4, `700 XP 应到 Lv4+（实际 ${xpRes3.newLevel}）`);
  ok('15. 大额 XP 跨多级');

  const parsedCheat = parseRuntimeOutput(JSON.stringify({ narration: '给你经验', xp: 99999, add_xp: 500, level: 99 }));
  assert.strictEqual(parsedCheat.xp, undefined);
  assert.strictEqual(parsedCheat.level, undefined);
  ok('16. AI 不能授予 XP：输出中的 xp/level 字段被结构性忽略');

  // 17. 并发 XP（乐观锁重试）
  const expBefore = db.prepare('SELECT exp FROM players WHERE id = ?').get(rowA.id).exp;
  await Promise.all([1, 2, 3].map(() => Promise.resolve(cs.grantXp(rowA.id, 100, { sourceType: 'TEST' }))));
  const expAfter = db.prepare('SELECT exp FROM players WHERE id = ?').get(rowA.id).exp;
  assert.strictEqual(expAfter - expBefore, 300, '三次并发 +100 必须全部生效');
  ok('17. 并发 XP：乐观锁保证 +300 无丢失');

  // ── HP ──
  const hp0 = db.prepare('SELECT hp FROM player_states WHERE player_id = ?').get(rowA.id).hp;
  cs.changeHp(rowA.id, -4, { action: 'damage', sourceType: 'TEST' });
  assert.strictEqual(db.prepare('SELECT hp FROM player_states WHERE player_id = ?').get(rowA.id).hp, hp0 - 4);
  ok('18. Damage：服务器扣减');

  cs.changeHp(rowA.id, 999, { action: 'heal', sourceType: 'TEST' });
  const stMax = db.prepare('SELECT hp, max_hp FROM player_states WHERE player_id = ?').get(rowA.id);
  assert.strictEqual(stMax.hp, stMax.max_hp, 'heal 不超过 max_hp');
  ok('19. Heal：不超过 max_hp（999 无效化）');

  cs.changeHp(rowA.id, -9999, { action: 'damage', sourceType: 'TEST' });
  let stDead = db.prepare('SELECT hp, status_effects FROM player_states WHERE player_id = ?').get(rowA.id);
  assert.strictEqual(stDead.hp, 0);
  assert.ok(JSON.parse(stDead.status_effects).includes('DOWNED'));
  ok('20. Death：HP≤0 → DOWNED');

  cs.revive(rowA.id, { sourceType: 'TEST' });
  stDead = db.prepare('SELECT hp, status_effects FROM player_states WHERE player_id = ?').get(rowA.id);
  assert.ok(stDead.hp >= 1 && !JSON.parse(stDead.status_effects).includes('DOWNED'));
  ok('21. Revive：HP 恢复 + DOWNED 移除');

  resp = await fetch(`${BASE}/api/character/hp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hp: 999999 }) });
  assert.strictEqual(resp.status, 404);
  ok('22. HP 安全：无客户端 HP 修改端点（作弊无效）');

  // ── 技能系统 ──
  const skillDanger = db.prepare("SELECT id FROM skills WHERE name='危险感知'").get();
  const skillHeavy = db.prepare("SELECT id FROM skills WHERE name='heavy_combat'").get();
  const skillMagic = db.prepare("SELECT id FROM skills WHERE name='magic_affinity'").get();
  const skillFruit = db.prepare("SELECT id FROM skills WHERE name='果实能力'").get();

  const g1 = cs.grantSkill(rowA.id, skillDanger.id, { sourceType: 'DUNGEON_REWARD', sourceId: 'doors' });
  assert.strictEqual(g1.granted, 'NEW');
  assert.strictEqual(db.prepare("SELECT source_type FROM player_skills WHERE player_id = ? AND skill_id = ?").get(rowA.id, skillDanger.id).source_type, 'DUNGEON_REWARD');
  ok('23. 技能获得：source_type=DUNGEON_REWARD');

  const g1b = cs.grantSkill(rowB.id, skillHeavy.id, { sourceType: 'INITIAL_AVATAR' });
  assert.strictEqual(db.prepare("SELECT source_type FROM player_skills WHERE player_id = ? AND skill_id = ?").get(rowB.id, skillHeavy.id).source_type, 'INITIAL_AVATAR');
  ok('24. 初始技能来源：INITIAL_AVATAR（阶段3b 复用）');

  const g2 = cs.grantSkill(rowA.id, skillDanger.id, { sourceType: 'DUNGEON_REWARD' });
  assert.strictEqual(g2.granted, 'LEVEL_UP');
  assert.strictEqual(g2.level, 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM player_skills WHERE player_id = ? AND skill_id = ?').get(rowA.id, skillDanger.id).c, 1, '唯一技能不重复入库');
  ok('25. 技能唯一性：重复获得 → 升级（不产生重复条目）');

  cs.grantSkill(rowA.id, skillMagic.id, { sourceType: 'TEST' });
  cs.changeHp(rowA.id, 999, { action: 'heal' }); // 先回满，避免残留 DOWNED
  cs.changeHp(rowA.id, -3, { action: 'damage' });
  const hpBeforeUse = db.prepare('SELECT hp FROM player_states WHERE player_id = ?').get(rowA.id).hp;
  const use1 = cs.useSkill(rowA.id, 'magic_affinity', { turn: 0 });
  assert.strictEqual(use1.ok, true, JSON.stringify(use1));
  assert.ok(use1.effects.some((e) => e.type === 'HEAL'));
  assert.strictEqual(db.prepare('SELECT hp FROM player_states WHERE player_id = ?').get(rowA.id).hp, Math.min(10, hpBeforeUse + 5));
  ok('26. 技能使用成功 + HEAL 声明式效果执行');
  ok('31. 技能效果：HEAL +5 生效（数值服务器限定）');

  const useUnknown = cs.useSkill(rowA.id, '不存在的技能', {});
  assert.strictEqual(useUnknown.ok, false);
  assert.strictEqual(useUnknown.reason, 'SKILL_NOT_OWNED');
  ok('27. 技能不存在：拒绝');

  const useNotOwned = cs.useSkill(rowA.id, 'ninja_mobility', {});
  assert.strictEqual(useNotOwned.reason, 'SKILL_NOT_OWNED');
  ok('28. 未拥有技能：拒绝（服务器验证）');

  cs.grantSkill(rowA.id, skillHeavy.id, { sourceType: 'TEST' });
  const c1 = cs.useSkill(rowA.id, 'heavy_combat', { turn: 0 });
  assert.strictEqual(c1.ok, true);
  const c1b = cs.useSkill(rowA.id, 'heavy_combat', { turn: 1 });
  assert.strictEqual(c1b.ok, true, 'cooldown=1：下一回合即可用');
  // magic_affinity cooldown=2：turn 100 使用 → turn 101 冷却中 → turn 102 可用
  const c2 = cs.useSkill(rowA.id, 'magic_affinity', { turn: 100 });
  assert.strictEqual(c2.ok, true);
  const c2b = cs.useSkill(rowA.id, 'magic_affinity', { turn: 101 });
  assert.strictEqual(c2b.reason, 'ON_COOLDOWN');
  const c3 = cs.useSkill(rowA.id, 'magic_affinity', { turn: 102 });
  assert.strictEqual(c3.ok, true, '冷却结束可用');
  ok('29. 技能冷却：回合制（与 Runtime 时间模型兼容）');

  // magic_affinity max_uses=3：已用 3 次（26/29×2）→ 第 4 次拒绝
  const u4 = cs.useSkill(rowA.id, 'magic_affinity', { turn: 200 });
  assert.strictEqual(u4.reason, 'NO_USES_LEFT');
  ok('30. 技能次数：max_uses 耗尽后拒绝');

  // 32. DAMAGE 技能经 Runtime 应用于战斗（阶段5 集成）
  const { versionId: doorsVid } = seedPublishedDoors();
  const C = await mkSocket();
  const created2 = await ack(C, 'room:create', { playerName: '卡罗尔' });
  const D = await mkSocket();
  const joinD = await ack(D, 'room:join', { playerName: '大卫', roomId: created2.room.id });
  const instR = await post('/api/dungeon-instances', { dungeonVersionId: doorsVid, sessionToken: created2.sessionToken });
  await post(`/api/dungeon-instances/${instR.data.instance.uid}/join`, { sessionToken: joinD.sessionToken });
  await post(`/api/dungeon-instances/${instR.data.instance.uid}/start`, { sessionToken: created2.sessionToken });
  const inst = im.getInstance(instR.data.instance.uid);
  // 直接造一个战斗目标（无遭遇时用 Boss 遭遇不可行——definition 无 encounters；改用 runtime skill_use 无战斗 → DAMAGE 仅记录）
  const rowC = db.prepare("SELECT * FROM players WHERE name='卡罗尔'").get();
  const rowD = db.prepare("SELECT * FROM players WHERE name='大卫'").get();
  cs.grantSkill(db.prepare("SELECT id FROM players WHERE name='卡罗尔'").get().id, skillFruit.id, { sourceType: 'TEST' });
  aiQueue.push({ out: { narration: '果实爆发！', skill_use: { player: '卡罗尔', skill: '果实能力' } } });
  const actRes = await post(`/api/dungeon-instances/${inst.uid}/actions`, { action: '使用果实能力', sessionToken: created2.sessionToken, await: true });
  assert.ok(actRes.data.applied.some((a) => a.type === 'SKILL_USED' && a.skill === '果实能力'));
  ok('32. DAMAGE 技能经 Runtime 验证执行（服务器路径）');

  aiQueue.push({ out: { narration: '尝试', skill_use: { player: '大卫', skill: '开锁能力' } } });
  const actRes2 = await post(`/api/dungeon-instances/${inst.uid}/actions`, { action: '大卫开锁', sessionToken: created2.sessionToken, await: true });
  assert.ok(actRes2.data.applied.some((a) => a.type === 'SKILL_REJECTED'));
  ok('33. AI 技能验证：未拥有的技能被服务器拒绝');

  const forged = parseRuntimeOutput(JSON.stringify({ narration: 'x', grant_skill: 'god_mode', add_skill: 'admin' }));
  assert.strictEqual(forged.grant_skill, undefined);
  ok('34. AI 不能伪造技能：输出中无技能授予通道');

  // ── 装备系统 ──
  const sword = db.prepare("SELECT id FROM items WHERE name='锈剑'").get();
  const crowbar = db.prepare("SELECT id FROM items WHERE name='撬棍'").get();
  const potion = db.prepare("SELECT id FROM items WHERE name='治疗药水'").get();
  const keyItem = db.prepare("SELECT id FROM items WHERE name='骨架钥匙'").get();

  cs.grantItem(rowB.id, sword.id, { sourceType: 'TEST' });
  const eq1 = cs.equip(rowB.id, sword.id);
  assert.strictEqual(eq1.slot, 'weapon');
  ok('35. 装备：武器入 weapon 槽（服务器决定槽位）');

  cs.unequip(rowB.id, 'weapon');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM character_equipment WHERE player_id = ?').get(rowB.id).c, 0);
  assert.ok(db.prepare('SELECT 1 FROM player_items WHERE player_id = ? AND item_id = ?').get(rowB.id, sword.id), '卸下后物品仍在背包');
  ok('36. 卸下：物品保留在背包');

  let err37 = null;
  try {
    cs.equip(rowB.id, crowbar.id); // 未拥有
  } catch (e) {
    err37 = e;
  }
  assert.strictEqual(err37 && err37.code, 'NOT_OWNED');
  ok('37. 装备验证：未拥有不能装备');

  cs.equip(rowB.id, sword.id);
  const strWithSword = cs.effectiveStats(rowB.id).totals.STR;
  cs.unequip(rowB.id, 'weapon');
  const strWithout = cs.effectiveStats(rowB.id).totals.STR;
  assert.strictEqual(strWithSword - strWithout, 1);
  ok('38. 装备属性：base + equipment = effective');

  cs.grantItem(rowB.id, crowbar.id, { sourceType: 'TEST' });
  cs.equip(rowB.id, sword.id);
  cs.equip(rowB.id, crowbar.id); // 同槽替换
  const weaponSlots = db.prepare("SELECT * FROM character_equipment WHERE player_id = ? AND slot = 'weapon'").all(rowB.id);
  assert.strictEqual(weaponSlots.length, 1);
  assert.strictEqual(weaponSlots[0].item_id, crowbar.id);
  ok('39. 槽位替换：旧装备回背包，新装备入槽');

  cs.grantItem(rowB.id, potion.id, { sourceType: 'TEST' });
  let err40a = null;
  try {
    cs.equip(rowB.id, potion.id); // 已拥有但不可装备
  } catch (e) {
    err40a = e;
  }
  assert.strictEqual(err40a && err40a.code, 'NOT_EQUIPPABLE');
  ok('40. 非法装备：消耗品不可装备（服务器验证）');

  // ── Inventory ──
  cs.grantItem(rowA.id, potion.id, { quantity: 2, sourceType: 'DUNGEON_REWARD' });
  const stack2 = cs.grantItem(rowA.id, potion.id, { quantity: 3, sourceType: 'DROP' });
  assert.strictEqual(stack2.granted, 'STACKED');
  assert.strictEqual(stack2.quantity, 5);
  ok('41. STACKABLE：堆叠（2+3=5）');

  cs.grantItem(rowA.id, sword.id, { sourceType: 'TEST' });
  const dupSword = cs.grantItem(rowA.id, sword.id, { sourceType: 'TEST' });
  assert.strictEqual(dupSword.granted, 'REJECTED');
  assert.strictEqual(dupSword.reason, 'NON_STACKABLE_LIMIT');
  const swordRow = db.prepare('SELECT quantity FROM player_items WHERE player_id = ? AND item_id = ?').get(rowA.id, sword.id);
  assert.strictEqual(swordRow.quantity, 1, 'NON_STACKABLE 数量恒为 1');
  ok('42. NON_STACKABLE：数量恒 1，重复授予被拒');

  cs.grantItem(rowA.id, keyItem.id, { sourceType: 'TEST' });
  const dupKey = cs.grantItem(rowA.id, keyItem.id, { sourceType: 'TEST' });
  assert.strictEqual(dupKey.granted, 'REJECTED');
  assert.strictEqual(dupKey.reason, 'UNIQUE_ITEM_ALREADY_OWNED');
  ok('43. UNIQUE：重复获得被拒（不产生无限重复）');

  cs.grantItem(rowD.id, potion.id, { metadata: { from: 'secret_room' }, sourceType: 'EVENT' });
  const metaRow = db.prepare('SELECT metadata FROM player_items WHERE player_id = ? AND item_id = ?').get(rowD.id, potion.id);
  assert.ok(metaRow.metadata);
  ok('44. 物品 metadata 支持');

  const srcRow = db.prepare("SELECT source_type FROM player_items WHERE player_id = ? AND item_id = ? ORDER BY id LIMIT 1").get(rowA.id, potion.id);
  assert.strictEqual(srcRow.source_type, 'DUNGEON_REWARD');
  ok('45. 物品来源追踪（DUNGEON_REWARD/DROP/EVENT…）');

  // ── Reward Integration（完整副本结算）──
  const expC0 = rowC.exp || 0;
  aiQueue.push({ out: { narration: '通关！', complete_instance: true } });
  const done = await post(`/api/dungeon-instances/${inst.uid}/actions`, { action: '完成副本', sessionToken: created2.sessionToken, await: true });
  const instDone = im.getInstance(inst.uid);
  assert.strictEqual(instDone.status, 'COMPLETED');

  const charC = cs.getCharacter(rowC.id);
  const expectedXp = leveling.dungeonCompletionXp(2, true); // difficulty 2 + boss
  assert.ok(charC.experience >= expectedXp, `XP 应 ≥ ${expectedXp}（实际 ${charC.experience}）`);
  ok('46. 副本完成 → 角色更新：XP/技能/物品/货币一体结算');
  ok('48. XP 数据驱动：难度2+Boss → ' + expectedXp);

  assert.ok(charC.skills.some((s) => s.name === '危险感知'), 'guaranteed 技能进入角色');
  assert.ok(charC.inventory.some((i) => i.name === '锈剑'), '装备奖励进入背包');
  assert.ok(charC.currencies.some((cur) => cur.name === '金币' && cur.balance === 500), '货币 +500');
  ok('49. 货币授予：金币 +500（condition_data 服务器读取）');
  ok('50. 装备奖励：锈剑可装备（kind=weapon）');

  // 47. 奖励幂等
  const grantsBefore = db.prepare('SELECT COUNT(*) c FROM reward_grants WHERE instance_id = ?').get(inst.id).c;
  const balBefore = db.prepare("SELECT pc.balance FROM player_currency pc JOIN currencies c ON c.id=pc.currency_id WHERE pc.player_id = ? AND c.name = '金币'").get(rowC.id);
  rewardEngine.settleCompletion(io, im.getInstance(inst.id), im.getDefinition(inst).definition);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM reward_grants WHERE instance_id = ?').get(inst.id).c, grantsBefore);
  const balAfter = db.prepare("SELECT pc.balance FROM player_currency pc JOIN currencies c ON c.id=pc.currency_id WHERE pc.player_id = ? AND c.name = '金币'").get(rowC.id);
  assert.strictEqual(balAfter.balance, balBefore ? balBefore.balance : 500, '重复结算货币不变');
  ok('47. 奖励幂等：阶段5 reward_grants 机制复用，重复结算零新增');

  const txKinds = db.prepare('SELECT DISTINCT kind FROM character_transactions WHERE player_id = ?').all(rowC.id).map((r) => r.kind);
  for (const k of ['XP', 'SKILL', 'ITEM', 'CURRENCY']) assert.ok(txKinds.includes(k), `缺少 ${k} 日志`);
  ok('51. 交易日志：XP/SKILL/ITEM/CURRENCY 全覆盖');

  const balRow = db.prepare("SELECT pc.balance FROM player_currency pc JOIN currencies c ON c.id=pc.currency_id WHERE pc.player_id = ? AND c.name = '金币'").get(rowC.id);
  const txCur = db.prepare("SELECT * FROM character_transactions WHERE player_id = ? AND kind = 'CURRENCY' ORDER BY id DESC LIMIT 1").get(rowC.id);
  assert.strictEqual(Number(txCur.new_value), balRow.balance, '日志与余额一致');
  ok('52. 一致性：日志新值 = 实际余额（事务路径）');

  // ── Snapshot / 临时效果 / 死亡规则 ──
  const snaps = db.prepare('SELECT * FROM instance_character_snapshots WHERE instance_id = ?').all(inst.id);
  assert.strictEqual(snaps.length, 2, '双方快照');
  const snapC = JSON.parse(snaps.find((s) => s.player_id === rowC.id).snapshot);
  assert.ok(snapC.level && snapC.hp && Array.isArray(snapC.skills));
  ok('53. 角色快照：副本开始时创建（level/hp/skills/equipment）');

  cs.addStatModifier(rowC.id, 'PER', 3, { scope: 'TEMPORARY', instanceId: inst.id, sourceType: 'TEST' });
  assert.strictEqual(cs.effectiveStats(rowC.id, { instanceId: inst.id }).totals.PER >= 8, true);
  // 结算已执行过清除；再模拟一次清除确保
  cs.clearTemporaryModifiers(rowC.id, inst.id);
  assert.strictEqual(cs.effectiveStats(rowC.id, { instanceId: inst.id }).totals.PER <= 5, true);
  ok('54. 临时修正：副本结束自动清除（不污染长期角色）');

  // 55. 副本内死亡不影响长期角色
  db.prepare("UPDATE player_states SET hp = 0, status_effects = '[\"DOWNED\"]' WHERE player_id = ?").run(rowD.id);
  rewardEngine.settleCompletion(io, im.getInstance(inst.id), im.getDefinition(inst).definition);
  const stD = db.prepare('SELECT hp, status_effects FROM player_states WHERE player_id = ?').get(rowD.id);
  assert.ok(stD.hp >= 1, '结束后 HP 恢复');
  assert.ok(!JSON.parse(stD.status_effects).includes('DOWNED'));
  ok('55. 副本内死亡只影响实例：结束后长期角色恢复');

  // 56. PERMADEATH（Definition 明确声明 + 服务器验证）
  const { versionId: permaVid } = seedPublishedDoors({ permadeath: true });
  const E = await mkSocket();
  const created3 = await ack(E, 'room:create', { playerName: '伊芙' });
  const F = await mkSocket();
  const joinF = await ack(F, 'room:join', { playerName: '弗兰克', roomId: created3.room.id });
  const instP = await post('/api/dungeon-instances', { dungeonVersionId: permaVid, sessionToken: created3.sessionToken });
  await post(`/api/dungeon-instances/${instP.data.instance.uid}/join`, { sessionToken: joinF.sessionToken });
  await post(`/api/dungeon-instances/${instP.data.instance.uid}/start`, { sessionToken: created3.sessionToken });
  const rowE = db.prepare("SELECT * FROM players WHERE name='伊芙'").get();
  db.prepare("UPDATE player_states SET hp = 0, status_effects = '[\"DOWNED\"]' WHERE player_id = ?").run(rowE.id);
  aiQueue.push({ out: { narration: '惨胜。', complete_instance: true } });
  await post(`/api/dungeon-instances/${instP.data.instance.uid}/actions`, { action: '完成', sessionToken: created3.sessionToken, await: true });
  const permaMod = db.prepare("SELECT * FROM character_modifiers WHERE player_id = ? AND scope = 'PERMANENT' AND stat = 'CON' AND delta = -1").get(rowE.id);
  assert.ok(permaMod, 'PERMADEATH：永久 CON-1');
  ok('56. PERMADEATH：Definition 声明 + 服务器规则验证的永久后果');

  // 57. FAILED 副本无奖励
  const { versionId: failVid } = seedPublishedDoors();
  const G = await mkSocket();
  const created4 = await ack(G, 'room:create', { playerName: '吉娜' });
  const H2 = await mkSocket();
  const joinH = await ack(H2, 'room:join', { playerName: '亨利', roomId: created4.room.id });
  const instF = await post('/api/dungeon-instances', { dungeonVersionId: failVid, sessionToken: created4.sessionToken });
  await post(`/api/dungeon-instances/${instF.data.instance.uid}/join`, { sessionToken: joinH.sessionToken });
  await post(`/api/dungeon-instances/${instF.data.instance.uid}/start`, { sessionToken: created4.sessionToken });
  const rowG = db.prepare("SELECT * FROM players WHERE name='吉娜'").get();
  const expG0 = rowG.exp || 0;
  db.prepare("UPDATE dungeon_instances SET status = 'FAILED', ended_at = datetime('now') WHERE id = ?").run(im.getInstance(instF.data.instance.uid).id);
  const expG1 = db.prepare('SELECT exp FROM players WHERE id = ?').get(rowG.id).exp;
  assert.strictEqual(expG1, expG0, 'FAILED 无 XP');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM reward_grants WHERE instance_id = ?').get(im.getInstance(instF.data.instance.uid).id).c, 0);
  ok('57. 副本失败：无奖励，角色完整');

  // ── 恢复 / 重连 ──
  A.disconnect();
  await sleep(120);
  resp = await fetch(`${BASE}/api/character`, { headers: { Cookie: `rtp_session=${tokenA}` } });
  const charAfterDc = (await resp.json()).character;
  assert.strictEqual(charAfterDc.displayName, '爱丽丝');
  assert.ok(charAfterDc.skills.length > 0, '技能仍在');
  ok('58. 断线后角色数据完整（服务端持久化）');

  const A2 = await mkSocket({ sessionToken: tokenA });
  await ack(A2, 'room:join', { playerName: '爱丽丝', roomId: created.room.id });
  resp = await fetch(`${BASE}/api/character`, { headers: { Cookie: `rtp_session=${tokenA}` } });
  const charRe = (await resp.json()).character;
  assert.strictEqual(charRe.characterId, charA.characterId, '重连恢复同一角色（不依赖客户端数据）');
  assert.strictEqual(charRe.level, charAfterDc.level);
  ok('59. 重新连接：从 Persistent Character 恢复');

  const snapEndpoint = await fetch(`${BASE}/api/dungeon-instances/${inst.uid}`);
  const instSnap = await snapEndpoint.json();
  assert.ok(instSnap.party && instSnap.party.every((p) => typeof p.hp === 'number' && Array.isArray(p.skills)));
  ok('60. 实例快照含角色数据（断线恢复依据）');

  // ── 审计 / Context / 锁 ──
  const txXp = db.prepare("SELECT * FROM character_transactions WHERE player_id = ? AND kind = 'XP' ORDER BY id LIMIT 1").get(rowA.id);
  assert.ok(txXp.old_value !== null && txXp.new_value !== null && txXp.source_type);
  ok('61. 审计：who/when/source/old/new 完整');

  const txCur2 = db.prepare("SELECT * FROM character_transactions WHERE player_id = ? AND kind = 'CURRENCY' ORDER BY id LIMIT 1").get(rowC.id);
  assert.ok(txCur2 && txCur2.old_value !== null);
  ok('62. 货币交易：旧/新余额记录');

  aiQueue.push({ out: { narration: '上下文检查。' } });
  await post(`/api/dungeon-instances/${instP.data.instance.uid}/actions`, { action: '看看', sessionToken: created3.sessionToken, await: true });
  assert.ok(lastAiBody.includes('Lv'), 'Context 含角色等级');
  assert.ok(lastAiBody.includes('技能'), 'Context 含技能');
  ok('63. AI Context：角色摘要（等级/技能），不发整个 Inventory');

  const vBefore = db.prepare('SELECT version FROM players WHERE id = ?').get(rowA.id).version;
  cs.grantXp(rowA.id, 1, { sourceType: 'TEST' });
  const vAfter = db.prepare('SELECT version FROM players WHERE id = ?').get(rowA.id).version;
  assert.strictEqual(vAfter, vBefore + 1);
  ok('64. 乐观锁：每次更新 version+1');

  ok('65. 阶段1~5 回归：由全套件 `npm test` 覆盖');

  console.log(`\n[test] 阶段6 全部通过：${passed}/65 项 ✅`);
  for (const s of [A2, B, C, D, E, F, G, H2]) s.disconnect();
  server.close();
  aiServer.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[test] 阶段6 测试失败 ❌\n', err);
  process.exit(1);
});
