import { useCallback, useEffect, useState } from 'react';
import { socket } from '../lib/socket.js';

const TYPE_LABEL = { NORMAL: '剧情选择', TIMED: '⏱ 限时选择', PARTY: '🗳 团队决策' };

/**
 * 决策面板（阶段13）：剧情文本 / 选项按钮 / 倒计时（限时选择显著显示剩余时间）。
 * 倒计时只是显示 —— 计时与结算全部在服务器（超时自动执行默认选项）。
 */
export default function DecisionPanel({ onClose, getSessionToken }) {
  const [decisions, setDecisions] = useState([]);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [busyKey, setBusyKey] = useState('');

  const token = () => (getSessionToken ? getSessionToken() : null);

  const refresh = useCallback(async () => {
    try {
      const t = token();
      const res = await fetch(`/api/decisions${t ? `?sessionToken=${encodeURIComponent(t)}` : ''}`).then((r) => r.json());
      setDecisions(res.decisions || []);
    } catch (e) {
      setError(e.message);
    }
  }, [getSessionToken]);

  useEffect(() => {
    refresh();
    const onUpdate = () => refresh();
    socket.on('decision:new', onUpdate);
    socket.on('decision:update', onUpdate);
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => {
      socket.off('decision:new', onUpdate);
      socket.off('decision:update', onUpdate);
      clearInterval(tick);
    };
  }, [refresh]);

  const choose = async (uid, optionKey) => {
    setBusyKey(`${uid}:${optionKey}`);
    setError('');
    try {
      const res = await fetch(`/api/decisions/${encodeURIComponent(uid)}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionKey, sessionToken: token() || undefined }),
      }).then((r) => r.json());
      if (res.error) setError(res.error);
      await refresh();
    } finally {
      setBusyKey('');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>🎭 抉择（Decisions）</h2>
          <div>
            <button className="btn small" onClick={refresh}>刷新</button>
            <button className="btn small" onClick={onClose}>关闭</button>
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}
        {decisions.length === 0 && <p className="muted">当前没有等待中的选择。剧情选择由 GM 发起，结果由服务器结算。</p>}

        {decisions.map((d) => {
          const remaining = d.remainingMs !== null ? Math.max(0, new Date(d.expiresAt).getTime() - now) : null;
          const seconds = remaining !== null ? Math.ceil(remaining / 1000) : null;
          const urgent = d.type === 'TIMED' && seconds !== null && seconds <= 5;
          const votesTotal = Object.values(d.votes || {}).reduce((a, b) => a + b, 0);
          return (
            <div key={d.uid} className="quest-card" style={urgent ? { borderColor: '#e07a5f' } : undefined}>
              <div className="quest-head">
                <strong>{TYPE_LABEL[d.type] || d.type}</strong>
                <span className="small muted">
                  {d.status}
                  {d.type === 'PARTY' && ` · 投票 ${votesTotal}/${d.requiredVotes || '?'}`}
                </span>
              </div>
              <p>{d.prompt}</p>
              {remaining !== null && (
                <div
                  className={urgent ? 'error-bar' : 'muted'}
                  style={urgent ? { fontWeight: 700, fontSize: '1.05rem' } : undefined}
                >
                  ⏱ 剩余 {seconds} 秒 —— 超时将自动执行默认选项 {d.defaultOption || '-'}（服务器计时）
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                {d.options.map((o) => (
                  <button
                    key={o.key}
                    className="btn"
                    disabled={busyKey !== ''}
                    onClick={() => choose(d.uid, o.key)}
                  >
                    {o.key}. {o.text}
                    {d.type === 'PARTY' && d.votes && d.votes[o.key] ? `（${d.votes[o.key]} 票）` : ''}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
