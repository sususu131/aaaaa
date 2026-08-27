/**
 * OpenAI 兼容 Provider（OpenAI / DeepSeek / 各类兼容网关）。
 * 阶段7：AgentResponse 归一化 + Streaming（SSE）+ reasoning_content 透传（DeepSeek Thinking Mode）。
 */
const { AiProvider, AiError, getAiRuntimeConfig, postJson, safeParseArgs } = require('./AiProvider');

function toNativeTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** 统一内部格式 AgentResponse（第十八节）。 */
function normalize(msg, data) {
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
        name: tc.function && tc.function.name,
        args: safeParseArgs(tc.function && tc.function.arguments),
        rawArguments: tc.function ? tc.function.arguments : null,
      }))
    : [];
  return {
    type: 'agent_response',
    text: msg.content || '',
    reasoning: msg.reasoning_content || '', // DeepSeek Thinking Mode：保存并透传，绝不丢弃
    toolCalls,
    usage: data && data.usage ? data.usage : null,
    finishReason: (data && data.choices && data.choices[0] && data.choices[0].finish_reason) || (toolCalls.length ? 'tool_calls' : 'stop'),
    raw: msg,
  };
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

    session.messages.push(msg); // 保留原生 assistant 消息（含 reasoning_content，多轮透传）
    const res = normalize(msg, data);
    return { content: res.text, toolCalls: res.toolCalls, finish: res.finishReason === 'tool_calls' || res.toolCalls.length ? 'tool_calls' : 'stop', usage: res.usage, normalized: res };
  }

  /** Streaming（阶段7 第十九节）：SSE 解析，实时回调 delta；失败抛 AiError。 */
  async stream(session, tools, onEvent) {
    const cfg = getAiRuntimeConfig();
    if (!cfg.apiKey) throw new AiError('unconfigured', 'AI服务未配置（服务端未设置 AI_API_KEY）');
    const body = { model: cfg.model, messages: session.messages, temperature: 0.8, max_tokens: 1500, stream: true };
    if (tools && tools.length) {
      body.tools = toNativeTools(tools);
      body.tool_choice = 'auto';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const { classifyStatus } = require('./AiProvider');
        throw classifyStatus(res.status);
      }
      // 兼容：端点不支持流式（返回普通 JSON）→ 按 chat 路径解析
      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('application/json')) {
        const data = await res.json();
        const msg = data && data.choices && data.choices[0] && data.choices[0].message;
        if (!msg) throw new AiError('bad_format', 'GM回复为空，请重试');
        session.messages.push(msg);
        return normalize(msg, data);
      }
      // SSE 逐行解析
      let content = '';
      let reasoning = '';
      const toolCallAcc = new Map(); // index -> {id, name, argsStr}
      let finishReason = null;
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let evt;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
          if (!delta) continue;
          if (evt.choices[0].finish_reason) finishReason = evt.choices[0].finish_reason;
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            if (onEvent) onEvent({ type: 'AI_REASONING_DELTA', text: delta.reasoning_content });
          }
          if (delta.content) {
            content += delta.content;
            if (onEvent) onEvent({ type: 'AI_TEXT_DELTA', text: delta.content });
          }
          for (const tc of delta.tool_calls || []) {
            const acc = toolCallAcc.get(tc.index) || { id: tc.id || '', name: '', argsStr: '' };
            if (tc.id) acc.id = tc.id;
            if (tc.function && tc.function.name) acc.name += tc.function.name;
            if (tc.function && tc.function.arguments) acc.argsStr += tc.function.arguments;
            toolCallAcc.set(tc.index, acc);
            if (onEvent) onEvent({ type: 'AI_TOOL_ARGUMENTS', index: tc.index, name: acc.name, argsDelta: (tc.function && tc.function.arguments) || '' });
          }
        }
      }
      const toolCalls = [...toolCallAcc.values()].map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
        name: tc.name,
        args: safeParseArgs(tc.argsStr),
        rawArguments: tc.argsStr,
      }));
      const msg = { role: 'assistant', content, reasoning_content: reasoning || undefined };
      if (toolCalls.length) {
        msg.tool_calls = toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.rawArguments } }));
      }
      session.messages.push(msg);
      return {
        type: 'agent_response',
        text: content,
        reasoning,
        toolCalls,
        usage: null,
        finishReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
        raw: msg,
      };
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (err.name === 'AbortError') throw new AiError('timeout', 'GM暂时无法回应，请稍后再试（请求超时）');
      throw new AiError('server_error', `GM暂时无法回应（网络错误：${err.message}）`);
    } finally {
      clearTimeout(timer);
    }
  }

  appendToolResults(session, results) {
    for (const r of results) {
      session.messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }
}

module.exports = { OpenAIProvider, normalize };
