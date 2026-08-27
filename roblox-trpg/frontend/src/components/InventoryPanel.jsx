import { useCallback, useEffect, useState } from 'react';
import { socket } from '../lib/socket.js';

const TYPE_LABEL = {
  WEAPON: '武器',
  ARMOR: '装备',
  CONSUMABLE: '消耗品',
  QUEST_ITEM: '任务物品',
  TOOL: '工具',
  MATERIAL: '材料',
  SPECIAL: '特殊',
};

const RARITY_COLOR = {
  COMMON: '#9aa3b8',
  UNCOMMON: '#7fd18b',
  RARE: '#5aa9e6',
  EPIC: '#b07fe0',
  LEGENDARY: '#e0b34c',
  MYTHIC: '#e07a5f',
};

/**
 * 背包面板（阶段14）：分类（武器/装备/消耗品/任务物品/…）、图标、数量、描述、稀有度；
 * 点击查看详情；消耗品可用、武器护甲可装备（服务器结算）。
 */
export default function InventoryPanel({ onClose, getSessionToken }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('ALL');

  const token = () => (getSessionToken ? getSessionToken() : null);

  const refresh = useCallback(async () => {
    try {
      const t = token();
      const res = await fetch(`/api/inventory${t ? `?sessionToken=${encodeURIComponent(t)}` : ''}`).then((r) => r.json());
      setData(res);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [getSessionToken]);

  useEffect(() => {
    refresh();
    const onGameEvent = (e) => {
      if (['ITEM_ACQUIRED', 'ITEM_REMOVED', 'ITEM_USED', 'ITEM_EQUIPPED'].includes(e.type)) refresh();
    };
    socket.on('game:event', onGameEvent);
    const poll = setInterval(refresh, 15000);
    return () => {
      socket.off('game:event', onGameEvent);
      clearInterval(poll);
    };
  }, [refresh]);

  const act = async (path, body) => {
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
    } finally {
      setBusy(false);
    }
  };

  const inv = data && data.inventory;
  const items = inv ? inv.items.filter((i) => filter === 'ALL' || i.type === filter) : [];
  const sel = selected !== null && inv ? inv.items.find((i) => i.itemKey === selected) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>🎒 背包（{inv ? `${inv.used}/${inv.capacity}` : '…'}）</h2>
          <div>
            <button className="btn small" onClick={refresh}>刷新</button>
            <button className="btn small" onClick={onClose}>关闭</button>
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {['ALL', 'WEAPON', 'ARMOR', 'CONSUMABLE', 'QUEST_ITEM', 'TOOL', 'MATERIAL', 'SPECIAL'].map((t) => (
            <button key={t} className={`btn tiny ${filter === t ? 'active' : ''}`} onClick={() => setFilter(t)}>
              {t === 'ALL' ? '全部' : TYPE_LABEL[t]}
            </button>
          ))}
        </div>

        {!inv && !error && <p className="muted">加载中…</p>}
        {inv && items.length === 0 && <p className="muted">该分类下没有物品。物品来自任务奖励、副本掉落、商店购买与事件。</p>}

        {items.map((i) => (
          <div
            key={i.itemKey}
            className="quest-card"
            style={{ cursor: 'pointer', borderLeft: `3px solid ${RARITY_COLOR[i.rarity] || '#9aa3b8'}` }}
            onClick={() => setSelected(selected === i.itemKey ? null : i.itemKey)}
          >
            <div className="quest-head">
              <strong>
                {i.icon || '📦'} {i.name}
                {i.amount > 1 && <span className="small"> ×{i.amount}</span>}
                {i.equippedSlot && <span className="legend-title">（已装备）</span>}
                {i.permanent && <span className="small" style={{ color: '#e0b34c' }}>（永久）</span>}
                {i.bound && <span className="small muted">（绑定）</span>}
              </strong>
              <span className="small" style={{ color: RARITY_COLOR[i.rarity] || '#9aa3b8' }}>
                {i.rarity} · {TYPE_LABEL[i.type] || i.type}
              </span>
            </div>
            {selected === i.itemKey && (
              <div className="small" style={{ marginTop: 4 }}>
                <p className="muted">{i.description || '（无描述）'}</p>
                {Object.keys(i.metadata || {}).length > 0 && (
                  <p className="muted">属性：{Object.entries(i.metadata).map(([k, v]) => `${k}:${v}`).join('，')}</p>
                )}
                {i.basePower > 0 && <p className="muted">基础强度：{i.basePower}（跨副本可能受世界规则削弱）</p>}
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  {i.type === 'CONSUMABLE' && (
                    <button className="btn tiny" disabled={busy} onClick={(e) => { e.stopPropagation(); act('/api/inventory/use', { itemKey: i.itemKey }); }}>
                      使用
                    </button>
                  )}
                  {(i.type === 'WEAPON' || i.type === 'ARMOR') && !i.equippedSlot && (
                    <button className="btn tiny" disabled={busy} onClick={(e) => { e.stopPropagation(); act('/api/inventory/equip', { itemKey: i.itemKey }); }}>
                      装备
                    </button>
                  )}
                  {i.equippedSlot && (
                    <button className="btn tiny" disabled={busy} onClick={(e) => { e.stopPropagation(); act('/api/inventory/unequip', { itemKeyOrSlot: i.itemKey }); }}>
                      卸下
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
