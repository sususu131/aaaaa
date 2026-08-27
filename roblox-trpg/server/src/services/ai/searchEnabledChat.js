/**
 * 阶段22：让所有单轮 LLM 调用点也具备 websearch 能力。
 * 主 Agent 循环（GM 聊天 / 副本运行时）本来就带全部工具（含 web_search）；
 * 这里为"一次性调用"（摘要 / 副本设计 Structured Output）提供可选搜索轮：
 *  - 只放行 web_search / roblox_search（其他写工具一律拒绝，防止摘要/设计路径越权）；
 *  - 搜索次数受 maxSearches 预算限制；
 *  - 无工具调用时行为与 provider.chat(session, []) 完全一致。
 */
const tools = require('./tools');
const { getProvider } = require('./providers');

const SEARCH_ONLY = ['web_search', 'roblox_search'];

function searchToolDefs() {
  return tools.toolDefinitions().filter((t) => SEARCH_ONLY.includes(t.name));
}

/**
 * 单轮 LLM 调用 + 可选搜索轮。
 * @param {object} session provider.startSession(...) 的会话
 * @param {object} opts { toolCtx, maxSearches = 2 }
 * @returns provider.chat 的最终结果（content 为最终文本）
 */
async function chatWithWebSearch(session, { toolCtx = {}, maxSearches = 2 } = {}) {
  const provider = getProvider();
  const defs = searchToolDefs();
  let res = await provider.chat(session, defs);
  let searches = 0;
  // 允许模型先搜索再作答（预算内）；非搜索工具一律拒绝
  while (Array.isArray(res.toolCalls) && res.toolCalls.length && searches < maxSearches) {
    const results = [];
    for (const call of res.toolCalls) {
      if (!SEARCH_ONLY.includes(call.name)) {
        results.push({ id: call.id, content: JSON.stringify({ ok: false, error: '此路径只允许搜索工具（web_search/roblox_search）' }) });
        continue;
      }
      searches += 1;
      let outcome;
      try {
        outcome = await tools.runTool(toolCtx, call.name, call.args);
      } catch (err) {
        outcome = { ok: false, error: err.message };
      }
      const text = JSON.stringify(outcome);
      results.push({ id: call.id, content: text.length > 1500 ? `${text.slice(0, 1500)}…(截断)` : text });
    }
    provider.appendToolResults(session, results);
    res = await provider.chat(session, defs);
  }
  return res;
}

module.exports = { chatWithWebSearch, SEARCH_ONLY };
