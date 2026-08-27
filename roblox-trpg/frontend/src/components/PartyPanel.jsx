import { useCallback, useEffect, useState } from 'react';
import { socket } from '../lib/socket.js';

const REL_COLOR = (v) => (v <= -50 ? '#e07a5f' : v < 0 ? '#e0b34c' : v >= 50 ? '#7fd18b' : '#9aa3b8');

/**
 * 队伍面板（阶段13）：成员/叙事定位/队长/玩家关系 + 队伍操作。
 * 叙事定位只影响 AI GM 描述，不改变任何属性。
 */
export default function PartyPanel({ onClose, getSessionToken, myName }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const token = () => (getSessionToken ? getSessionToken() : null);

  const refresh = useCallback(async () => {
    try {
      const t = token();
      const res = await fetch(`/api/party${t ? `?sessionToken=${encodeURIComponent(t)}` : ''}`).then((r) => r.json());
      setData(res);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [getSessionToken]);

  useEffect(() => {
    refresh();
    const onPartyUpdate = () => refresh();
    socket.on('party:update', onPartyUpdate);
    return () => socket.off('party:update', onPartyUpdate);
  }, [refresh]);

  const call = async (path, body = {}) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, sessionToken: token() || undefined }),
      }).then((r) => r.json());
      if (res.error) setError(res.error);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const party = data && data.party;
  const roles = (data && data.roles) || ['EXPLORER', 'COMBATANT', 'SUPPORT', 'SCOUT', 'CUSTOM'];
  const roleLabels = (data && data.roleLabels) || {};

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>🤝 队伍（Party）</h2>
          <div>
            <button className="btn small" onClick={refresh}>刷新</button>
            <button className="btn small" onClick={onClose}>关闭</button>
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}

        {!party && (
          <div className="quest-card">
            <p className="muted">当前房间还没有队伍。创建后朋友们可以加入（一个房间一个主队伍）。</p>
            <button className="btn" disabled={busy} onClick={() => call('/api/party/create')}>创建队伍</button>
          </div>
        )}

        {party && (
          <>
            <div className="quest-card">
              <div className="quest-head">
                <strong>成员（{party.members.length}）</strong>
                <span className="small muted">叙事定位只影响 GM 描述，不改变属性</span>
              </div>
              {party.members.map((m) => (
                <div key={m.playerId} className="objective-row">
                  <span>
                    🧑 {m.name}
                    {m.isLeader && <span className="legend-title">（队长）</span>}
                  </span>
                  <span className="small">
                    <select
                      className="btn tiny"
                      value={m.role}
                      disabled={busy || m.name !== myName}
                      onChange={(e) => call('/api/party/role', { role: e.target.value })}
                      title="设置我的叙事定位"
                    >
                      {roles.map((r) => (
                        <option key={r} value={r}>{roleLabels[r] || r}</option>
                      ))}
                    </select>
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn tiny" disabled={busy} onClick={() => call('/api/party/join')}>加入队伍</button>
                <button className="btn tiny" disabled={busy} onClick={() => call('/api/party/leave')}>退出队伍</button>
                {party.members
                  .filter((m) => !m.isLeader)
                  .map((m) => (
                    <button key={m.playerId} className="btn tiny" disabled={busy} onClick={() => call('/api/party/transfer', { targetName: m.name })}>
                      移交队长→{m.name}
                    </button>
                  ))}
              </div>
            </div>

            <div className="quest-card">
              <div className="quest-head">
                <strong>成员关系</strong>
                <span className="small muted">由事件驱动（救助/帮助/背叛/抢夺），AI 不可修改</span>
              </div>
              {(party.relationships || []).length === 0 && <p className="muted small">暂无关系记录。</p>}
              {(party.relationships || []).map((r, i) => (
                <div key={i} className="objective-row">
                  <span>{r.a} ↔ {r.b}</span>
                  <span className="small" style={{ color: REL_COLOR(r.value) }}>{r.type}（{r.value}）</span>
                </div>
              ))}
            </div>
          </>
        )}

        {data && !party && (data.relationships || []).length > 0 && (
          <div className="quest-card">
            <div className="quest-head">
              <strong>房间玩家关系</strong>
            </div>
            {data.relationships.map((r, i) => (
              <div key={i} className="objective-row">
                <span>{r.a} ↔ {r.b}</span>
                <span className="small" style={{ color: REL_COLOR(r.value) }}>{r.type}（{r.value}）</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
