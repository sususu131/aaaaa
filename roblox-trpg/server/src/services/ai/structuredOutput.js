/**
 * Structured Output：解析 + 校验 + 清洗 AI 的 JSON 回复（Step 10）。
 * 原则：宽容解析、严格上限。任何字段越界都截断/丢弃，绝不让 AI 输出直达状态层。
 */

function extractJson(text) {
  let s = String(text || '').trim();
  // 去掉可能的代码块围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function str(v, max) {
  const s = String(v ?? '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 归一化为标准 gm_response 结构。解析失败返回 null。 */
function parseGmResponse(text) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object') return null;

  const options = Array.isArray(raw.options) ? raw.options.slice(0, 6) : [];
  const cleanOptions = options
    .filter((o) => o && typeof o === 'object')
    .map((o) => ({
      label: str(o.label || o.action, 40),
      action: str(o.action || o.label, 200),
    }))
    .filter((o) => o.label);

  const memoryUpdate = Array.isArray(raw.memory_update) ? raw.memory_update.slice(0, 8) : [];
  const cleanMemory = memoryUpdate
    .filter((m) => m && typeof m === 'object' && m.content)
    .map((m) => ({
      kind: ['important_event', 'npc', 'quest', 'location'].includes(m.kind) ? m.kind : 'important_event',
      content: str(m.content, 300),
    }));

  const ruleRequests = Array.isArray(raw.rule_requests) ? raw.rule_requests.slice(0, 8) : [];
  const cleanRuleRequests = ruleRequests
    .filter((r) => r && typeof r === 'object' && r.type)
    .map((r) => ({ type: str(r.type, 40), payload: r.payload ?? {} }));

  const sourceRefs = Array.isArray(raw.source_references)
    ? raw.source_references.slice(0, 10).map((r) => str(r, 200)).filter(Boolean)
    : [];

  const narrative = str(raw.narrative ?? raw.text ?? raw.message, 2000);
  if (!narrative && cleanOptions.length === 0) return null;

  return {
    type: 'gm_response',
    narrative,
    options: cleanOptions,
    events: Array.isArray(raw.events) ? raw.events.slice(0, 10) : [],
    memory_update: cleanMemory,
    rule_requests: cleanRuleRequests,
    source_references: sourceRefs,
  };
}

module.exports = { parseGmResponse, extractJson };
