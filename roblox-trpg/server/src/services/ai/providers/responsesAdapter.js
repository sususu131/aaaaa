/**
 * Responses API Adapter（阶段7 第十七节）：与 Chat Completions 严格分离。
 * 支持事件：message / function_call / function_call_output / web_search_call。
 * 会话模型：无状态列表（input 携带全部 items），服务器保留 items 历史。
 */
const { AiProvider, AiError, getAiRuntimeConfig, postJson, safeParseArgs } = require('./AiProvider');

function toTools(tools) {
  return tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema }));
}

class ResponsesProvider extends AiProvider {
  startSession({ system, userContent }) {
    return {
      format: 'responses',
      instructions: system,
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: userContent }] }],
    };
  }

  async chat(session, tools) {
    const cfg = getAiRuntimeConfig();
    if (!cfg.apiKey) throw new AiError('unconfigured', 'AI服务未配置（服务端未设置 AI_API_KEY）');
    const body = { model: cfg.model, instructions: session.instructions, input: session.items };
    if (tools && tools.length) body.tools = toTools(tools);

    const data = await postJson(`${cfg.baseUrl}/responses`, { Authorization: `Bearer ${cfg.apiKey}` }, body, cfg.timeoutMs);

    // 解析事件流（非流式响应返回 output 数组）
    const output = Array.isArray(data.output) ? data.output : [];
    let text = '';
    const toolCalls = [];
    for (const item of output) {
      if (item.type === 'message') {
        for (const c of item.content || []) {
          if (c.type === 'output_text') text += c.text || '';
        }
        session.items.push(item);
      } else if (item.type === 'function_call') {
        toolCalls.push({ id: item.call_id || item.id, name: item.name, args: safeParseArgs(item.arguments), rawArguments: item.arguments });
        session.items.push(item);
      } else if (item.type === 'web_search_call') {
        // Provider 内置搜索事件：记录但不直接信任结果
        session.items.push(item);
      }
    }
    return {
      content: text,
      toolCalls,
      finish: toolCalls.length ? 'tool_calls' : 'stop',
      usage: data.usage || null,
      normalized: { type: 'agent_response', text, reasoning: '', toolCalls, usage: data.usage || null, finishReason: data.status === 'completed' ? (toolCalls.length ? 'tool_calls' : 'stop') : data.status, raw: output },
    };
  }

  appendToolResults(session, results) {
    for (const r of results) {
      session.items.push({ type: 'function_call_output', call_id: r.id, output: r.content });
    }
  }
}

module.exports = { ResponsesProvider };
