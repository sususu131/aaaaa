import { useState } from 'react';
import { socket } from '../lib/socket.js';
import { api } from '../lib/api.js';

/**
 * Roblox 形象绑定（Step 6-7）：只读公开信息，绝不要求登录/密码/Cookie。
 * 不绑定 = 培根头。
 */
export default function RobloxBindPanel({ players, myName, onClose }) {
  const me = players.find((p) => p.name === myName);
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const lookup = async () => {
    const q = input.trim();
    if (!q) return;
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const data = /^\d{1,20}$/.test(q) ? await api.robloxUserById(q) : await api.robloxUserByUsername(q);
      setPreview(data);
    } catch (err) {
      setError(err.message || '查询失败');
    } finally {
      setBusy(false);
    }
  };

  const bind = () => {
    if (!preview) return;
    socket.emit('player:bindRoblox', { userId: preview.profile.userId }, (res) => {
      if (!res || !res.ok) setError((res && res.error) || '绑定失败');
      else onClose();
    });
  };

  const unbind = () => {
    socket.emit('player:unbindRoblox', {}, () => onClose());
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Roblox 形象（可选）</h2>
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>

        <p className="muted small">
          只提供 <strong>Roblox User ID 或用户名</strong> 即可，仅读取公开资料（头像/昵称），
          不需要登录、密码或 Cookie。不提供则为培根头。
        </p>

        {me && me.roblox && (
          <div className="dungeon-banner">
            {me.headshotUrl && <img src={me.headshotUrl} alt="" className="dungeon-icon" />}
            <div>
              <strong>{me.roblox.displayName || me.roblox.username}</strong>
              <span className="muted small">@{me.roblox.username}</span>
            </div>
            <button className="btn small danger" onClick={unbind}>
              解绑（变回培根头）
            </button>
          </div>
        )}

        <div className="chat-input-row">
          <input
            value={input}
            placeholder="Roblox User ID（数字）或用户名"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookup()}
          />
          <button className="btn primary" onClick={lookup} disabled={busy || !input.trim()}>
            {busy ? '查询中…' : '查询公开资料'}
          </button>
        </div>

        {error && <p className="error-bar">{error}</p>}

        {preview && (
          <div className="search-result">
            {preview.headshotUrl ? (
              <img src={preview.headshotUrl} alt="" className="dungeon-icon" />
            ) : (
              <span className="avatar">🥓</span>
            )}
            <div className="result-info">
              <strong>{preview.profile.displayName}</strong>
              <span className="muted small">
                @{preview.profile.username} · User ID: {preview.profile.userId}
              </span>
              <p className="dungeon-desc">玩家角色预览</p>
            </div>
            <button className="btn small primary" onClick={bind}>
              绑定
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
