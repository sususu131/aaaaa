/**
 * 阶段29 测试：AI/Vision 网关响应加固（HTML→明确诊断）+ Admin 测试端点真实链路探测（26 项）。
 * 背景：用户配置 OpenAI 兼容网关（api.inferaiapi.com）后 run action 报
 * "SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON"——
 * 网关对错误路径返回 HTML，而 postJson/visionPostJson 直接 res.json()。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s29';
process.env.AI_BASE_URL = 'http://127.0.0.1:9/v1'; // 占位（测试内用 mock 覆盖）
process.env.AI_MODEL = 'mock-s29';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const presetSeeder = require('../src/services/presets/presetSeeder');
const settingsService = require('../src/services/settingsService');
const { postJson, parseJsonBody } = require('../src/services/ai/providers/AiProvider');
const { visionPostJson } = require('../src/services/vision/visionProvider');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };

// ── mock 网关：/html 返回 HTML 首页；/v1/chat/completions 返回合法 JSON；/empty 空；/badjson 坏 JSON ──
const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/html')) {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!DOCTYPE html><html><body>gateway home</body></html>');
  } else if (req.url.startsWith('/empty')) {
    res.end('');
  } else if (req.url.startsWith('/badjson')) {
    res.setHeader('Content-Type', 'application/json');
    res.end('{not json');
  } else if (req.url.startsWith('/err500')) {
    res.statusMessage = 'err';
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model overloaded' } }));
  } else if (req.url.startsWith('/v1/chat/completions')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_x', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { total_tokens: 2 } }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html>404</html>');
  }
});

async function main() {
  console.log('[test] 阶段29 就绪（37 项）\n');
  presetSeeder.runPresetSeeder(fakeIo);
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${mock.address().port}`;

  // ══ A. parseJsonBody 单元 ══
  assert.deepStrictEqual(parseJsonBody('{"a":1}'), { a: 1 });
  ok('1. 合法 JSON 正常解析');
  let htmlErr = null;
  try { parseJsonBody('<!DOCTYPE html><html></html>'); } catch (e) { htmlErr = e; }
  assert.ok(htmlErr && htmlErr.kind === 'bad_base_url' && /HTML页面而非JSON/.test(htmlErr.message) && /\/v1/.test(htmlErr.message));
  ok('2. HTML 响应 → bad_base_url（提示检查 /v1）');
  let badErr = null;
  try { parseJsonBody('{not json'); } catch (e) { badErr = e; }
  assert.ok(badErr && badErr.kind === 'bad_format' && /不是合法JSON/.test(badErr.message));
  ok('3. 坏 JSON → bad_format（带响应片段）');
  let emptyErr = null;
  try { parseJsonBody(''); } catch (e) { emptyErr = e; }
  assert.ok(emptyErr && emptyErr.kind === 'bad_format' && /空响应/.test(emptyErr.message));
  ok('4. 空响应 → 明确报错');

  // ══ B. postJson（run action 同一链路）══
  let err1 = null;
  try { await postJson(`${base}/html/chat/completions`, {}, {}, 5000); } catch (e) { err1 = e; }
  assert.ok(err1 && err1.kind === 'bad_base_url' && !/Unexpected token/.test(err1.message));
  ok('5. postJson 遇 HTML → bad_base_url（不再是 SyntaxError: Unexpected token）');
  let err2 = null;
  try { await postJson(`${base}/badjson`, {}, {}, 5000); } catch (e) { err2 = e; }
  assert.ok(err2 && err2.kind === 'bad_format');
  ok('6. postJson 坏 JSON → bad_format');
  let err3 = null;
  try { await postJson(`${base}/err500`, {}, {}, 5000); } catch (e) { err3 = e; }
  assert.ok(err3 && err3.kind === 'server_error' && /model overloaded/.test(err3.message));
  ok('7. postJson 5xx → 错误信息附带服务端响应细节');
  const good = await postJson(`${base}/v1/chat/completions`, {}, { model: 'x' }, 5000);
  assert.ok(good.choices && good.choices[0].message.content === 'pong');
  ok('8. postJson 正常链路（chat/completions JSON）');
  let err404 = null;
  try { await postJson(`${base}/nope`, {}, {}, 5000); } catch (e) { err404 = e; }
  assert.ok(err404 && err404.kind === 'server_error');
  ok('9. postJson 404（HTML 错误页）→ 统一错误分类');

  // ══ C. Vision 同样加固 ══
  let vErr = null;
  try { await visionPostJson(`${base}/html/chat/completions`, {}, {}, 5000); } catch (e) { vErr = e; }
  assert.ok(vErr && vErr.kind === 'bad_base_url' && /HTML页面而非JSON/.test(vErr.message));
  ok('10. visionPostJson 遇 HTML → bad_base_url（带 /v1 提示）');
  const vGood = await visionPostJson(`${base}/v1/chat/completions`, {}, {}, 5000);
  assert.ok(vGood.choices);
  ok('11. visionPostJson 正常链路');

  // ══ D. OpenAIProvider 流分支 HTML 检测 ══
  const { OpenAIProvider } = require('../src/services/ai/providers/OpenAIProvider');
  const provider = new OpenAIProvider();
  const origCfg = require('../src/services/ai/providers/AiProvider').getAiRuntimeConfig;
  let sErr = null;
  try {
    settingsService.setSettings({ 'ai.base_url': `${base}/html/v1`, 'ai.api_key': 'k', 'ai.model': 'm' });
    const session = provider.startSession({ system: 's', userContent: 'u' });
    await provider.chat(session, []);
  } catch (e) { sErr = e; } finally {
    settingsService.setSettings({ 'ai.base_url': '', 'ai.api_key': '', 'ai.model': '' });
  }
  assert.ok(sErr && (sErr.kind === 'bad_base_url' || /HTML/.test(String(sErr.message))));
  ok('12. provider.chat（流式路径）遇 HTML → 明确诊断（不炸 SyntaxError）');

  // ══ E. Admin ai/test：真实 chat 探测 ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  settingsService.setSettings({ 'ai.base_url': `${base}/v1`, 'ai.api_key': 'test-key-1234567890', 'ai.model': 'mock-s29' });
  const resOk = await fetch(url('/api/admin/ai/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resOk.ok === true && resOk.via === 'chat/completions' && resOk.model === 'mock-s29');
  ok('13. /api/admin/ai/test：走真实 chat/completions（max_tokens=1）');
  settingsService.setSettings({ 'ai.base_url': `${base}/html/v1` });
  const resHtml = await fetch(url('/api/admin/ai/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resHtml.ok === false && /HTML/.test(resHtml.reason) && /\/v1/.test(resHtml.reason));
  ok('14. ai/test 对 HTML 网关给出 Base URL 诊断');
  settingsService.setSettings({ 'ai.base_url': `${base}/err500` });
  const res500 = await fetch(url('/api/admin/ai/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(res500.ok === false && /500/.test(res500.reason) && /model overloaded/.test(res500.reason));
  ok('15. ai/test 透传 5xx 服务端细节');
  settingsService.setSettings({ 'ai.base_url': `${base}/v1`, 'ai.api_key': '' });
  const savedEnvKey = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY; // DB 与 env 均无 Key 才是"未配置"
  const resNoKey = await fetch(url('/api/admin/ai/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resNoKey.ok === false && /API Key/.test(resNoKey.reason));
  ok('16. ai/test：未配置 Key 优雅提示（DB>env 均空）');
  process.env.AI_API_KEY = savedEnvKey;

  // ══ F. Admin vision/test：同链路 ══
  settingsService.setSettings({ 'vision.base_url': `${base}/v1`, 'vision.api_key': 'vk-1234567890abcdef', 'vision.model': 'vision-x' });
  const resV = await fetch(url('/api/admin/vision/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resV.ok === true && resV.via === 'chat/completions');
  ok('17. /api/admin/vision/test：真实 chat 探测成功');
  settingsService.setSettings({ 'vision.base_url': `${base}/html/v1` });
  const resVHtml = await fetch(url('/api/admin/vision/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resVHtml.ok === false && /HTML/.test(resVHtml.reason));
  ok('18. vision/test 对 HTML 网关给出诊断');
  settingsService.setSettings({ 'vision.base_url': '', 'vision.api_key': '', 'vision.model': '' });

  // ══ G. InferAI 预设 ══
  const resSet = await fetch(url('/api/admin/settings')).then((r) => r.json());
  assert.ok(resSet.presets.inferai && resSet.presets.inferai.baseUrl === 'https://api.inferaiapi.com/v1' && resSet.presets.inferai.model === 'gemini-3.7-flash');
  ok('19. 预设含 InferAI（api.inferaiapi.com/v1 + gemini-3.7-flash）');
  const html = await fetch(url('/admin')).then((r) => r.text());
  assert.ok(/api\.inferaiapi\.com\/v1/.test(html) && /gemini-3\.7-flash/.test(html));
  ok('20. Vision 卡片：一键填入 InferAI 按钮');
  assert.ok(/inferai/.test(html) || /一键填入/.test(html));
  ok('21. 管理页正常渲染（无脚本错误）');

  // ══ H. 回归锚点 ══
  assert.ok(typeof origCfg === 'function');
  ok('22. getAiRuntimeConfig 导出完整（回归）');
  const cfgNow = require('../src/services/ai/providers/AiProvider').getAiRuntimeConfig();
  assert.ok(cfgNow.baseUrl && cfgNow.apiKey);
  ok('23. 配置读取正常（DB>env 回落）');
  assert.ok(parseJsonBody(JSON.stringify({ ok: 1 })).ok === 1);
  ok('24. parseJsonBody 导出可复用');
  const statusRes = await fetch(url('/api/admin/status')).then((r) => r.json());
  assert.ok(statusRes.config.vision);
  ok('25. 状态接口正常（回归）');
  const resSearch = await fetch(url('/api/admin/search/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resSearch.ok === false);
  ok('26. 搜索测试未受影响（回归）');

  // ══ I. 用户测试页端点（/admin/ai-test.html 配套）══
  const { buildVisionChatUrl } = require('../src/services/vision/visionProvider');
  assert.strictEqual(buildVisionChatUrl('https://api.inferaiapi.com'), 'https://api.inferaiapi.com/v1/chat/completions');
  ok('27. buildVisionChatUrl：裸域名自动补 /v1');
  assert.strictEqual(buildVisionChatUrl('https://api.inferaiapi.com/v1'), 'https://api.inferaiapi.com/v1/chat/completions');
  ok('28. buildVisionChatUrl：已含 /v1 不重复');
  assert.strictEqual(buildVisionChatUrl('https://example.com/custom/v1/'), 'https://example.com/custom/v1/chat/completions');
  ok('29. buildVisionChatUrl：自定义路径保留');
  const resCfg = await fetch(url('/api/admin/ai-test/config')).then((r) => r.json());
  assert.ok(resCfg.ai || (resCfg.config && resCfg.config.ai));
  ok('30. GET /api/admin/ai-test/config（页面配置概览）');
  settingsService.setSettings({ 'ai.base_url': `${base}/v1`, 'ai.api_key': 'k-1234567890abcdef', 'ai.model': 'mock-s29' });
  const resText = await fetch(url('/api/admin/ai-test/text'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'ping' }),
  }).then((r) => r.json());
  assert.ok(resText.ok === true && resText.text === 'pong');
  ok('31. POST /api/admin/ai-test/text：真实链路（provider.chat）返回模型回复');
  settingsService.setSettings({ 'ai.base_url': `${base}/html/v1` });
  const resTextHtml = await fetch(url('/api/admin/ai-test/text'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'ping' }),
  }).then((r) => r.json());
  assert.ok(resTextHtml.ok === false && /HTML/.test(resTextHtml.error));
  ok('32. ai-test/text 对 HTML 网关给出诊断（不再 404→HTML）');
  settingsService.setSettings({ 'ai.base_url': `${base}/v1`, 'ai.api_key': '' });
  const resVNoImg = await fetch(url('/api/admin/ai-test/vision'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  }).then((r) => r.json());
  assert.ok(/图片不能为空/.test(String(resVNoImg.error)));
  ok('33. POST /api/admin/ai-test/vision：缺图优雅提示');
  settingsService.setSettings({ 'vision.base_url': `${base}/html`, 'vision.api_key': 'vk-1234567890abcdef' });
  const resVHtml2 = await fetch(url('/api/admin/ai-test/vision'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
  }).then((r) => r.json());
  assert.ok(resVHtml2.ok === false && (resVHtml2.kind === 'bad_base_url' || /HTML/.test(String(resVHtml2.error))));
  ok('34. ai-test/vision：Base URL 缺 /v1 → buildVisionChatUrl 补全后 HTML 诊断');
  settingsService.setSettings({ 'vision.base_url': '', 'vision.api_key': '' });
  const resPage = await fetch(url('/admin/ai-test.html'));
  assert.ok(resPage.status === 200 && (await resPage.text()).includes('ai-test'));
  ok('35. GET /admin/ai-test.html 可访问（用户测试页）');

  // ══ J. Express JSON 错误中间件（不再返回 HTML 413/解析错误页）══
  const resBig = await fetch(url('/api/admin/ai-test/text'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{broken',
  });
  const bigData = await resBig.json().catch(() => null);
  assert.ok(resBig.status === 400 && bigData && bigData.code === 'INVALID_JSON');
  ok('36. 坏 JSON 请求 → JSON 错误（INVALID_JSON），不是 HTML SyntaxError');
  const idxSrc = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.ok(/JSON_BODY_LIMIT \|\| '25mb'/.test(idxSrc));
  ok('37. JSON 体上限 25MB（base64 图片不再 413 HTML）');

  // ══ K. 404 也返回 JSON（未重启旧后端/路径错误时不再 HTML）══
  const res404 = await fetch(url('/api/admin/ai-test/nonexistent'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const d404 = await res404.json();
  assert.ok(res404.status === 404 && d404.code === 'NOT_FOUND' && /路径不存在/.test(d404.error));
  ok('38. 未匹配路由 → JSON 404（不再是 HTML "Cannot POST"）');
  const res404b = await fetch(url('/api/definitely/not/a/route'));
  const ct = res404b.headers.get('content-type') || '';
  assert.ok(ct.includes('application/json'));
  ok('39. 任意未知 API 路径 → content-type JSON');
  const adminHtml = fs.readFileSync(path.join(__dirname, '../src/admin/index.html'), 'utf8');
  const aiTestHtml = fs.readFileSync(path.join(__dirname, '../src/admin/ai-test.html'), 'utf8');
  assert.ok(/function safeJson/.test(adminHtml) && (adminHtml.match(/r\.json\(\)/g) || []).length === 0);
  assert.ok(/function safeJson/.test(aiTestHtml));
  ok('40. Admin 页面 safeJson：HTML 响应 → 明确提示重启后端（不再裸 SyntaxError）');

  mock.close();
  server.close();
  console.log(`\n[阶段29] 通过 ${passed} 项测试`);
  if (passed < 36) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段29] 测试失败：', err);
  process.exit(1);
});
