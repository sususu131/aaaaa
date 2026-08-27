import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const GENRE_ICON = {
  'Horror Survival': '🚪',
  'Asymmetric Horror': '🔪',
  'Survival Horror': '🏚',
  'Combat Arena': '⚔️',
  'Random Disaster': '🌩',
};

/**
 * 体验选择面板（阶段16）：官方预设副本列表（图标/名称/类型/难度）+ 开始按钮。
 * 图标经服务端 Roblox Thumbnails 代理；离线时显示类型图标占位。
 */
export default function ExperienceSelectPanel({ onClose, getSessionToken, onStarted }) {
  const [presets, setPresets] = useState([]);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');

  const token = () => (getSessionToken ? getSessionToken() : null);

  const refresh = useCallback(async () => {
    try {
      const t = token();
      const res = await fetch(`/api/preset-experiences${t ? `?sessionToken=${encodeURIComponent(t)}` : ''}`).then((r) => r.json());
      setPresets(res.presets || []);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [getSessionToken]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const start = async (preset) => {
    if (!preset.versionId) {
      setError(`「${preset.name}」尚未发布可玩版本`);
      return;
    }
    setBusyKey(preset.key);
    setError('');
    try {
      const r = await api.createInstance(preset.versionId, token());
      if (onStarted) onStarted(r.instance);
      onClose();
    } catch (e) {
      setError(`${e.code ? `[${e.code}] ` : ''}${e.message}`);
    } finally {
      setBusyKey('');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>⭐ 官方体验副本</h2>
          <div>
            <button className="btn small" onClick={refresh}>刷新</button>
            <button className="btn small" onClick={onClose}>关闭</button>
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}
        <p className="muted small">官方设定为 CANON（只读）；数值与跑团机制为 TRPG_EXTENSION。重复导入不会产生重复数据。</p>

        {presets.length === 0 && !error && <p className="muted">加载中…（如为空，请在服务端执行预设导入）</p>}

        {presets.map((p) => (
          <div key={p.key} className="quest-card" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ width: 64, height: 64, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, background: '#1c2233', borderRadius: 8 }}>
              {p.iconUrl ? <img src={p.iconUrl} alt={p.name} style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'cover' }} /> : (GENRE_ICON[p.genre] || '🎮')}
            </div>
            <div style={{ flex: 1 }}>
              <div className="quest-head">
                <strong>{p.name}</strong>
                <span className="small muted">
                  {p.genre} · 难度 {'★'.repeat(Math.max(1, Math.min(5, p.difficulty)))} · {p.status === 'PUBLISHED' ? '可玩' : '草稿'}
                </span>
              </div>
              <p className="muted small" style={{ margin: '4px 0' }}>{p.description}</p>
            </div>
            <button className="btn primary" disabled={busyKey === p.key || p.status !== 'PUBLISHED'} onClick={() => start(p)}>
              {busyKey === p.key ? '创建中…' : '开始副本'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
