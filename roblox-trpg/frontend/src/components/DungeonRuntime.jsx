import { useEffect, useState } from 'react';
import { socket } from '../lib/socket.js';
import { api } from '../lib/api.js';

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

  const token = () => (getSessionToken ? getSessionToken() : null);

  useEffect(() => {
    api.listDungeons().then((d) => setDungeons(d.dungeons || [])).catch(() => {});
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
    socket.on('instance:update', onUpdate);
    socket.on('instance:scene', onScene);
    socket.on('instance:combat', onCombat);
    socket.on('instance:completed', onCompleted);
    return () => {
      socket.off('instance:update', onUpdate);
      socket.off('instance:scene', onScene);
      socket.off('instance:combat', onCombat);
      socket.off('instance:completed', onCompleted);
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
            {dungeons.map((d) =>
              d.publishedVersions.map((v) => (
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

            {snapshot.combat && (
              <div className="dd-section canon">
                <h4>战斗（{snapshot.combat.encounterId}）· {snapshot.combat.status}{snapshot.combat.bossPhase > 1 ? ` · Boss Phase ${snapshot.combat.bossPhase}` : ''}</h4>
                {Object.entries(snapshot.combat.enemyStates).map(([id, e]) => (
                  <div key={id} className="dd-item">{e.name}：HP {e.hp}/{e.maxHp}{e.hp <= 0 ? '（已击败）' : ''}</div>
                ))}
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
