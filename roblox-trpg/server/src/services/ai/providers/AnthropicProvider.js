/**
 * Anthropic Messages Provider（含 DeepSeek-Anthropic 风格第三方网关）。
 * 原生格式：content[] 中的 thinking / tool_use / text；工具结果为 user 消息的
 * content[].type='tool_result'。thinking 块保留在历史中（API 要求），但绝不外显。
 */
const { AiProvider, AiError, getAiRuntimeConfig, postJson } = require('./AiProvider');

function toNativeTools(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

class AnthropicProvider extends AiProvider {
  startSession({ system, userContent }) {
    return {
      format: 'anthropic',
      system,
      messages: [{ role: 'user', content: userContent }],
    };
  }

  async chat(session, tools) {
    const cfg = getAiRuntimeConfig();
    if (!cfg.apiKey) throw new AiError('unconfigured', 'AI服务未配置（服务端未设置 AI_API_KEY）');

    const body = {
      model: cfg.model,
      max_tokens: 1500,
      system: session.system,
      messages: session.messages,
    };
    if (tools && tools.length) body.tools = toNativeTools(tools);

    const data = await postJson(
      `${cfg.baseUrl}/messages`,
      { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body,
      cfg.timeoutMs
    );

    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const toolCalls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input && typeof b.input === 'object' ? b.input : {} }));

    // 保留完整 assistant content（含 thinking 块，API 多轮需要）
    session.messages.push({ role: 'assistant', content: blocks });
    return { content: text, toolCalls, finish: data.stop_reason === 'tool_use' || toolCalls.length ? 'tool_calls' : 'stop' };
  }

  appendToolResults(session, results) {
    session.messages.push({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })),
    });
  }
}

module.exports = { AnthropicProvider };
