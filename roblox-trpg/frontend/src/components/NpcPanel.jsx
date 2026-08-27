import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * NPC 面板（阶段9）：名称/头像/当前关系/公开信息。
 * 安全：只显示公开记忆（隐藏记忆由服务器过滤，前端拿不到）。
 */
export default function NpcPanel({ onClose, getSessionToken }) {
  const [npcs, setNpcs] = useState([]);
  const [factions, setFactions] = useState([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const token = getSessionToken ? getSessionToken() : null;
      const [npcRes, factionRes] = await Promise.all([
        fetch(`/api/npcs${token ? `?sessionToken=${encodeURIComponent(token)}` : ''}`).then((r) => r.json()),
        fetch(`/api/factions${token ? `?sessionToken=${encodeURIComponent(token)}` : ''}`).then((r) => r.json()).catch(() => ({ factions: [] })),
      ]);
      setNpcs(npcRes.npcs || []);
      setFactions(factionRes.factions || []);
    } catch (e) {
      setError(e.message);
    }
  }, [getSessionToken]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const relColor = (v) => (v <= -50 ? '#e07a5f' : v < 20 ? '#9aa3b8' : v < 50 ? '#7fd18b' : '#e0b34c');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>NPC（Living World）</h2>
          <div>
            <button className="btn small" onClick={refresh}>刷新</button>
            <button className="btn small" onClick={onClose}>关闭</button>
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}
        {npcs.length === 0 && <p className="muted">当前房间没有 NPC。进入绑定 NPC 的副本后将自动出现。</p>}

        {npcs.map((n) => (
          <div key={n.npcInstanceId} className="quest-card">
            <div className="quest-head">
              <strong>
                {n.avatar} {n.name}
                {!n.alive && <span className="muted small">（已死亡）</span>}
                {n.nature === 'hostile' && (
                  <span className="small" style={{ color: '#e07a5f' }}>（怪物·好感无效）</span>
                )}
                {n.legendary && <span className="legend-title">「{n.legendary.title}」</span>}
              </strong>
              <span className="small" style={{ color: relColor(n.relationship.value) }}>
                {n.relationship.type}（{n.relationship.value}）· 情绪：{n.mood}
              </span>
            </div>
            {n.description && <p className="dungeon-desc">{n.description}</p>}
            {n.goals && n.goals.length > 0 && (
              <p className="muted small">目标：{n.goals.join('、')}</p>
            )}
            {n.currentPlan && <p className="muted small">当前计划：{n.currentPlan}</p>}
            {n.publicMemories && n.publicMemories.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <span className="muted small">公开记忆：</span>
                {n.publicMemories.map((m, i) => (
                  <p key={i} className="dungeon-desc" style={{ margin: '2px 0' }}>
                    · [{m.type}] {m.content}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}

        {factions.length > 0 && (
          <div className="dd-section">
            <h4>阵营声望</h4>
            {factions.map((f) => (
              <div key={f.id} className="dd-item">
                {f.name}：<span style={{ color: relColor(f.reputation) }}>{f.reputation}</span>
                <span className="muted small"> · {f.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
