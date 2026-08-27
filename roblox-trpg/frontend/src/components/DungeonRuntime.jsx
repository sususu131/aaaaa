import { useEffect, useState } from 'react';
import { socket } from '../lib/socket.js';
import { api } from '../lib/api.js';
import CombatPanel from './CombatPanel.jsx';

/**
 * Dungeon Runtime 面板（阶段5）：
 * 选择已发布副本 → 创建/加入实例 → 开始 → 行动（服务器裁定）→ 场景/战斗/队伍/事件日志。
 * 选项点击仍然只填入聊天输入框（阶段2规则不变）。
 */
export default function DungeonRuntime({ onClose, getSessionToken, onPickOption }) {
  const [dungeons, setDungeons] = useState([]);
  const [instanceUid, setInstanceUid] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [events, setEvents] = useState([]);
  const [actionText, setActionText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rewardSummary, setRewardSummary] = useState(null); // 服务器最终结算结果
  const [timedEvent, setTimedEvent] = useState(null); // 限时抉择（QTE）
  const [timedResult, setTimedResult] = useState(null);
  const [timedLeft, setTimedLeft] = useState(1); // 剩余比例 0..1
  const [agentEvents, setAgentEvents] = useState([]); // Agent 轨迹（默认折叠）
  const [combatRewards, setCombatRewards] = useState(null); // 阶段15：战斗奖励弹窗
  const [defeatInfo, setDefeatInfo] = useState(null); // 阶段15：死亡界面
  const [official, setOfficial] = useState([]); // 阶段15：官方可玩内容

  const token = () => (getSessionToken ? getSessionToken() : null);

  // QTE 倒计时（进度条）
  useEffect(() => {
    if (!timedEvent) return undefined;
    const tick = () => {
      const left = Math.max(0, timedEvent.expiresAt - Date.now());
      setTimedLeft(Math.max(0, Math.min(1, left / timedEvent.deadlineMs)));
      if (left <= 0) setTimedEvent(null); // 服务器会广播 timedExpired
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [timedEvent]);

  const chooseTimed = async (index) => {
    if (!timedEvent || !instanceUid) return;
    const id = timedEvent.id;
    setTimedEvent(null);
    try {
      const r = await api.timedChoice(instanceUid, index, token());
      if (!r.ok) setError(`选择被拒：${r.reason}`);
    } catch (e) {
      setError(e.message);
    }
    void id;
  };

  useEffect(() => {
    api.listDungeons().then((d) => { setDungeons(d.dungeons || []); setOfficial(d.official || []); }).catch(() => {});
    // 已有活跃实例 → 直接恢复（断线重连语义）
    socket.emit('instance:sync', {}, (res) => {
      if (res && res.ok && res.instance) {
        setInstanceUid(res.instance.uid);
      }
    });
    const onUpdate = () => refresh();
    const onScene = () => refresh();
    const onCombat = () => refresh();
    const onCompleted = (data) => {
      setRewardSummary(data && data.grants ? data.grants : []);
      refresh();
    };
    // 阶段7：限时抉择（QTE）+ Agent 轨迹
    const onTimedEvent = (data) => setTimedEvent({ ...data, receivedAt: Date.now() });
    const onTimedExpired = (data) => {
      setTimedResult(data);
      setTimedEvent(null);
      refresh();
    };
    const onAgentEvent = (evt) => {
      setAgentEvents((prev) => [...prev.slice(-40), evt]);
    };
    socket.on('instance:update', onUpdate);
    socket.on('instance:scene', onScene);
    socket.on('instance:combat', onCombat);
    socket.on('instance:completed', onCompleted);
    socket.on('instance:timedEvent', onTimedEvent);
    socket.on('instance:timedExpired', onTimedExpired);
    socket.on('agent:event', onAgentEvent);
    // 阶段15：战斗奖励弹窗 + 死亡界面
    const onCombatRewards = (data) => setCombatRewards(data);
    const onDefeat = (data) => setDefeatInfo(data);
    socket.on('combat:rewards', onCombatRewards);
    socket.on('instance:defeat', onDefeat);
    return () => {
      socket.off('combat:rewards', onCombatRewards);
      socket.off('instance:defeat', onDefeat);
      socket.off('instance:update', onUpdate);
      socket.off('instance:scene', onScene);
      socket.off('instance:combat', onCombat);
      socket.off('instance:completed', onCompleted);
      socket.off('instance:timedEvent', onTimedEvent);
      socket.off('instance:timedExpired', onTimedExpired);
      socket.off('agent:event', onAgentEvent);
    };
    // eslint-disable-next-line
  }, [instanceUid]);

  const refresh = async () => {
    if (!instanceUid) return;
    try {
      const [snap, ev] = await Promise.all([api.getInstance(instanceUid), api.getInstanceEvents(instanceUid)]);
      setSnapshot(snap);
      setEvents((ev.events || []).slice(-30));
    } catch (e) {
      setError(e.message);
    }
  };

  const create = async (versionId) => {
    setBusy(true); setError('');
    try {
      const r = await api.createInstance(versionId, token());
      setInstanceUid(r.instance.uid);
      await refresh();
    } catch (e) { setError(`${e.code ? `[${e.code}] ` : ''}${e.message}`); }
    finally { setBusy(false); }
  };

  const join = async () => {
    setBusy(true); setError('');
    try { await api.joinInstance(instanceUid, token()); await refresh(); }
    catch (e) { setError(`${e.code ? `[${e.code}] ` : ''}${e.message}`); }
    finally { setBusy(false); }
  };

  const start = async () => {
    setBusy(true); setError('');
    try { await api.startInstance(instanceUid, token()); await refresh(); }
    catch (e) { setError(`${e.code ? `[${e.code}] ` : ''}${e.message}`); }
    finally { setBusy(false); }
  };

  const sendAction = async () => {
    const text = actionText.trim();
    if (!text) return;
    setBusy(true); setError('');
    try {
      await api.submitAction(instanceUid, text, token());
      setActionText('');
      setTimeout(refresh, 400);
    } catch (e) { setError(`${e.code ? `[${e.code}] ` : ''}${e.message}`); }
    finally { setBusy(false); }
  };

  const leave = async () => {
    try { await api.leaveInstance(instanceUid, token()); } catch { /* ignore */ }
    setInstanceUid(null);
    setSnapshot(null);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>副本运行（Dungeon Runtime）</h2>
          <div>
            {instanceUid && <button className="btn small" onClick={leave}>离开实例</button>}
            <button className="btn small" onClick={onClose}>关闭</button>
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}

        {!instanceUid && (
          <>
            <p className="muted small">选择一个已发布（PUBLISHED）副本版本，在你的房间创建实例（2~3 人）。</p>
            {dungeons.filter((d) => d.publishedVersions.length > 0).length === 0 && (
              <p className="muted">暂无已发布副本。请先在「副本设计」中生成 → 审核 → 发布。</p>
            )}
            {official.map((o) => (
              <div key={o.ref} className="search-result" style={{ borderLeft: '3px solid #e0b34c' }}>
                <div className="result-info">
                  <strong>⭐ {o.dungeonName}（官方新手流程）</strong>
                  <span className="muted small">{o.description || '完整可玩闭环：探索→战斗→任务→奖励→成长'}</span>
                </div>
                <button className="btn small primary" disabled={busy} onClick={() => create(o.ref)}>开始游玩</button>
              </div>
            ))}
            {dungeons.map((d) =>
              d.publishedVersions.filter((v) => v.version !== 900).map((v) => (
                <div key={v.id} className="search-result">
                  <div className="result-info">
                    <strong>{d.dungeon_name}</strong>
                    <span className="muted small">v{v.version} · PUBLISHED · 来源 {d.roblox_experience_name}</span>
                  </div>
                  <button className="btn small primary" disabled={busy} onClick={() => create(v.id)}>创建实例</button>
                </div>
              ))
            )}
          </>
        )}

        {instanceUid && !snapshot && (
          <div>
            <p>实例 <strong>{instanceUid}</strong></p>
            <button className="btn" onClick={refresh}>刷新状态</button>
            <button className="btn" onClick={join}>加入实例</button>
            <button className="btn primary" onClick={start}>开始（需 ≥2 人）</button>
          </div>
        )}

        {snapshot && (
          <>
            <div className="dd-section orig">
              <h4>{snapshot.dungeon.name}（v{snapshot.dungeon.version}）· 状态：{snapshot.instance.status}</h4>
              {snapshot.scene ? (
                <>
                  <p><strong>当前场景：{snapshot.scene.name}</strong></p>
                  <p className="dungeon-desc">{snapshot.scene.description}</p>
                  <p className="muted small">出口：{(snapshot.scene.exits || []).join('、') || '无'} · 遭遇：{(snapshot.scene.encounters || []).join('、') || '无'}</p>
                </>
              ) : (
                <p className="muted">尚未开始（等待开始）</p>
              )}
            </div>

            <div className="dd-section">
              <h4>队伍（共享世界）</h4>
              {snapshot.party.map((p) => (
                <div key={p.uid} className="dd-item">
                  {p.name} · HP {p.hp}/{p.maxHp}
                  {p.attributes ? ` · STR${p.attributes.STR} DEX${p.attributes.DEX} CON${p.attributes.CON} PER${p.attributes.PER} INT${p.attributes.INT} LUK${p.attributes.LUK}` : ''}
                  <span className="muted small"> · 技能：{p.skills.join('、') || '无'}{p.statusEffects.length ? ` · ${p.statusEffects.join('、')}` : ''}</span>
                </div>
              ))}
            </div>

            {snapshot.combat && snapshot.instance.status === 'RUNNING' && (
              <CombatPanel instanceUid={instanceUid} getSessionToken={getSessionToken} onChanged={() => setTimeout(refresh, 300)} />
            )}

            {/* 阶段15：场景移动 + 开始遭遇（可玩闭环按钮） */}
            {snapshot.instance.status === 'RUNNING' && !snapshot.combat && snapshot.scene && (
              <div className="dd-section">
                <h4>🚪 当前：{snapshot.scene.name}</h4>
                <p className="muted small">{snapshot.scene.description}</p>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(snapshot.scene.exits || []).map((exitId) => (
                    <button
                      key={exitId}
                      className="btn tiny"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          await api.moveScene(instanceUid, exitId, token());
                          await refresh();
                        } catch (e) {
                          setError(`${e.code ? `[${e.code}] ` : ''}${e.message}`);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      前往 {exitId}
                    </button>
                  ))}
                  {(snapshot.scene.encounters || []).map((encId) => (
                    <button
                      key={encId}
                      className="btn tiny"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          await api.startEncounter(instanceUid, encId, token());
                          await refresh();
                        } catch (e) {
                          setError(`${e.code ? `[${e.code}] ` : ''}${e.message}`);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      ⚔ 迎战 {encId}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 阶段15：战斗奖励弹窗（Reward Popup） */}
            {combatRewards && (
              <div className="modal-backdrop" onClick={() => setCombatRewards(null)}>
                <div className="modal" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <h2>🏆 战斗胜利！</h2>
                    <button className="btn small" onClick={() => setCombatRewards(null)}>关闭</button>
                  </div>
                  {(combatRewards.rewards || []).map((rp) => (
                    <div key={rp.playerId} className="quest-card">
                      <div className="quest-head"><strong>玩家 #{rp.playerId}</strong></div>
                      {rp.grants.map((g, i) => (
                        <div key={i} className="objective-row">
                          <span>{g.type === 'XP' ? `⭐ 经验 +${g.amount}${g.levelsGained ? `（升级 ×${g.levelsGained}！）` : ''}` : g.type === 'CURRENCY' ? `💰 ${g.name} +${g.amount}` : `🎁 ${g.name}`}</span>
                          {g.skipped && <span className="muted small">（{g.skipped}）</span>}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 阶段15：死亡界面（保留角色与永久物品） */}
            {defeatInfo && (
              <div className="modal-backdrop" onClick={() => setDefeatInfo(null)}>
                <div className="modal" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <h2>💀 队伍倒下了…</h2>
                    <button className="btn small" onClick={() => setDefeatInfo(null)}>关闭</button>
                  </div>
                  <p>副本挑战失败：{defeatInfo.reason}</p>
                  <p className="muted">别灰心——你的角色进度与永久物品都已保留。休整之后，随时可以再次挑战。</p>
                </div>
              </div>
            )}

            {timedEvent && (
              <div className="timed-event">
                <h4>⚠ {timedEvent.prompt}</h4>
                <div className="timed-bar">
                  <div className={`timed-fill ${timedLeft < 0.3 ? 'danger' : ''}`} style={{ width: `${timedLeft * 100}%` }} />
                </div>
                <div className="action-options">
                  {timedEvent.options.map((o, i) => (
                    <button key={i} className="option-btn timed" onClick={() => chooseTimed(i)}>
                      {o.label}
                    </button>
                  ))}
                </div>
                <p className="muted small">倒计时结束前未选择将承受后果！</p>
              </div>
            )}
            {timedResult && (
              <div className="gm-status">
                {timedResult.outcome === 'RESOLVED'
                  ? `✅ ${timedResult.by} 选择了「${timedResult.choice}」`
                  : `💀 来不及了！${(timedResult.victims || []).map((v) => `${v.name} -${v.damage}HP${v.downed ? '（倒下）' : ''}`).join('，') || '无人受伤'}`}
              </div>
            )}

            {snapshot.instance.status === 'RUNNING' && (
              <div className="chat-input-row">
                <input
                  value={actionText}
                  placeholder="提交行动，如：我检查门 / 我攻击怪物（服务器裁定）"
                  onChange={(e) => setActionText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendAction()}
                />
                <button className="btn primary" disabled={busy || !actionText.trim()} onClick={sendAction}>行动</button>
              </div>
            )}

            {agentEvents.length > 0 && (
              <details className="source-refs">
                <summary>AI Agent 轨迹（{agentEvents.length} 事件）</summary>
                <pre className="context-content" style={{ maxHeight: 180 }}>
                  {agentEvents
                    .map((e) => {
                      if (e.type === 'AI_TOOL_START') return `🔧 工具调用：${e.tool}`;
                      if (e.type === 'AI_TOOL_RESULT') return `${e.ok ? '✅' : '❌'} 工具结果：${e.tool}${e.durationMs != null ? `（${e.durationMs}ms）` : ''}`;
                      if (e.type === 'AI_SEARCH_START') return `🔎 搜索：${e.query}`;
                      if (e.type === 'AI_TEXT_DELTA') return null;
                      if (e.type === 'AI_THINKING') return `🤔 第${e.round}轮推演…`;
                      if (e.type === 'AI_ERROR') return `⚠ AI错误[${e.code}] ${e.message}`;
                      if (e.type === 'AI_COMPLETE') return `🏁 完成（${e.rounds}轮，${e.toolCalls ?? 0}次工具）`;
                      return `${e.type}`;
                    })
                    .filter(Boolean)
                    .slice(-30)
                    .join('\n')}
                </pre>
              </details>
            )}
            {snapshot.instance.status === 'WAITING' && (
              <div className="chat-input-row">
                <button className="btn" onClick={join}>加入实例</button>
                <button className="btn primary" onClick={start}>开始（需 ≥2 人）</button>
              </div>
            )}
            {(snapshot.instance.status === 'COMPLETED' || snapshot.instance.status === 'FAILED') && (
              <p className="gm-status">{snapshot.instance.status === 'COMPLETED' ? '🏁 副本已完成，奖励已结算' : '💀 副本失败（全队倒下）'}</p>
            )}

            {rewardSummary && rewardSummary.length > 0 && (
              <div className="dd-section canon">
                <h4>🎉 副本完成 — 奖励结算（服务器最终结果）</h4>
                {rewardSummary.map((g, i) => (
                  <div key={i} className="dd-item">
                    {g.type === 'XP' && `+${g.amount} XP${g.levelUps && g.levelUps.length ? `（升级 → Lv${g.levelUps[g.levelUps.length - 1].new_level}）` : ''}`}
                    {g.type === 'CURRENCY' && `${g.name} +${g.amount}`}
                    {g.type === 'SKILL' && `技能「${g.name}」${g.note === 'LEVEL_UP' ? '（升级）' : ''}`}
                    {(g.type === 'ITEM' || g.type === 'EQUIPMENT') && `${g.name} ×1`}
                    {g.type === 'SPECIAL' && `${g.note || '特殊'}`}
                    <span className="muted small"> · {g.player}</span>
                  </div>
                ))}
              </div>
            )}

            <details className="source-refs">
              <summary>事件日志（{events.length} 条，可重放数据）</summary>
              <pre className="context-content" style={{ maxHeight: 200 }}>
                {events.map((e) => `[${e.sequence}] ${e.type} ${e.actor || ''} ${String(e.data).slice(0, 90)}`).join('\n')}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
