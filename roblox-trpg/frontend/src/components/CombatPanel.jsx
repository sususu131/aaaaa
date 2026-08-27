import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { socket } from '../lib/socket.js';

const PHASE_LABEL = {
  PLAYER_TURN: '🟢 玩家回合',
  ENEMY_TURN: '🔴 敌人回合',
  TEAM_ACTION: '🤝 团队行动',
  VICTORY: '🏆 胜利',
  DEFEAT: '💀 失败',
  FLED: '🏃 已脱离',
};

function HpBar({ hp, maxHp, danger = 0.3 }) {
  const ratio = maxHp > 0 ? hp / maxHp : 0;
  return (
    <div className="timed-bar" style={{ maxWidth: 180 }}>
      <div className={`timed-fill ${ratio < danger ? 'danger' : ''}`} style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%` }} />
    </div>
  );
}

/**
 * 战斗面板（阶段15）：敌我 HP / 回合阶段 / 技能冷却 / 行动按钮。
 * 所有数值与结算来自服务器；这里只提交行动意图与显示。
 */
export default function CombatPanel({ instanceUid, getSessionToken, initialCombat, onChanged }) {
  const [combat, setCombat] = useState(initialCombat || null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [narrative, setNarrative] = useState('');
  const [skillPick, setSkillPick] = useState('');
  const [itemPick, setItemPick] = useState('');

  const token = () => (getSessionToken ? getSessionToken() : null);

  const refresh = async () => {
    try {
      const r = await api.getCombat(instanceUid, token());
      setCombat(r.combat);
    } catch (e) {
      if (e.code !== 'NO_COMBAT') setError(e.message);
    }
  };

  useEffect(() => {
    const onCombat = (view) => setCombat(view);
    const onDamage = () => refresh();
    socket.on('instance:combat', onCombat);
    socket.on('combat:damage', onDamage);
    socket.on('combat:rewards', onDamage);
    return () => {
      socket.off('instance:combat', onCombat);
      socket.off('combat:damage', onDamage);
      socket.off('combat:rewards', onDamage);
    };
  }, [instanceUid]);

  const act = async (payload) => {
    setBusy(true);
    setError('');
    setNarrative('');
    try {
      const r = await api.combatAction(instanceUid, payload, token());
      setNarrative(r.narrative || '');
      if (r.enemyTurn && r.enemyTurn.narratives) setNarrative((n) => `${n}\n${r.enemyTurn.narratives.join('\n')}`);
      if (r.combat) setCombat(r.combat);
      else await refresh();
      if (onChanged) onChanged(r);
    } catch (e) {
      setError(`${e.code ? `[${e.code}] ` : ''}${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!combat) return <p className="muted">（无战斗）</p>;
  const mySkills = (combat.players[0] && combat.players[0].skills) || [];

  return (
    <div className="dd-section canon">
      <h4>
        ⚔ 战斗（{combat.encounterId}）· {PHASE_LABEL[combat.phase] || combat.phase} · 回合 {combat.turn}
        {combat.bossPhase > 1 ? ` · Boss 阶段 ${combat.bossPhase}` : ''}
      </h4>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h5 className="muted">敌人</h5>
          {combat.enemies.map((e) => (
            <div key={e.id} className="dd-item">
              {e.isBoss ? '👹' : '👾'} {e.name} {e.enraged && <span style={{ color: '#e07a5f' }}>狂暴</span>}
              {e.defending && '（防御）'}
              {e.fled && '（逃跑）'}
              <HpBar hp={e.hp} maxHp={e.maxHp} />
              <span className="muted small"> {e.hp}/{e.maxHp}</span>
            </div>
          ))}
        </div>
        <div>
          <h5 className="muted">队伍</h5>
          {combat.players.map((p) => (
            <div key={p.playerId} className="dd-item">
              🧑 {p.name} {p.downed && <span style={{ color: '#e07a5f' }}>倒地</span>}
              {p.defending && '（防御）'}
              {p.acted && <span className="muted small">（已行动）</span>}
              <HpBar hp={p.hp} maxHp={p.maxHp} />
              <span className="muted small"> {p.hp}/{p.maxHp}</span>
              <div className="muted small">
                技能：{p.skills.map((s) => `${s.name}${s.cooldownLeft ? `(冷却${s.cooldownLeft})` : ''}${s.usesRemaining === 0 ? '(次数用尽)' : ''}`).join('、') || '无'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {narrative && <div className="gm-status" style={{ whiteSpace: 'pre-line' }}>{narrative}</div>}
      {error && <div className="error-bar">{error}</div>}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <button className="btn primary" disabled={busy} onClick={() => act({ action: 'ATTACK' })}>⚔ 攻击</button>
        <button className="btn" disabled={busy} onClick={() => act({ action: 'DEFEND' })}>🛡 防御</button>
        <button className="btn" disabled={busy} onClick={() => act({ action: 'FLEE' })}>🏃 逃跑</button>
        {combat.players.some((p) => p.downed) && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => act({ action: 'RESCUE', targetId: combat.players.find((p) => p.downed).playerId })}
          >
            💚 救援倒地队友
          </button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        <select className="btn" value={skillPick} onChange={(e) => setSkillPick(e.target.value)}>
          <option value="">选择技能…</option>
          {mySkills.filter((s) => s.cooldownLeft === 0 && s.usesRemaining !== 0).map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
        <button className="btn" disabled={busy || !skillPick} onClick={() => act({ action: 'SKILL', skillName: skillPick })}>✨ 使用技能</button>
        <input className="btn" style={{ minWidth: 120 }} placeholder="消耗品 item_key" value={itemPick} onChange={(e) => setItemPick(e.target.value)} />
        <button className="btn" disabled={busy || !itemPick} onClick={() => act({ action: 'ITEM', itemKey: itemPick })}>🧪 使用物品</button>
      </div>
      <p className="muted small">伤害/治疗/状态全部由服务器计算；敌人行动由服务器按行为数据决定。</p>
    </div>
  );
}
