import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Quest Panel（阶段8 第三十一节）：当前任务/描述/目标进度/分支选择/奖励/剩余时间。
 * 选择只提交给服务器重新验证；所有数据来自服务器（断线恢复安全）。
 */
const STATUS_LABEL = {
  AVAILABLE: '可开始',
  ACTIVE: '进行中',
  PAUSED: '已暂停',
  COMPLETED: '✅ 已完成',
  FAILED: '❌ 已失败',
  ABANDONED: '已放弃',
  LOCKED: '🔒 未解锁',
  SKIPPED: '已跳过',
};

export default function QuestPanel({ onClose, getSessionToken }) {
  const [quests, setQuests] = useState([]);
  const [details, setDetails] = useState({});
  const [error, setError] = useState('');
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const r = await api.getQuests(getSessionToken ? getSessionToken() : null);
      setQuests(r.quests || []);
      const d = {};
      for (const q of (r.quests || []).filter((x) => x.status === 'ACTIVE' || x.status === 'AVAILABLE')) {
        try {
          const det = await api.getQuestInstance(q.questInstanceId, getSessionToken ? getSessionToken() : null);
          d[q.questInstanceId] = det;
        } catch { /* 权限等错误忽略 */ }
      }
      setDetails(d);
    } catch (e) {
      setError(e.message);
    }
  }, [getSessionToken]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => setTick((t) => t + 1), 1000); // 倒计时刷新
    return () => clearInterval(id);
  }, [refresh]);

  const submitChoice = async (qiId, choiceKey, optionId) => {
    setError('');
    try {
      await api.submitQuestChoice(qiId, choiceKey, optionId, getSessionToken ? getSessionToken() : null);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const timeLeft = (deadlineAt) => {
    if (!deadlineAt) return null;
    const ms = new Date(deadlineAt).getTime() - Date.now();
    if (ms <= 0) return '已超时';
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>任务（Quests）</h2>
          <div>
            <button className="btn small" onClick={refresh}>刷新</button>
            <button className="btn small" onClick={onClose}>关闭</button>
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}
        {quests.length === 0 && <p className="muted">当前房间没有任务。进入副本后将自动加载副本任务。</p>}

        {quests.map((q) => {
          const det = details[q.questInstanceId];
          const tl = timeLeft(q.deadlineAt);
          return (
            <div key={q.questInstanceId} className="quest-card">
              <div className="quest-head">
                <strong>{q.questType === 'HIDDEN' ? '❓' : q.questType === 'MAIN' ? '🚪' : '📜'} {q.name}</strong>
                <span className="muted small">{STATUS_LABEL[q.status] || q.status}{tl ? ` · ⏱ ${tl}` : ''} · {q.scope}</span>
              </div>
              {q.description && <p className="dungeon-desc">{q.description}</p>}

              {det && det.objectives && det.objectives.map((o) => {
                const pct = o.required > 0 ? Math.min(100, Math.round((o.count / o.required) * 100)) : 0;
                return (
                  <div key={o.key} className="quest-obj">
                    <span className="quest-obj-status">
                      {o.status === 'COMPLETED' ? '✓' : o.status === 'LOCKED' ? '○' : o.status === 'SKIPPED' ? '–' : '◉'}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div className="quest-obj-name">
                        {o.name} <span className="muted small">{o.count}/{o.required}{o.optional ? '（可选）' : ''}</span>
                      </div>
                      {o.status === 'ACTIVE' && (
                        <div className="token-bar" style={{ height: 6 }}>
                          <div className="token-fill" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {det && det.choices && det.choices.filter((c) => c.status === 'PENDING').map((c) => (
                <div key={c.key} className="action-options" style={{ marginTop: 8 }}>
                  {c.options.map((o) => (
                    <button key={o.id} className="option-btn" onClick={() => submitChoice(q.questInstanceId, c.key, o.id)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
