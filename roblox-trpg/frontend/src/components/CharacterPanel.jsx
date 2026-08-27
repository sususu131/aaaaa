import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Character Panel（阶段6）：长期角色（持久数据，服务端权威）。
 * 显示：头像 / 名称 / 等级 / XP / HP / 属性 / 技能（含冷却/次数/来源）/ 装备 / 物品 / 货币。
 * 客户端只发请求，最终由服务器确认。
 */
const RARITY_COLOR = { common: '#9aa3b8', rare: '#5b8cff', epic: '#b44ce0', legendary: '#e0b34c' };

export default function CharacterPanel({ onClose, getSessionToken, headshotUrl }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      // 走 cookie 会话；同时附带 token 兜底
      const r = await fetch('/api/character', { method: 'GET' });
      if (r.ok) {
        setC((await r.json()).character);
        return;
      }
      // 无 cookie 时用 POST body 传 token 的替代路径不存在 → 提示
      setError('需要有效会话');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const doEquip = async (itemId) => {
    setError('');
    try {
      await api.equipItem(itemId, getSessionToken ? getSessionToken() : null);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };
  const doUnequip = async (slot) => {
    setError('');
    try {
      await api.unequipSlot(slot, getSessionToken ? getSessionToken() : null);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  if (!c) return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <p className="muted">加载角色数据…{error && <span className="error-bar">{error}</span>}</p>
        <button className="btn small" onClick={onClose}>关闭</button>
      </div>
    </div>
  );

  const prog = c.levelProgress || {};
  const pct = prog.nextThreshold ? Math.min(100, Math.round(((c.experience - prog.currentThreshold) / (prog.nextThreshold - prog.currentThreshold)) * 100)) : 100;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>角色（Persistent Character）</h2>
          <div>
            <button className="btn small" onClick={refresh}>刷新</button>
            <button className="btn small" onClick={onClose}>关闭</button>
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}

        <div className="dd-section orig">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {headshotUrl ? <img src={headshotUrl} alt="" className="dungeon-icon" /> : <span className="avatar" style={{ fontSize: 32 }}>🥓</span>}
            <div>
              <strong>{c.displayName}</strong>
              <span className="muted small"> · {c.avatarSource === 'ROBLOX_AVATAR' ? 'Roblox 形象' : 'Bacon Head'} · {c.characterId}</span>
              <p className="muted small">Lv {c.level} · XP {c.experience}{prog.nextThreshold ? ` / ${prog.nextThreshold}` : '（MAX）'}</p>
              <div className="token-bar" style={{ width: 180 }}><div className="token-fill" style={{ width: `${pct}%` }} /></div>
              <p className="muted small">HP {c.currentHp}/{c.maxHp}{c.statusEffects.length ? ` · ${c.statusEffects.join('、')}` : ''}</p>
            </div>
          </div>
        </div>

        <div className="dd-section">
          <h4>属性（base + 装备 + 修正 = 有效值）</h4>
          <p>
            {Object.entries(c.stats).map(([k, v]) => `${k} ${v}`).join('　')}
          </p>
        </div>

        <div className="dd-section orig">
          <h4>技能（{c.skills.length}）</h4>
          {c.skills.length === 0 && <p className="muted small">无技能</p>}
          {c.skills.map((s) => (
            <div key={s.hold_id} className="dd-item">
              <strong style={{ color: RARITY_COLOR[s.rarity] || '#e6e8ee' }}>{s.name}</strong>
              <span className="muted small">
                {' '}Lv{s.level} · {s.rarity} · 来源：{s.sourceLabel}
                {s.cooldown_turns ? ` · 冷却${s.cooldown_turns}回合` : ''}
                {s.max_uses != null ? ` · 剩余${s.uses_remaining ?? s.max_uses}次` : ''}
              </span>
              <p className="dungeon-desc">{s.description}</p>
            </div>
          ))}
        </div>

        <div className="dd-section">
          <h4>装备槽</h4>
          {c.equipment.length === 0 && <p className="muted small">未装备</p>}
          {c.equipment.map((e) => (
            <div key={e.slot} className="dd-item">
              [{e.slot}] <strong>{e.name}</strong>
              {e.stat_bonus ? <span className="muted small"> {e.stat_bonus}</span> : null}
              <button className="btn small" style={{ marginLeft: 8 }} onClick={() => doUnequip(e.slot)}>卸下</button>
            </div>
          ))}
        </div>

        <div className="dd-section">
          <h4>背包（{c.inventory.length}）与货币</h4>
          {c.inventory.length === 0 && <p className="muted small">空空如也</p>}
          {c.inventory.map((it) => (
            <div key={it.hold_id} className="dd-item">
              <strong>{it.name}</strong> ×{it.quantity}
              <span className="muted small"> · {it.kind}{it.slot ? `（${it.slot}）` : ''} · 来源：{it.source_type || it.source || '未知'}</span>
              {['weapon', 'armor', 'accessory'].includes(it.kind) && (
                <button className="btn small primary" style={{ marginLeft: 8 }} onClick={() => doEquip(it.item_id)}>装备</button>
              )}
            </div>
          ))}
          {c.currencies.map((cur) => (
            <div key={cur.currency_id} className="dd-item">💰 {cur.name}：{cur.balance}</div>
          ))}
        </div>
      </div>
    </div>
  );
}