/**
 * OpenAI 兼容 Provider（OpenAI / DeepSeek-OpenAI / 各类兼容网关）。
 * 原生格式：choices[].message.tool_calls + role:'tool' 结果。
 */
const { AiProvider, AiError, getAiRuntimeConfig, postJson, safeParseArgs } = require('./AiProvider');

function toNativeTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

class OpenAIProvider extends AiProvider {
  startSession({ system, userContent }) {
    return {
      format: 'openai',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    };
  }

  async chat(session, tools) {
    const cfg = getAiRuntimeConfig();
    if (!cfg.apiKey) throw new AiError('unconfigured', 'AI服务未配置（服务端未设置 AI_API_KEY）');

    const body = {
      model: cfg.model,
      messages: session.messages,
      temperature: 0.8,
      max_tokens: 1500,
    };
    if (tools && tools.length) {
      body.tools = toNativeTools(tools);
      body.tool_choice = 'auto';
    }

    const data = await postJson(`${cfg.baseUrl}/chat/completions`, { Authorization: `Bearer ${cfg.apiKey}` }, body, cfg.timeoutMs);

    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new AiError('bad_format', 'GM回复为空，请重试');

    // DeepSeek 等可能附带 reasoning_content（思考过程）——绝不外显，仅内部丢弃
    const toolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((tc) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
          name: tc.function && tc.function.name,
          args: safeParseArgs(tc.function && tc.function.arguments),
        }))
      : [];

    session.messages.push(msg); // 保留原生 assistant 消息
    return { content: msg.content || '', toolCalls, finish: toolCalls.length ? 'tool_calls' : 'stop' };
  }

  appendToolResults(session, results) {
    for (const r of results) {
      session.messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }
}

module.exports = { OpenAIProvider };
