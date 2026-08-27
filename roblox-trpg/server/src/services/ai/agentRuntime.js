/**
 * Agent Runtime（阶段7 核心）：真正的多轮 Tool Calling Loop。
 *
 *   User → AI → Tool → Server → Tool Result → AI → … → Final Answer
 *
 * 支持 0/1/多轮工具调用；MAX_TOOL_ROUNDS（默认8）安全停止；
 * 预算：max_tools / max_searches / max_duration；
 * 每次 Tool Call：parse → schema → permission → game state → rate limit → execute；
 * 全程 Tool Trace（agent_runs / agent_tool_calls）+ Streaming 事件钩子。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const tools = require('./tools');
const {
  AGENT_MAX_TOOL_ROUNDS,
  AGENT_MAX_TOOLS,
  AGENT_MAX_SEARCHES,
  AGENT_MAX_DURATION_MS,
} = require('../../config');

class AgentBudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // MAX_TOOL_ROUNDS / MAX_TOOLS / MAX_SEARCHES / MAX_DURATION
  }
}

function createRun({ roomId, instanceId, playerRowId, scope, budget }) {
  const db = getDb();
  const uid = `agent_${crypto.randomBytes(4).toString('hex')}`;
  const info = db
    .prepare(
      `INSERT INTO agent_runs (uid, room_id, instance_id, player_id, scope, status, budget) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?)`
    )
    .run(uid, roomId || null, instanceId || null, playerRowId || null, scope, JSON.stringify(budget));
  return { id: info.lastInsertRowid, uid };
}

function finishRun(run, status, { rounds, toolCalls, searches, error } = {}) {
  getDb()
    .prepare(
      `UPDATE agent_runs SET status = ?, rounds = ?, tool_calls = ?, searches = ?, error = ?, completed_at = datetime('now') WHERE id = ?`
    )
    .run(status, rounds || 0, toolCalls || 0, searches || 0, error || null, run.id);
}

function recordToolCall(run, round, call, resultText, status, durationMs) {
  try {
    getDb()
      .prepare(
        `INSERT INTO agent_tool_calls (agent_run_id, round, tool_call_id, tool_name, arguments, result, duration_ms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        round,
        call.id || null,
        call.name,
        JSON.stringify(call.args || {}).slice(0, 800),
        String(resultText).slice(0, 500),
        durationMs,
        status
      );
  } catch { /* trace 失败不影响主流程 */ }
}

const SEARCH_TOOLS = new Set(['web_search', 'roblox_search', 'search_roblox_experiences']);

/**
 * 运行 Agent Loop。
 * @returns {{finalText, finishReason, rounds, toolCallCount, searchCount, runUid, status, usage}}
 */
