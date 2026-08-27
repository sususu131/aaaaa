import { useState } from 'react';
import { socket } from '../lib/socket.js';
import { api } from '../lib/api.js';

/**
 * 副本面板：搜索 / 粘贴 URL 解析 Roblox Experience（官方公开信息）。
 * 多个结果时列出候选由玩家选择——不自动选定。
 */
export default function DungeonPanel({ current, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError('');
    setResults([]);
    try {
      // URL 或纯数字 → 精确解析；否则走搜索
      const isUrl = /roblox\.com/i.test(q);
      const isNum = /^\d{1,20}$/.test(q);
      const data = isUrl || isNum ? await api.resolveExperience(q) : await api.searchExperiences(q);
      setResults(data.results || []);
      if (!(data.results || []).length) setError('没有找到匹配的体验');
    } catch (err) {
      setError(err.message || '获取失败');
    } finally {
      setBusy(false);
    }
  };

  const select = (universeId) => {
    socket.emit('dungeon:select', { universeId }, (res) => {
      if (!res || !res.ok) setError((res && res.error) || '绑定失败');
      else onClose();
    });
  };

  const clearDungeon = () => {
    socket.emit('dungeon:clear', {}, () => onClose());
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>副本来源（Roblox Experience）</h2>
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>

        {current && (
          <div className="dungeon-banner">
            {current.iconUrl && <img src={current.iconUrl} alt="" className="dungeon-icon" />}
            <div>
              <strong>{current.name}</strong>
              <span className="source-badge">source=roblox_api</span>
              <p className="dungeon-desc">{current.description?.slice(0, 120) || ''}</p>
            </div>
            <button className="btn small danger" onClick={clearDungeon}>
              解除
            </button>
          </div>
        )}

        <p className="muted small">
          输入体验名称搜索，或粘贴 Roblox 体验 URL / ID。只读取公开信息；多个结果时需手动选择。
        </p>

        <div className="chat-input-row">
          <input
            value={query}
            placeholder='例如：DOORS 或 https://www.roblox.com/games/6516141723/DOORS'
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          />
          <button className="btn primary" onClick={runSearch} disabled={busy || !query.trim()}>
            {busy ? '查询中…' : '查询'}
          </button>
        </div>

        {error && <p className="error-bar">{error}</p>}

        <div className="search-results">
          {results.map((r) => (
            <div key={r.universeId} className="search-result">
              {r.iconUrl && <img src={r.iconUrl} alt="" className="dungeon-icon" />}
              <div className="result-info">
                <strong>{r.name}</strong>
                <span className="muted small">
                  universeId={r.universeId} · {r.creator ? r.creator.name : '创作者未知'}
                  {r.stats && r.stats.visits != null ? ` · ${r.stats.visits.toLocaleString()} 次访问` : ''}
                </span>
                <p className="dungeon-desc">{(r.description || '').slice(0, 100)}</p>
              </div>
              <button className="btn small primary" onClick={() => select(r.universeId)}>
                选定
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
