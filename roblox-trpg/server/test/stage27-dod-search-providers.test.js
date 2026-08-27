/**
 * 阶段27 测试：Web 搜索多 Provider（serper/bing/brave/tavily/duckduckgo[免Key]/null）（36 项）。
 * 用本地 mock HTTP 服务验证各 Provider 的请求构造与结果归一化（title/link/snippet/source）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(path.join(__dirname, '../../database/data/roblox_trpg.db' + suffix), { force: true });
}

process.env.AI_API_KEY = 'ai-key-s27';
process.env.AI_BASE_URL = 'http://127.0.0.1:4127/v1';
process.env.AI_MODEL = 'mock-s27';
process.env.AI_STREAM = 'off';

const { server } = require('../src/index.js');
const presetSeeder = require('../src/services/presets/presetSeeder');
const settingsService = require('../src/services/settingsService');
const sp = require('../src/services/search/SearchProvider');

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };

// ── 本地 mock 搜索服务（验证请求构造 + 响应归一化）──
const lastReq = { headers: {}, body: '', url: '' };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastReq.headers = req.headers;
    lastReq.body = body;
    lastReq.url = req.url;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/serper')) {
      res.end(JSON.stringify({ organic: [
        { title: 'Roblox', link: 'https://www.roblox.com', snippet: 's1' },
        { title: 'DoD Wiki', link: 'https://die-of-death.fandom.com', snippet: 's2' },
      ] }));
    } else if (req.url.startsWith('/bing')) {
      res.end(JSON.stringify({ webPages: { value: [
        { name: 'Bing Roblox', url: 'https://www.roblox.com', snippet: 'b1' },
        { name: 'Bing DoD', url: 'https://die-of-death.fandom.com', snippet: 'b2' },
      ] } }));
    } else if (req.url.startsWith('/brave')) {
      res.end(JSON.stringify({ web: { results: [
        { title: 'Brave Roblox', url: 'https://www.roblox.com', description: 'v1' },
        { title: 'Brave DoD', url: 'https://die-of-death.fandom.com', description: 'v2' },
      ] } }));
    } else if (req.url.startsWith('/tavily')) {
      res.end(JSON.stringify({ results: [
        { title: 'Tavily Roblox', url: 'https://www.roblox.com', content: 't1' },
        { title: 'Tavily DoD', url: 'https://die-of-death.fandom.com', content: 't2' },
      ] }));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.roblox.com%2Fgames&amp;rut=x">Roblox &amp; Games</a>' +
        '<a class="result__snippet" href="#">Roblox is <b>the ultimate</b> virtual universe</a>' +
        '<a rel="nofollow" class="result__a" href="https://die-of-death.fandom.com/wiki/Lore">DoD Lore Wiki</a>' +
        '<a class="result__snippet" href="#">Die of Death lore page</a>'
      );
    }
  });
});

async function main() {
  console.log('[test] 阶段27 就绪（36 项）\n');
  presetSeeder.runPresetSeeder(fakeIo);
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mPort = mock.address().port;
  const base = (p) => `http://127.0.0.1:${mPort}/${p}`;

  // ══ A. Provider 解析（DB > env；缺 Key 回落 Null）══
  assert.strictEqual(sp.getSearchProvider().constructor.name, 'NullSearchProvider');
  ok('1. 默认 null（不可用，不编造）');
  settingsService.setSettings({ 'search.provider': 'bing' });
  assert.strictEqual(sp.getSearchProvider().constructor.name, 'NullSearchProvider');
  ok('2. bing 无 Key → 仍 Null（Key 必需）');
  settingsService.setSettings({ 'search.provider': 'bing', 'search.bing_api_key': 'bing-key-1234567890' });
  assert.strictEqual(sp.getSearchProvider().constructor.name, 'BingSearchProvider');
  ok('3. bing + Key → BingSearchProvider');
  settingsService.setSettings({ 'search.provider': 'brave', 'search.brave_api_key': 'brave-key-1234567890' });
  assert.strictEqual(sp.getSearchProvider().constructor.name, 'BraveSearchProvider');
  ok('4. brave + Key → BraveSearchProvider');
  settingsService.setSettings({ 'search.provider': 'tavily', 'search.tavily_api_key': 'tavily-key-123456789' });
  assert.strictEqual(sp.getSearchProvider().constructor.name, 'TavilySearchProvider');
  ok('5. tavily + Key → TavilySearchProvider');
  settingsService.setSettings({ 'search.provider': 'duckduckgo', 'search.bing_api_key': '', 'search.brave_api_key': '', 'search.tavily_api_key': '' });
  assert.strictEqual(sp.getSearchProvider().constructor.name, 'DuckDuckGoSearchProvider');
  ok('6. duckduckgo 免 Key 即可用');
  process.env.BING_API_KEY = 'env-bing-key-abcdef123456';
  settingsService.setSetting('search.provider', 'bing');
  settingsService.setSetting('search.bing_api_key', '');
  assert.strictEqual(sp.resolveSearchKey('bing'), 'env-bing-key-abcdef123456');
  ok('7. Key 回落 env（BING_API_KEY）');
  settingsService.setSetting('search.bing_api_key', 'db-bing-key-6543210987');
  assert.strictEqual(sp.resolveSearchKey('bing'), 'db-bing-key-6543210987');
  ok('8. DB Key 优先于 env');
  delete process.env.BING_API_KEY;
  settingsService.setSettings({ 'search.provider': 'null', 'search.bing_api_key': '' });

  // ══ B. adminView：providers 概览 ══
  settingsService.setSettings({ 'search.provider': 'duckduckgo', 'search.serper_api_key': 'serper-key-abcdef123456' });
  const view = settingsService.adminView();
  assert.ok(view.search.provider === 'duckduckgo' && view.search.available === true);
  ok('9. adminView：duckduckgo available（免 Key）');
  assert.ok(view.search.providers.serper.hasKey && view.search.providers.serper.masked.includes('…'));
  ok('10. adminView：serper Key 打码显示');
  assert.ok(['bing', 'brave', 'tavily'].every((p) => view.search.providers[p] && typeof view.search.providers[p].hasKey === 'boolean'));
  ok('11. adminView：四个 Key Provider 全部在概览中');
  settingsService.setSettings({ 'search.provider': 'serper', 'search.serper_api_key': '' });
  assert.strictEqual(settingsService.adminView().search.available, false);
  ok('12. serper 无 Key → available=false');

  // ══ C. 各 Provider 请求构造 + 结果归一化（mock 服务）══
  const norm = ['title', 'link', 'snippet', 'source'];
  const r1 = await new sp.SerperSearchProvider('sk-serper', base('serper')).search('roblox');
  assert.ok(r1.length === 2 && r1[0].title === 'Roblox' && r1.every((x) => norm.every((k) => x[k] !== undefined)));
  ok('13. serper：结果归一化（title/link/snippet/source）');
  assert.strictEqual(lastReq.headers['x-api-key'], 'sk-serper');
  ok('14. serper：X-API-KEY 请求头');
  const r2 = await new sp.BingSearchProvider('sk-bing', base('bing')).search('roblox');
  assert.ok(r2.length === 2 && r2[0].title === 'Bing Roblox' && r2[0].link === 'https://www.roblox.com');
  ok('15. bing：webPages.value → 归一化（name/url/snippet）');
  assert.ok(lastReq.headers['ocp-apim-subscription-key'] === 'sk-bing' && /q=roblox/.test(lastReq.url));
  ok('16. bing：Ocp-Apim-Subscription-Key 头 + q 参数');
  const r3 = await new sp.BraveSearchProvider('sk-brave', base('brave')).search('roblox');
  assert.ok(r3.length === 2 && r3[1].title === 'Brave DoD' && r3[1].snippet === 'v2');
  ok('17. brave：web.results → 归一化（description→snippet）');
  assert.strictEqual(lastReq.headers['x-subscription-token'], 'sk-brave');
  ok('18. brave：X-Subscription-Token 头');
  const r4 = await new sp.TavilySearchProvider('sk-tavily', base('tavily')).search('roblox');
  assert.ok(r4.length === 2 && r4[0].title === 'Tavily Roblox' && r4[0].snippet === 't1');
  ok('19. tavily：results → 归一化（content→snippet）');
  assert.ok(JSON.parse(lastReq.body).api_key === 'sk-tavily' && JSON.parse(lastReq.body).query === 'roblox');
  ok('20. tavily：POST body 携带 api_key/query');
  const r5 = await new sp.DuckDuckGoSearchProvider(base('ddg')).search('roblox');
  assert.ok(r5.length === 2 && r5[0].link === 'https://www.roblox.com/games' && r5[0].title === 'Roblox & Games');
  ok('21. duckduckgo：uddg 链接解码 + 标题实体解码');
  assert.ok(r5[0].snippet === 'Roblox is the ultimate virtual universe');
  ok('22. duckduckgo：snippet 去标签');
  assert.strictEqual(r5[1].link, 'https://die-of-death.fandom.com/wiki/Lore');
  ok('23. duckduckgo：普通 http 链接直接保留');
  assert.ok(r5.every((x) => x.source === 'web_search'));
  ok('24. 所有 Provider source=web_search（web_search 工具兼容）');

  // ══ D. DDG 解析单元 ══
  assert.strictEqual(sp.unwrapDdgLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fq%3D1&rut=z'), 'https://example.com/a?q=1');
  ok('25. unwrapDdgLink：URL 解码正确');
  assert.strictEqual(sp.unwrapDdgLink('https://plain.example.com/x'), 'https://plain.example.com/x');
  ok('26. unwrapDdgLink：非重定向链接透传');
  assert.strictEqual(sp.unwrapDdgLink('//duckduckgo.com/l/?rut=only'), '');
  ok('27. unwrapDdgLink：无 uddg → 空（丢弃）');
  const parsed = sp.parseDuckDuckGoHtml('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com">X</a>');
  assert.strictEqual(parsed.length, 1);
  ok('28. parseDuckDuckGoHtml：导出可单测');

  // ══ E. web_search 工具链路（不可用 / 可用）══
  settingsService.setSettings({ 'search.provider': 'null', 'search.serper_api_key': '' });
  const tools = require('../src/services/ai/tools');
  let unavailable = false;
  try {
    await tools.runTool({ room: { id: 'S27' } }, 'web_search', { query: 'roblox' });
  } catch (e) {
    unavailable = e.kind === 'search_unavailable';
  }
  assert.ok(unavailable);
  ok('29. web_search 工具：null provider → SEARCH_UNAVAILABLE（不编造）');
  // duckduckgo 指向 mock：工具层真实走通
  settingsService.setSetting('search.provider', 'duckduckgo');
  const origFetch = global.fetch;
  global.fetch = (u, opts) => origFetch(String(u).replace('https://html.duckduckgo.com/html/', base('ddg')), opts);
  const toolRes = await tools.runTool({ room: { id: 'S27' }, broadcast: () => {} }, 'web_search', { query: 'roblox' });
  global.fetch = origFetch;
  assert.ok(toolRes.ok && toolRes.resultCount >= 1 && toolRes.fence.includes('UNTRUSTED_EXTERNAL_DATA'));
  ok('30. web_search 工具：duckduckgo（免 Key）返回围栏结果');
  assert.ok(toolRes.sources.every((s) => s.url.startsWith('http')));
  ok('31. 来源 URL 全部来自 Provider（编号引用）');

  // ══ F. REST + UI ══
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const resSave = await fetch(url('/api/admin/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ search: { provider: 'brave', brave_api_key: 'brave-live-key-9876543210' } }),
  }).then((r) => r.json());
  assert.ok(resSave.view.search.provider === 'brave' && resSave.view.search.available === true && resSave.view.search.providers.brave.masked.includes('…'));
  ok('32. REST：保存 brave Provider + Key（打码回显）');
  const html = await fetch(url('/admin')).then((r) => r.text());
  assert.ok(/value="serper"/.test(html) && /value="bing"/.test(html) && /value="brave"/.test(html) && /value="tavily"/.test(html) && /value="duckduckgo"/.test(html));
  ok('33. UI：下拉含全部 6 个 Provider 选项');
  assert.ok(/SEARCH_KEY_LABELS/.test(html) && /Ocp-Apim-Subscription-Key/.test(html));
  ok('34. UI：按 Provider 切换 Key 输入标签');
  assert.ok(/onProviderChange/.test(html) && /duckduckgo（免 Key/.test(html));
  ok('35. UI：免 Key Provider 隐藏 Key 输入');
  await fetch(url('/api/admin/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ search: { provider: '', brave_api_key: '' } }),
  });
  const resSearchTest = await fetch(url('/api/admin/search/test'), { method: 'POST' }).then((r) => r.json());
  assert.ok(resSearchTest.ok === false && resSearchTest.provider === 'NullSearchProvider');
  ok('36. 清除后搜索测试：明确不可用');

  mock.close();
  server.close();
  console.log(`\n[阶段27] 通过 ${passed} 项测试`);
  if (passed < 32) {
    console.error('测试数量不足！');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[阶段27] 测试失败：', err);
  process.exit(1);
});
