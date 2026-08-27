import { useCallback, useEffect, useState } from 'react';
import { socket } from '../lib/socket.js';

const RELATION_STYLE = {
  HOSTILE: { label: '敌对', color: '#e07a5f' },
  NEUTRAL: { label: '中立', color: '#9aa3b8' },
  ALLIED: { label: '同盟', color: '#7fd18b' },
};

const BEHAVIOR_LABEL = {
  IDLE: '空闲',
  WORKING: '工作中',
  TRAVELING: '移动中',
  FIGHTING: '战斗中',
  FLEEING: '逃离中',
  PLANNING: '筹划中',
};

const CATEGORY_LABEL = { NATURAL: '自然', STORY: '剧情', SYSTEM: '系统' };

/**
 * 世界状态面板（阶段12）：当前事件 / 世界变化 / 阵营关系 / NPC 活动 / 副本变体。
 * 数据全部来自服务器（/api/world），断线重连后重新拉取即可恢复。
 */
export default function WorldPanel({ onClose, getSessionToken }) {
  const [world, setWorld] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const token = getSessionToken ? getSessionToken() : null;
      const res = await fetch(`/api/world${token ? `?sessionToken=${encodeURIComponent(token)}` : ''}`).then((r) => r.json());
      setWorld(res.world || null);
    } catch (e) {
      setError(e.message);
    }
  }, [getSessionToken]);

  useEffect(() => {
    refresh();
    const onWorldEvent = () => refresh(); // 世界事件/移动/阵营变化 → 自动刷新
    socket.on('world:event', onWorldEvent);
    const poll = setInterval(refresh, 10000);
    return () => {
      socket.off('world:event', onWorldEvent);
      clearInterval(poll);
    };
  }, [refresh]);

  const togglePause = async (paused) => {
    setBusy(true);
    try {
      const token = getSessionToken ? getSessionToken() : null;
      await fetch(`/api/world/${paused ? 'resume' : 'pause'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: token || undefined }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>🌍 世界状态（World Simulation）</h2>
          <div>
            <button className="btn small" onClick={refresh}>刷新</button>
            <button className="btn small" onClick={onClose}>关闭</button>
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}
        {!world && !error && <p className="muted">尚未进入房间，或世界模拟暂无数据。</p>}

        {world && (
          <>
            <div className="quest-card">
              <div className="quest-head">
                <strong>调度器</strong>
                <span className="small muted">
                  World Tick #{world.scheduler.lastTick} · 每 {Math.round((world.scheduler.intervalMs || 30000) / 1000)}s ·{' '}
                  {world.scheduler.paused ? '⏸ 已暂停' : '▶ 运行中'}
                </span>
              </div>
              <button className="btn tiny" disabled={busy} onClick={() => togglePause(world.scheduler.paused)}>
                {world.scheduler.paused ? '恢复世界模拟' : '暂停世界模拟'}
              </button>
            </div>

            <div className="quest-card">
              <div className="quest-head">
                <strong>当前世界事件</strong>
                <span className="small muted">{world.events.length} 个生效</span>
              </div>
              {world.events.length === 0 && <p className="muted small">当前没有生效的世界事件。世界事件由服务器规则触发，或经 AI 申请审核后发生。</p>}
              {world.events.map((e) => (
                <div key={e.uid} className="objective-row">
                  <span>
                    {e.label} <span className="muted small">[{CATEGORY_LABEL[e.category] || e.category} · {e.type}]</span>
                  </span>
                  <span className="muted small">{e.expiresAt ? `至 ${new Date(e.expiresAt).toLocaleTimeString()}` : '永久'} · 来源：{e.source}</span>
                </div>
              ))}
            </div>

            <div className="quest-card">
              <div className="quest-head">
                <strong>阵营关系</strong>
              </div>
              {world.relations.length === 0 && <p className="muted small">暂无阵营关系记录。</p>}
              {world.relations.map((r, i) => {
                const st = RELATION_STYLE[r.relation] || RELATION_STYLE.NEUTRAL;
                return (
                  <div key={i} className="objective-row">
                    <span>{r.factionA} ↔ {r.factionB}</span>
                    <span className="small" style={{ color: st.color }}>{st.label}{r.reason ? `（${r.reason}）` : ''}</span>
                  </div>
                );
              })}
            </div>

            <div className="quest-card">
              <div className="quest-head">
                <strong>NPC 活动</strong>
                <span className="small muted">服务器规则驱动的自主行为</span>
              </div>
              {world.npcs.length === 0 && <p className="muted small">当前房间没有 NPC。</p>}
              {world.npcs.map((n) => (
                <div key={n.npcInstanceId} className="objective-row">
                  <span>
                    {n.avatar} {n.name}
                    {!n.alive && <span className="muted small">（死亡）</span>}
                  </span>
                  <span className="small muted">
                    📍 {n.locationName || '未知'}{n.traveling ? ` → 前往中` : ''} · {BEHAVIOR_LABEL[n.behaviorState] || n.behaviorState} · 情绪 {n.mood}
                  </span>
                </div>
              ))}
            </div>

            <div className="quest-card">
              <div className="quest-head">
                <strong>副本变体</strong>
                <span className="small muted">由世界状态动态决定</span>
              </div>
              {world.variants.length === 0 && <p className="muted small">当前房间没有活跃副本实例。</p>}
              {world.variants.map((v) => (
                <div key={v.id} className="objective-row">
                  <span>{v.dungeon_name}（{v.roblox_experience_name}）</span>
                  <span className="small">{v.variant.label}（{v.variant_key}）{v.variant.difficultyDelta ? ` · 难度 +${v.variant.difficultyDelta}` : ''}</span>
                </div>
              ))}
            </div>

            <div className="quest-card">
              <div className="quest-head">
                <strong>最近 World Tick</strong>
              </div>
              {world.recentTicks.length === 0 && <p className="muted small">尚未执行任何 tick。</p>}
              {world.recentTicks.map((t) => (
                <div key={t.tickNumber} className="objective-row">
                  <span className="small">tick #{t.tickNumber} · {t.at}</span>
                  <span className="muted small">{(t.result.actions || []).length} 个世界动作</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
