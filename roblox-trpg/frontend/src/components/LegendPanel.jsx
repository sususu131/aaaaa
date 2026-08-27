import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * 传奇人物面板（阶段10）：传奇卡片（头像/称号/来源/稀有度/关系/能力）+ 传奇商店。
 * 购买走服务器验证（关系/声望/金币）；AI 无直接发放途径。
 */
const RARITY_CLASS = { legendary: 'rarity-legendary', mythic: 'rarity-mythic' };

export default function LegendPanel({ onClose, getSessionToken }) {
  const [npcs, setNpcs] = useState([]);
  const [error, setError] = useState('');
  const [shops, setShops] = useState({}); // legendId -> items

  const token = () => (getSessionToken ? getSessionToken() : null);

  const refresh = useCallback(async () => {
    try {
      const t = token();
      const r = await fetch(`/api/npcs${t ? `?sessionToken=${encodeURIComponent(t)}` : ''}`);
      const data = await r.json();
      setNpcs((data.npcs || []).filter((n) => n.legendary));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadShop = async (legendId) => {
    try {
      const t = token();
      const r = await fetch(`/api/legend-shop/${legendId}${t ? `?sessionToken=${encodeURIComponent(t)}` : ''}`);
      const data = await r.json();
      setShops((s) => ({ ...s, [legendId]: data.shop || [] }));
    } catch (e) {
      setError(e.message);
    }
  };

  const buy = async (legendId, itemName) => {
    setError('');
    try {
      const t = token();
      const r = await fetch('/api/legend-shop/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legendId, itemName, sessionToken: t }),
      });
      const data = await r.json();
      if (!r.ok) setError(data.error || '购买失败');
      await loadShop(legendId);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>⭐ 传奇人物（Legendary NPCs）</h2>
          <div>
            <button className="btn small" onClick={refresh}>刷新</button>
            <button className="btn small" onClick={onClose}>关闭</button>
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}
        {npcs.length === 0 && <p className="muted">当前房间没有传奇人物。传奇人物由服务器按概率生成，无法由 AI 创造。</p>}

        {npcs.map((n) => {
          const lg = n.legendary;
          const shop = shops[lg.legendId];
          return (
            <div key={n.npcInstanceId} className="legend-card">
              <div className="quest-head">
                <strong>
                  {n.avatar} {lg.displayName} <span className="legend-title">「{lg.title}」</span>
                </strong>
                <span className={`small ${RARITY_CLASS[lg.rarity] || ''}`}>{lg.rarity}</span>
              </div>
              <p className="dungeon-desc">
                来源：{lg.originExperience}（{lg.originType}）· 关系：{n.relationship.type}（{n.relationship.value}）· 情绪：{n.mood}
              </p>
              {lg.abilities && lg.abilities.length > 0 && (
                <p className="muted small">能力：{lg.abilities.map((a) => a.name).join('、')}</p>
              )}
              {n.goals && n.goals.length > 0 && <p className="muted small">目标：{n.goals.join('、')}</p>}
              <button className="btn small" style={{ marginTop: 8 }} onClick={() => loadShop(lg.legendId)}>
                查看商店
              </button>

              {shop && (
                <div style={{ marginTop: 8 }}>
                  {shop.length === 0 && <p className="muted small">（无商品）</p>}
                  {shop.map((s) => (
                    <div key={s.item_id} className="shop-item">
                      <span style={{ flex: 1 }}>
                        {/* 阶段25 修复：后端返回 item_name/item_rarity（此前用 s.item/s.rarity 导致商品名为空） */}
                        {s.item_name} <span className="muted small">{s.item_rarity}</span>
                      </span>
                      <span className="muted small">{s.price} {s.currency}</span>
                      <span className={`shop-req ${s.eligible ? 'met' : ''}`}>{s.eligible ? '可购买' : '条件未满足'}</span>
                      <button className="btn tiny" disabled={!s.eligible} onClick={() => buy(lg.legendId, s.item_name)}>
                        购买
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