async function runAgentLoop({ provider, system, userContent, scope, toolCtx, budgetOverrides = {}, onEvent = () => {}, useStream = false }) {
  const budget = {
    maxRounds: budgetOverrides.maxRounds || AGENT_MAX_TOOL_ROUNDS,
    maxTools: budgetOverrides.maxTools || AGENT_MAX_TOOLS,
    maxSearches: budgetOverrides.maxSearches || AGENT_MAX_SEARCHES,
    maxDurationMs: budgetOverrides.maxDurationMs || AGENT_MAX_DURATION_MS,
  };
  const run = createRun({
    roomId: toolCtx.room && toolCtx.room.id,
    instanceId: toolCtx.instance && toolCtx.instance.id,
    playerRowId: toolCtx.playerRowId || null,
    scope,
    budget,
  });

  const startedAt = Date.now();
  const session = provider.startSession({ system, userContent });
  const allowed = tools.toolsForScope(scope);
  const allowedNames = new Set(allowed.map((t) => t.name));
  const seenToolCallIds = new Set();

  let rounds = 0;
  let toolCallCount = 0;
  let searchCount = 0;
  let lastUsage = null;
  let finalText = null;
  let finishReason = null;

  const emit = (evt) => {
    try {
      onEvent(evt);
    } catch { /* 事件回调失败不阻塞 */ }
  };

  emit({ type: 'AI_START', runUid: run.uid, scope });

  try {
    for (let round = 1; round <= budget.maxRounds; round += 1) {
      rounds = round;
      if (Date.now() - startedAt > budget.maxDurationMs) {
        throw new AgentBudgetError('MAX_DURATION', 'Agent 运行超时（预算限制），安全停止');
      }

      // Context 规模预检（每轮都可能增长）：超过上下文预算则停止，避免失控
      const approxTokens = Math.ceil(JSON.stringify(session.messages || session.items || []).length / 4);
      emit({ type: 'AI_CONTEXT_CHECK', round, approxTokens });

      emit({ type: 'AI_THINKING', round });
      let res;
      if (useStream && typeof provider.stream === 'function') {
        res = await provider.stream(session, allowed, emit);
      } else {
        const r = await provider.chat(session, allowed);
        res = r.normalized || { type: 'agent_response', text: r.content, reasoning: '', toolCalls: r.toolCalls, usage: r.usage, finishReason: r.finish, raw: null };
      }
      lastUsage = res.usage || lastUsage;
      if (res.reasoning) emit({ type: 'AI_REASONING', text: String(res.reasoning).slice(0, 500) });

      // 最终回答判定：依据 finish_reason / tool_calls 状态（不依赖 content != null）
      const hasToolCalls = Array.isArray(res.toolCalls) && res.toolCalls.length > 0;
      if (!hasToolCalls || res.finishReason === 'stop') {
        finalText = res.text || '';
        finishReason = res.finishReason || 'stop';
        break;
      }

      // ── 同一轮可能有多个 Tool Call：全部执行，不只读 tool_calls[0] ──
      const results = [];
      for (const call of res.toolCalls) {
        const t0 = Date.now();
        toolCallCount += 1;
        if (toolCallCount > budget.maxTools) {
          recordToolCall(run, round, call, 'MAX_TOOLS 预算用尽', 'ERROR', 0);
          throw new AgentBudgetError('MAX_TOOLS', '工具调用次数超过预算，安全停止');
        }
        emit({ type: 'AI_TOOL_START', round, toolCallId: call.id, tool: call.name });

        // 1) tool_call_id 幂等（重复调用去重）
        if (seenToolCallIds.has(call.id)) {
          recordToolCall(run, round, call, 'DEDUP', 'DEDUP', Date.now() - t0);
          results.push({ id: call.id, content: JSON.stringify({ ok: false, error: 'TOOL_CALL_DUPLICATED（同一 tool_call_id 只执行一次）', error_code: 'DEDUP' }) });
          emit({ type: 'AI_TOOL_RESULT', round, tool: call.name, ok: false, dedup: true });
          continue;
        }
        seenToolCallIds.add(call.id);

        // 2) 未知工具
        if (!allowedNames.has(call.name)) {
          recordToolCall(run, round, call, `UNKNOWN_TOOL: ${call.name}`, 'UNKNOWN_TOOL', Date.now() - t0);
          results.push({ id: call.id, content: JSON.stringify({ ok: false, error: `工具 "${call.name}" 不存在或当前范围不可用`, error_code: 'UNKNOWN_TOOL' }) });
          emit({ type: 'AI_TOOL_RESULT', round, tool: call.name, ok: false, unknown: true });
          continue;
        }

        // 3) 参数非法 JSON（safeParseArgs 已标记）
        if (call.args && call.args.__parse_error) {
          recordToolCall(run, round, call, 'AI_TOOL_ARGUMENT_INVALID', 'INVALID_ARGS', Date.now() - t0);
          results.push({ id: call.id, content: JSON.stringify({ ok: false, error: '工具参数不是合法 JSON，请修正后重试', error_code: 'AI_TOOL_ARGUMENT_INVALID' }) });
          emit({ type: 'AI_TOOL_RESULT', round, tool: call.name, ok: false, invalidArgs: true });
          continue;
        }

        // 4) 搜索预算（超过立即停止，第37节）
        if (SEARCH_TOOLS.has(call.name)) {
          searchCount += 1;
          if (searchCount > budget.maxSearches) {
            recordToolCall(run, round, call, 'MAX_SEARCHES 预算用尽', 'RATE_LIMITED', Date.now() - t0);
            throw new AgentBudgetError('MAX_SEARCHES', '搜索次数超过预算（MAX_SEARCHES），安全停止');
          }
          emit({ type: 'AI_SEARCH_START', round, tool: call.name, query: (call.args && (call.args.query || call.args.queries)) || '' });
        }

        // 5) 执行（schema/权限/游戏状态验证在 tools.runTool 内）
        let outcome;
        let status = 'OK';
        try {
          outcome = await tools.runTool({ ...toolCtx, agentRunUid: run.uid }, call.name, call.args);
          if (outcome && outcome.ok === false) status = 'ERROR';
        } catch (err) {
          status = 'ERROR';
          outcome = { ok: false, error: err.message, error_code: err.kind || 'TOOL_ERROR', success: false };
        }
        const duration = Date.now() - t0;
        recordToolCall(run, round, call, JSON.stringify(outcome), status, duration);
        results.push({ id: call.id, content: JSON.stringify(outcome).slice(0, 1500) });
        emit({ type: 'AI_TOOL_RESULT', round, tool: call.name, ok: Boolean(outcome && outcome.ok), durationMs: duration });
      }

      provider.appendToolResults(session, results);
    }

    if (finalText === null) {
      // 达到 MAX_TOOL_ROUNDS 仍未收敛：安全停止
      finalText = '（GM 推演轮次达到上限，已安全停止；请重新描述你的行动。）';
      finishReason = 'max_rounds';
      finishRun(run, 'STOPPED', { rounds, toolCalls: toolCallCount, searches: searchCount, error: 'MAX_TOOL_ROUNDS' });
      emit({ type: 'AI_ERROR', code: 'MAX_TOOL_ROUNDS', message: '工具轮次达到上限' });
    } else {
      finishRun(run, 'COMPLETED', { rounds, toolCalls: toolCallCount, searches: searchCount });
    }
    emit({ type: 'AI_COMPLETE', runUid: run.uid, rounds, toolCalls: toolCallCount, searches: searchCount });
    return { finalText, finishReason, rounds, toolCallCount, searchCount, runUid: run.uid, status: 'COMPLETED', usage: lastUsage };
  } catch (err) {
    const code = err instanceof AgentBudgetError ? err.code : err.kind || 'AGENT_ERROR';
    finishRun(run, code === 'MAX_DURATION' || code === 'MAX_TOOLS' || code === 'MAX_SEARCHES' ? 'STOPPED' : 'FAILED', {
      rounds,
      toolCalls: toolCallCount,
      searches: searchCount,
      error: err.message,
    });
    emit({ type: 'AI_ERROR', code, message: err.message });
    throw err;
  }
}

module.exports = { runAgentLoop, AgentBudgetError };
