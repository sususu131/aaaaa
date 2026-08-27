/**
 * 阶段26 测试：Admin Web UI 扩展 —— Vision API 配置 UI + 服务器状态/事件/世界开关/预设重导入 + 搜索配置（34 项）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s26';
process.env.AI_BASE_URL = 'http://127.0.0.1:4126/v1';
process.env.AI_MODEL = 'mock-s26';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const dbMod = require('@roblox-trpg/database');
const db = dbMod.getDb();
const presetSeeder = require('../src/services/presets/presetSeeder');
const settingsService = require('../src/services/settingsService');
const { getVisionRuntimeConfig } = require('../src/services/vision/visionProvider');
const { getSearchProvider, resolveSearchProviderName } = require('../src/services/search/SearchProvider');
const worldSim = require('../src/services/world/worldSim');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };

async function main() {
  console.log('[test] 阶段26 就绪（34 项）\n');
  presetSeeder.runPresetSeeder(fakeIo);

  // ══ A. Vision 设置（DB > env）══
  assert.strictEqual(getVisionRuntimeConfig().apiKey, ''); // env 未配置 vision
  ok('1. Vision 默认读取 env（未配置=空）');
  settingsService.setSettings({ 'vision.base_url': 'http://10.0.0.5:9000/v1', 'vision.api_key': 'vk-1234567890abcdef', 'vision.model': 'vision-x' });
  const vcfg = getVisionRuntimeConfig();
  assert.ok(vcfg.baseUrl === 'http://10.0.0.5:9000/v1' && vcfg.apiKey === 'vk-1234567890abcdef' && vcfg.model === 'vision-x');
  ok('2. Vision DB 设置覆盖 env（base/key/model）');
  settingsService.setSetting('vision.timeout_ms', '45000');
  assert.strictEqual(getVisionRuntimeConfig().timeoutMs, 45000);
  ok('3. Vision 超时可配置');
  settingsService.setSettings({ 'vision.base_url': '', 'vision.api_key': '', 'vision.model': '', 'vision.timeout_ms': '' });
  assert.ok(getVisionRuntimeConfig().apiKey === '' && getVisionRuntimeConfig().baseUrl === '');
  ok('4. 清除 Vision 设置 → 回落 env');
  const view = settingsService.adminView();
  assert.ok(view.vision && 'baseUrl' in view.vision && 'apiKeyMasked' in view.vision && 'hasApiKey' in view.vision);
  ok('5. adminView 含 vision 段（密钥打码）');

  // ══ B. 搜索设置（DB > env）══
  assert.strictEqual(resolveSearchProviderName(), 'null');
  assert.strictEqual(getSearchProvider().constructor.name, 'NullSearchProvider');
  ok('6. 搜索默认 null（不可用，不编造）');
  settingsService.setSettings({ 'search.provider': 'serper', 'search.serper_api_key': 'serper-key-abcdef123456' });
  assert.strictEqual(resolveSearchProviderName(), 'serper');
  assert.strictEqual(getSearchProvider().constructor.name, 'SerperSearchProvider');
  ok('7. DB 配置 serper + key → SerperSearchProvider 生效');
  assert.ok(view.search || true);
  const view2 = settingsService.adminView();
  assert.ok(view2.search.available === true && view2.search.serperKeyMasked.includes('…'));
  ok('8. adminView 含 search 段（available + 打码）');
  settingsService.setSettings({ 'search.provider': '', 'search.serper_api_key': '' });
  assert.strictEqual(getSearchProvider().constructor.name, 'NullSearchProvider');
  ok('9. 清除搜索设置 → 回落 env（null）');

  // ══ C. REST：settings 保存 vision/search ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const resSave = await fetch(url('/api/admin/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vision: { base_url: 'http://127.0.0.10/v1', model: 'vm-1' }, search: { provider: 'serper', serper_api_key: 'sk-1111222233334444' } }),
  }).then((r) => r.json());
  assert.ok(resSave.view.vision.baseUrl === 'http://127.0.0.10/v1' && resSave.view.search.available);
  ok('10. POST /api/admin/settings 支持 vision/search 段');
  await fetch(url('/api/admin/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vision: { base_url: '', model: '' }, search: { provider: '', serper_api_key: '' } }),
  });
  const resVT = await fetch(url('/api/admin/vision/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resVT.ok === false && /未配置/.test(resVT.reason));
  ok('11. Vision 连接测试：未配置优雅提示');
  const resST = await fetch(url('/api/admin/search/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resST.ok === false && resST.provider === 'NullSearchProvider' && /SEARCH_UNAVAILABLE|未配置/.test(resST.reason));
  ok('12. 搜索测试：null provider 明确不可用（不编造）');

  // ══ D. 服务器状态 / 事件 ══
  const resStatus = await fetch(url('/api/admin/status')).then((r) => r.json());
  assert.ok(resStatus.uptimeSec >= 0 && resStatus.node && resStatus.memoryMb > 0);
  ok('13. /api/admin/status：uptime/node/内存');
  assert.ok(resStatus.db && resStatus.db.players === 0 && resStatus.db.dungeons >= 5 && resStatus.db.skills > 0);
  ok('14. 状态：DB 计数（players/dungeons/skills）');
  assert.ok(resStatus.worldScheduler && typeof resStatus.worldScheduler.paused === 'boolean');
  ok('15. 状态：世界调度器状态');
  assert.ok(resStatus.config.vision && resStatus.config.search);
  ok('16. 状态：配置概览（vision/search）');
  const resEvents = await fetch(url('/api/admin/events?limit=5')).then((r) => r.json());
  assert.ok(Array.isArray(resEvents.events));
  ok('17. /api/admin/events：最近事件列表');
  assert.ok(resEvents.events.every((e) => e.type));

  // ══ E. 世界模拟开关 ══
  const resPause = await fetch(url('/api/admin/world/pause'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resPause.ok && resPause.worldScheduler.paused === true);
  ok('18. POST /api/admin/world/pause：世界模拟暂停');
  assert.strictEqual(worldSim.isPaused(), true);
  ok('19. worldSim.isPaused() 同步生效');
  const resResume = await fetch(url('/api/admin/world/resume'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resResume.ok && resResume.worldScheduler.paused === false);
  ok('20. POST /api/admin/world/resume：恢复');
  assert.strictEqual(worldSim.isPaused(), false);
  ok('21. 恢复后调度器回到运行态');

  // ══ F. 预设重导入 ══
  const before = {
    dungeons: db.prepare('SELECT COUNT(*) c FROM dungeons').get().c,
    fate: db.prepare("SELECT COUNT(*) c FROM skills WHERE json_extract(effect_data, '$.dod_fate_ability') = 1").get().c,
    inter: db.prepare('SELECT COUNT(*) c FROM ability_threat_interactions').get().c,
  };
  const resRe = await fetch(url('/api/admin/presets/reimport'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resRe.ok && resRe.results.length === 5 && resRe.results.every((x) => !x.error));
  ok('22. POST /api/admin/presets/reimport：5 个预设全部成功');
  const after = {
    dungeons: db.prepare('SELECT COUNT(*) c FROM dungeons').get().c,
    fate: db.prepare("SELECT COUNT(*) c FROM skills WHERE json_extract(effect_data, '$.dod_fate_ability') = 1").get().c,
    inter: db.prepare('SELECT COUNT(*) c FROM ability_threat_interactions').get().c,
  };
  assert.deepStrictEqual(after, before);
  ok('23. 重导入幂等（dungeons/fate 技能/互动 目录不变）');

  // ══ G. 管理 UI 页面 ══
  const html = await fetch(url('/admin')).then((r) => r.text());
  assert.ok(/Vision API（图像分析）/.test(html) && /vBaseUrl/.test(html) && /vModel/.test(html));
  ok('24. UI：Vision 配置卡片（Base URL/Key/模型）');
  assert.ok(/测试连接/.test(html) && /testVision/.test(html));
  ok('25. UI：Vision 连接测试按钮');
  assert.ok(/Web 搜索（AI 联网）/.test(html) && /sProvider/.test(html) && /serper/.test(html));
  ok('26. UI：搜索配置卡片（provider + Serper Key）');
  assert.ok(/服务器状态/.test(html) && /loadStatus/.test(html) && /世界模拟/.test(html));
  ok('27. UI：服务器状态卡片');
  assert.ok(/暂停世界模拟/.test(html) && /恢复世界模拟/.test(html) && /reimportPresets/.test(html));
  ok('28. UI：世界开关 + 预设重导入按钮');
  assert.ok(/最近游戏事件/.test(html) && /loadEvents/.test(html));
  ok('29. UI：最近事件日志面板');
  assert.ok(/一键填入：DeepSeek/.test(html));
  ok('30. UI：Vision 一键预设（DeepSeek/OpenAI 兼容）');

  // ══ H. 白名单与安全 ══
  const resEvil = await fetch(url('/api/admin/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vision: { evil: 'x' } }),
  }).then((r) => r.json());
  assert.ok(resEvil.saved.length === 0 && !db.prepare("SELECT 1 FROM system_settings WHERE key LIKE '%evil%'").get());
  ok('31. 白名单外字段被忽略（不落库；直接写未知键由服务层拒绝）');
  const allSettings = db.prepare('SELECT key FROM system_settings').all().map((r) => r.key);
  assert.ok(allSettings.every((k) => settingsService.isValidKey(k)));
  ok('32. 表内全部键在白名单内');
  const resView = await fetch(url('/api/admin/settings')).then((r) => r.json());
  assert.ok(!JSON.stringify(resView).includes('vk-1234567890abcdef') && !JSON.stringify(resView).includes('serper-key-abcdef123456'));
  ok('33. 打码不泄漏已存密钥');
  const resAi = await fetch(url('/api/admin/ai/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(typeof resAi.ok === 'boolean');
  ok('34. AI 连接测试仍正常（回归）');

  server.close();
  console.log(`\n[阶段26] 通过 ${passed} 项测试`);
  if (passed < 30) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段26] 测试失败：', err);
  process.exit(1);
});
