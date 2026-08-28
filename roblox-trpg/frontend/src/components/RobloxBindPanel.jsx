import { useState } from 'react';
import { socket } from '../lib/socket.js';
import { api } from '../lib/api.js';

/**
 * Roblox 形象绑定 + Avatar Vision 初始化（阶段3b）。
 * 只读公开信息，绝不要求登录/密码/Cookie。不绑定 = 培根头（全属性5，无技能）。
 * Vision 分析由服务端发起（VISION Key 不下发前端）；玩家不能自带图片替代。
 */
const STAGES = ['正在读取 Roblox 形象……', '正在分析 Avatar……', '正在生成初始属性……', '正在确定初始技能……'];

export default function RobloxBindPanel({ players, myName, onClose, getSessionToken }) {
  const me = players.find((p) => p.name === myName);
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('');
  const [visionResult, setVisionResult] = useState(null);

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

  /** 绑定后立即走服务端 Vision 初始化（分阶段提示）。 */
  const runVision = async () => {
    setError('');
    setVisionResult(null);
    let timer = null;
    let i = 0;
    setStage(STAGES[0]);
    timer = setInterval(() => {
      i = Math.min(i + 1, STAGES.length - 1);
      setStage(STAGES[i]);
    }, 900);
    try {
      const result = await api.visionAnalyze(getSessionToken ? getSessionToken() : null);
      setVisionResult(result);
    } catch (err) {
      setError(err.message || 'Vision 初始化失败');
    } finally {
      clearInterval(timer);
      setStage('');
    }
  };

  const bind = () => {
    if (!preview) return;
    socket.emit('player:bindRoblox', { userId: preview.profile.userId }, (res) => {
      if (!res || !res.ok) setError((res && res.error) || '绑定失败');
      else runVision();
    });
  };

  /** 阶段31：解绑 = 彻底重置（服务器清初始化痕迹 → 培根头；再绑任何新名字都会重新识别）。 */
  const unbind = () => {
    socket.emit('player:unbindRoblox', {}, (res) => {
      if (!res || !res.ok) {
        setError((res && res.error) || '解绑失败');
        return;
      }
      setPreview(null);
      setVisionResult(res.result ? { ...res.result, bacon: true } : null);
    });
  };

  const attrLine = (attrs) =>
    attrs ? Object.entries(attrs).map(([k, v]) => `${k} ${v}`).join('　') : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Roblox 形象与初始属性</h2>
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>

        <p className="muted small">
          提供 <strong>Roblox User ID 或用户名</strong>（仅公开资料，不需要登录）。
          绑定后由服务端 Vision 分析 Avatar 外观，生成初始属性与至多 2 个初始技能；
          服务器规则决定最终结果，Vision 无法直接给予能力。
        </p>

        {stage && <div className="gm-status">👁 {stage}</div>}

        {visionResult && visionResult.status === 'INITIALIZED' && (
          <div className="vision-result">
            {visionResult.bacon ? (
              <>
                <p>
                  🥓 <strong>Bacon Head</strong> — 你没有 Roblox 账号。你没有获得额外的初始能力。
                </p>
                <p>属性：{attrLine(visionResult.attributes)}（全部 5）</p>
                <p>初始技能：无</p>
              </>
            ) : (
              <>
                <p>
                  ✅ Avatar 分析完成（{visionResult.visionModel}）
                </p>
                <p>
                  识别标签：{(visionResult.acceptedTags || []).join('、') || '（无明显特征）'}
                </p>
                <p>
                  <strong>初始属性</strong>：{attrLine(visionResult.attributes)}
                </p>
                <p>
                  <strong>初始技能</strong>：
                  {(visionResult.skills || []).map((s) => s.display || s.key).join('、') || '无'}
                </p>
              </>
            )}
          </div>
        )}

        {visionResult && visionResult.status === 'FAILED' && (
          <div className="error-bar">
            Vision 初始化失败：{visionResult.error}（不会给予随机属性/技能，可稍后重试）
            <button className="btn small" style={{ marginLeft: 8 }} onClick={runVision}>
              重试
            </button>
          </div>
        )}

        {me && me.roblox ? (
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
        ) : (
          <div className="dungeon-banner">
            <span className="avatar">🥓</span>
            <div>
              <strong>Bacon Head</strong>
              <p className="muted small">你没有 Roblox 账号。你没有获得额外的初始能力。属性：全部 5，技能：无。</p>
            </div>
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
              <p className="dungeon-desc">绑定后自动进行 Avatar Vision 初始化</p>
            </div>
            <button className="btn small primary" onClick={bind}>
              绑定并初始化
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
