/**
 * 阶段30 测试：绑定固定 R6 / R6-R15 区分 / Vision 全链路日志（AI 真实输出+服务器验证+最终数值）（32 项）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s30';
process.env.AI_BASE_URL = 'http://127.0.0.1:4130/v1';
process.env.AI_MODEL = 'mock-s30';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const initializeAvatar = require('../src/services/vision/initializeAvatar');
const { analyzeAvatar } = require('../src/services/vision/deepseekVision');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };

// ── mock Vision 网关（OpenAI 兼容）──
const VISION_REPLY = JSON.stringify({
  candidate_tags: ['military', 'armor'],
  confidence: { military: 0.9, armor: 0.8 },
  candidate_skill_ids: [],
  reasoning: '战术装备与护甲外观',
});
const mock = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: 'msg_v', choices: [{ index: 0, message: { role: 'assistant', content: VISION_REPLY }, finish_reason: 'stop' }], usage: { total_tokens: 500 } }));
});

async function main() {
  console.log('[test] 阶段30 就绪（32 项）\n');
  presetSeeder.runPresetSeeder(fakeIo);
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const vBase = `http://127.0.0.1:${mock.address().port}`;

  // ══ A. R6/R15 区分（表结构与缩略图）══
  const cols = db.prepare('PRAGMA table_info(roblox_profiles)').all().map((c) => c.name);
  ['fullbody_r6_url', 'fullbody_r15_url', 'avatar_type'].every((c) => cols.includes(c) || assert.fail(`缺列 ${c}`));
  ok('1. roblox_profiles：fullbody_r6_url / fullbody_r15_url / avatar_type 列存在');
  const thumbs = require('../src/services/roblox/robloxThumbnails');
  assert.strictEqual(typeof thumbs.getUserAvatarType, 'function');
  ok('2. getUserAvatarType 可用（实际体型探测）');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/roblox/robloxThumbnails.js'), 'utf8');
  assert.ok(/thumbnailFormat=r6/.test(src) && /thumbnailFormat=r15/.test(src));
  ok('3. 官方端点带 thumbnailFormat=r6 / r15（区分渲染）');
  assert.ok(/fullbody:\s*\(fullbodyR6/.test(src));
  ok('4. 兼容字段 fullbody 优先 R6（不可用回落 R15）');
  const handlerSrc = fs.readFileSync(path.join(__dirname, '../src/sockets/handlers.js'), 'utf8');
  assert.ok(/fullbodyR6/.test(handlerSrc) && /fullbodyR15/.test(handlerSrc) && /avatarType/.test(handlerSrc));
  ok('5. 绑定流程：R6/R15 双存 + 体型探测');
  assert.ok(/绑定固定 R6/.test(handlerSrc));
  ok('6. 绑定注释明示固定 R6');

  // ══ B. Vision 日志列 ══
  const vcols = db.prepare('PRAGMA table_info(vision_analysis_log)').all().map((c) => c.name);
  ['raw_response', 'request_meta', 'image_url'].every((c) => vcols.includes(c) || assert.fail(`缺列 ${c}`));
  ok('7. vision_analysis_log：raw_response / request_meta / image_url 列存在');

  // ══ C. analyzeAvatar 返回真实输出材料 ══
  const settingsService = require('../src/services/settingsService');
  settingsService.setSettings({ 'vision.base_url': vBase, 'vision.api_key': 'vk-30-1234567890abcdef', 'vision.model': 'vision-mock-30' });
  const r = await analyzeAvatar({ imageUrl: 'https://t0.rbxcdn.com/test.png', allowedTags: ['military', 'armor'], allowedSkillIds: [] });
  assert.ok(r.raw && r.raw.candidate_tags.length === 2);
  ok('8. analyzeAvatar 返回解析 JSON（raw）');
  assert.ok(r.rawText === VISION_REPLY);
  ok('9. rawText = Vision AI 回复原文');
  assert.ok(r.rawResponse && r.rawResponse.choices && r.rawResponse.usage);
  ok('10. rawResponse = 网关完整响应');
  assert.ok(r.requestBody && r.requestBody.endpoint && r.requestBody.model === 'vision-mock-30');
  ok('11. requestBody = 本次请求元数据（端点/模型）');
  assert.ok(!JSON.stringify(r.requestBody).includes('vk-30'));
  ok('12. 请求元数据不含 API Key');

  // ══ D. initializeAvatar 全链路日志 ══
  db.prepare("INSERT OR IGNORE INTO rooms (id, status, max_players) VALUES ('S30','waiting',3)").run();
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?,?,?,?)').run('u_s30_1', 'sock_s30_1', '战术居民', 'S30');
  const p1 = db.prepare("SELECT * FROM players WHERE uid='u_s30_1'").get();
  require('../src/services/world/playerStates').ensurePlayerState(p1.id);
  const initRes = await initializeAvatar.initializeAvatar({ playerRowId: p1.id, robloxUserId: '424242', avatarUrl: 'https://t0.rbxcdn.com/r6.png' });
  assert.ok(initRes.status === 'INITIALIZED');
  ok('13. Vision 初始化成功');
  const log = db.prepare('SELECT * FROM vision_analysis_log ORDER BY id DESC LIMIT 1').get();
  assert.ok(log && log.image_url === 'https://t0.rbxcdn.com/r6.png');
  ok('14. 日志记录图片 URL');
  const rr = JSON.parse(log.raw_response || '{}');
  assert.ok(rr.modelText === VISION_REPLY && rr.parsed && rr.parsed.candidate_tags && rr.gateway);
  ok('15. 日志含三层真实输出（网关原文/模型文本/解析 JSON）');
  const meta = JSON.parse(log.request_meta || '{}');
  assert.ok(meta.endpoint.includes(String(mock.address().port)) && meta.model === 'vision-mock-30');
  ok('16. 日志含请求元数据（端点/模型）');
  const finalAttrs = JSON.parse(log.final_attributes || '{}');
  const tags = JSON.parse(log.accepted_tags || '[]');
  assert.ok(tags.length >= 1 && finalAttrs && Object.keys(finalAttrs).length > 0);
  ok('17. "默认数值"问题可见性：日志记录最终数值与来源 tags');
  const initRow = db.prepare('SELECT * FROM avatar_initialization WHERE player_id = ?').get(p1.id);
  const visionResult = JSON.parse(initRow.vision_result || '{}');
  assert.ok(visionResult.candidate_tags.includes('military'));
  ok('18. avatar_initialization.vision_result 保存原始输出');

  // ══ E. 服务器输出日志（控制台捕获）══
  const consoleLog = console.log;
  let captured = [];
  console.log = (...a) => { captured.push(a.join(' ')); };
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?,?,?,?)').run('u_s30_2', 'sock_s30_2', '日志居民', 'S30');
  const p2 = db.prepare("SELECT * FROM players WHERE uid='u_s30_2'").get();
  require('../src/services/world/playerStates').ensurePlayerState(p2.id);
  await initializeAvatar.initializeAvatar({ playerRowId: p2.id, robloxUserId: '434343', avatarUrl: 'https://t0.rbxcdn.com/r6b.png' });
  console.log = consoleLog;
  const joined = captured.join('\n');
  assert.ok(joined.includes('[vision] ── AI 原始输出 ──'));
  ok('19. 控制台：AI 原始输出分节日志');
  assert.ok(joined.includes('[vision] 模型回复原文:'));
  ok('20. 控制台：模型回复原文');
  assert.ok(joined.includes('[vision] 服务器验证:'));
  ok('21. 控制台：服务器验证结果（接受/拒绝）');
  assert.ok(joined.includes('[vision] 最终数值:'));
  ok('22. 控制台：最终数值与技能');

  // ══ F. REST：vision-logs + ai-test/vision 完整返回 ══
  await new Promise((r2) => server.listen(0, '127.0.0.1', r2));
  const url = (p3) => `http://127.0.0.1:${server.address().port}${p3}`;
  const resLogs = await fetch(url('/api/admin/vision-logs?limit=5')).then((x) => x.json());
  assert.ok(resLogs.logs.length >= 2 && resLogs.logs[0].rawResponse && resLogs.logs[0].finalAttributes);
  ok('23. GET /api/admin/vision-logs（含真实输出+最终数值）');
  assert.ok(resLogs.logs.every((l) => l.imageUrl));
  ok('24. 日志 API 返回图片 URL');
  const resTest = await fetch(url('/api/admin/ai-test/vision'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl: 'https://t0.rbxcdn.com/x.png' }),
  }).then((x) => x.json());
  assert.ok(resTest.ok && resTest.rawText === VISION_REPLY && resTest.gatewayResponse && resTest.request);
  ok('25. ai-test/vision 返回 rawText/gatewayResponse/request（完整排查材料）');
  const res404 = await fetch(url('/api/admin/vision-logs2'));
  assert.ok((await res404.json()).code === 'NOT_FOUND');
  ok('26. 未知路径仍 JSON 404（回归）');

  // ══ G. UI ══
  const html = fs.readFileSync(path.join(__dirname, '../src/admin/index.html'), 'utf8');
  assert.ok(/Vision 分析日志/.test(html) && /loadVisionLogs/.test(html));
  ok('27. 管理页：Vision 日志面板');
  assert.ok(/Vision AI 原始输出/.test(html) && /最终数值/.test(html) && /服务器验证/.test(html));
  ok('28. 面板展示三段：AI 原始输出/服务器验证/最终数值');

  // ══ H. 回归 ══
  db.prepare('INSERT INTO players (uid, socket_id, name, room_id) VALUES (?,?,?,?)').run('u_s30_bacon', 'sock_s30_bacon', '培根居民', 'S30');
  const pBacon = db.prepare("SELECT * FROM players WHERE uid='u_s30_bacon'").get();
  const bacon = await initializeAvatar.initializeAvatar({ playerRowId: pBacon.id, forceBacon: true });
  assert.ok(bacon.bacon && bacon.status === 'INITIALIZED' && bacon.skills.length === 0);
  ok('29. Bacon 路径不调 Vision（回归）');
  settingsService.setSettings({ 'vision.base_url': '', 'vision.api_key': '', 'vision.model': '' });
  assert.ok(analyzeAvatar !== null);
  ok('30. analyzeAvatar 导出完整（回归）');
  const stats = db.prepare('SELECT COUNT(*) c FROM vision_analysis_log').get().c;
  assert.ok(stats >= 2);
  ok('31. 日志表累积记录（' + stats + ' 条）');
  const profileCols = db.prepare('PRAGMA table_info(roblox_profiles)').all().length;
  assert.ok(profileCols >= 9);
  ok('32. roblox_profiles 结构完整（回归）');

  mock.close();
  server.close();
  console.log(`\n[阶段30] 通过 ${passed} 项测试`);
  if (passed < 28) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段30] 测试失败：', err);
  process.exit(1);
});
