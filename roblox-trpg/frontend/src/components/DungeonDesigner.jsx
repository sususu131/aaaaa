import { useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Dungeon Designer（阶段4）：Roblox Experience → 可审核/可版本化的 TRPG 副本定义。
 * 流程：解析体验 → 显示 Roblox 信息 → 生成设计 → Draft 预览 → 审核 → 发布。
 * Canonical Fact 与 TRPG Original 在视觉上严格区分。
 */
const statusColor = {
  DRAFT: '#9aa3b8',
  REVIEW: '#e0b34c',
  APPROVED: '#7fd18b',
  REJECTED: '#e07a5f',
  PUBLISHED: '#5b8cff',
};

export default function DungeonDesigner({ onClose }) {
  const [input, setInput] = useState('');
  const [exp, setExp] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // design 结果
  const [definition, setDefinition] = useState(null); // 版本定义
  const [versionId, setVersionId] = useState(null); // 当前版本行 ID
  const [versionStatus, setVersionStatus] = useState(null);
  const [versions, setVersions] = useState([]);
  const [selVersion, setSelVersion] = useState(null);
  const [diff, setDiff] = useState(null);

  const refreshAfterChange = async (label) => {
    const v = await api.getVersion(result.dungeonUid, selVersion);
    setDefinition(v.version.definition);
    setVersionId(v.version.id);
    setVersionStatus(v.version.status);
    const vs = await api.getVersions(result.dungeonUid);
    setVersions(vs.versions);
    if (label) setStatus(label);
  };

  const resolve = async () => {
    const q = input.trim();
    if (!q) return;
    setBusy(true); setError(''); setExp(null);
    try {
      const data = await api.resolveExperience(q);
      setExp(data.experience);
    } catch (err) {
      setError(err.message || '解析失败');
    } finally {
      setBusy(false);
    }
  };

  const source = exp
    ? { type: 'roblox_experience', universeId: exp.universeId, placeId: exp.placeId }
    : null;

  const generate = async (force = false) => {
    if (!source) return;
    setBusy(true); setError(''); setStatus('正在生成副本设计（AI Dungeon Designer）……');
    try {
      const r = await api.designDungeon(source, { force });
      setResult(r);
      setStatus(r.reused ? '复用已有成功设计（幂等）' : '生成完成，已创建 DRAFT');
      const v = await api.getVersion(r.dungeonUid, r.version);
      setDefinition(v.version.definition);
      setVersionId(v.version.id);
      setVersionStatus(v.version.status);
      setSelVersion(r.version);
      const vs = await api.getVersions(r.dungeonUid);
      setVersions(vs.versions);
    } catch (err) {
      setError(`${err.code ? `[${err.code}] ` : ''}${err.message}`);
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn, label) => {
    setBusy(true); setError('');
    try {
      await fn();
      await refreshAfterChange(label);
    } catch (err) {
      setError(`${err.code ? `[${err.code}] ` : ''}${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const loadVersion = async (vnum) => {
    setSelVersion(vnum);
    const v = await api.getVersion(result.dungeonUid, vnum);
    setDefinition(v.version.definition);
    setVersionId(v.version.id);
    setVersionStatus(v.version.status);
    setDiff(null);
  };

  const showDiff = async () => {
    if (versions.length < 2) return;
    const from = versions[versions.length - 2].version;
    const to = versions[versions.length - 1].version;
    const d = await api.getVersionDiff(result.dungeonUid, from, to);
    setDiff(d);
  };

  const Sec = ({ title, children, tone }) => (
    <div className={`dd-section ${tone || ''}`}>
      <h4>{title}</h4>
      {children}
    </div>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Dungeon Designer（副本设计流水线）</h2>
          <button className="btn small" onClick={onClose}>关闭</button>
        </div>

        <div className="chat-input-row">
          <input
            value={input}
            placeholder="粘贴 Roblox Experience URL 或 universe/place ID"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && resolve()}
          />
          <button className="btn" onClick={resolve} disabled={busy || !input.trim()}>
            {busy && !exp ? '解析中…' : '解析体验'}
          </button>
        </div>

        {error && <div className="error-bar">{error}</div>}
        {status && <div className="gm-status">🛠 {status}</div>}

        {exp && (
          <div className="dungeon-banner">
            {exp.iconUrl && <img src={exp.iconUrl} alt="" className="dungeon-icon" />}
            <div>
              <strong>{exp.name}</strong>
              <span className="source-badge">CANONICAL_FACT · roblox_api</span>
              <p className="dungeon-desc">
                universeId={exp.universeId} · placeId={exp.placeId || exp.rootPlaceId} · 创作者：
                {exp.creator ? exp.creator.name : '未知'}
              </p>
            </div>
            <button className="btn small primary" onClick={() => generate(false)} disabled={busy}>
              生成副本设计
            </button>
            <button className="btn small" onClick={() => generate(true)} disabled={busy} title="跳过幂等复用，强制新 design run">
              强制重生成
            </button>
          </div>
        )}

        {versions.length > 1 && (
          <div className="dd-versions">
            版本：
            {versions.map((v) => (
              <button
                key={v.id}
                className={`chip ${selVersion === v.version ? 'active' : ''}`}
                style={{ color: statusColor[v.status] }}
                onClick={() => loadVersion(v.version)}
              >
                v{v.version} · {v.status}
              </button>
            ))}
            <button className="chip" onClick={showDiff}>查看 v{versions[versions.length - 2]?.version}→v{versions[versions.length - 1]?.version} 差异</button>
          </div>
        )}

        {diff && (
          <Sec title={`差异 v${diff.from} → v${diff.to}`} tone="orig">
            <pre className="context-content">
              {JSON.stringify(diff, null, 2)}
            </pre>
          </Sec>
        )}

        {definition && (
          <>
            <Sec title="基本信息" tone="orig">
              <p>
                <strong>{definition.dungeon.display_name}</strong>（{definition.dungeon.name}）·
                难度 {definition.dungeon.difficulty}/10 · 建议 {definition.dungeon.recommended_party_size} 人 ·
                约 {definition.dungeon.estimated_duration} 分钟
              </p>
              <p className="dungeon-desc">{definition.dungeon.description}</p>
            </Sec>

            <Sec title="Canonical Facts（Roblox 官方事实 · 只读）" tone="canon">
              {definition.canonical_facts.length === 0 && <p className="muted">无</p>}
              <ul>
                {definition.canonical_facts.map((f, i) => (
                  <li key={i}>{f.key}: {String(f.value)}</li>
                ))}
              </ul>
            </Sec>

            {definition.vision_fact_candidates && definition.vision_fact_candidates.length > 0 && (
              <Sec title="Vision 观察（CANONICAL_FACT_CANDIDATE · 未确认）" tone="canon">
                <ul>
                  {definition.vision_fact_candidates.map((c, i) => (
                    <li key={i}>{c.value}</li>
                  ))}
                </ul>
              </Sec>
            )}

            <Sec title={`TRPG Original（AI 创作 · ${definition.scenes.length} 场景）`} tone="orig">
              {definition.scenes.map((s) => (
                <div key={s.id} className="dd-item">
                  <strong>[{s.order}] {s.name}</strong> <span className="muted small">{s.id}</span>
                  <p className="dungeon-desc">{s.description}</p>
                </div>
              ))}
            </Sec>

            <Sec title={`Encounters（${definition.encounters.length}）`} tone="orig">
              {definition.encounters.map((e) => (
                <div key={e.id} className="dd-item">
                  <strong>{e.name}</strong> <span className="muted small">{e.type} · 难度 {e.difficulty}</span>
                </div>
              ))}
            </Sec>

            <Sec title={`NPC（${definition.npcs.length}） / Enemies（${definition.enemies.length}）`} tone="orig">
              {definition.npcs.map((n) => (
                <div key={n.id} className="dd-item">🧑 {n.name} — {n.role}</div>
              ))}
              {definition.enemies.map((e) => (
                <div key={e.id} className="dd-item">
                  👾 {e.name}（HP {e.stats?.hp} / DMG {e.stats?.damage}）
                </div>
              ))}
            </Sec>

            {definition.boss && (
              <Sec title="Boss" tone="orig">
                <div className="dd-item">
                  <strong>{definition.boss.name}</strong>（HP {definition.boss.stats?.hp}）
                  <p className="dungeon-desc">{definition.boss.description}</p>
                  <p className="muted small">阶段：{(definition.boss.phases || []).join(' → ')}</p>
                </div>
              </Sec>
            )}

            <Sec title={`Reward Candidates（${definition.reward_candidates.length} · 仅候选，未发放）`} tone="orig">
              {definition.reward_candidates.map((r, i) => (
                <div key={i} className="dd-item">
                  [{r.type}] {r.name} · {r.rarity} <span className="muted small">{r.source_type}</span>
                </div>
              ))}
            </Sec>

            <div className="chat-input-row" style={{ borderTop: 'none' }}>
              <button className="btn" disabled={busy || versionStatus !== 'DRAFT'}
                onClick={() => act(() => api.submitReview(versionId), '已提交审核（REVIEW）')}>
                提交审核
              </button>
              <button className="btn primary" disabled={busy || versionStatus !== 'REVIEW'}
                onClick={() => act(() => api.reviewVersion(versionId, 'APPROVED', '符合规则'), '已批准（APPROVED）')}>
                批准
              </button>
              <button className="btn danger" disabled={busy || versionStatus !== 'REVIEW'}
                onClick={() => act(() => api.reviewVersion(versionId, 'REJECTED', '审核不通过'), '已拒绝（REJECTED）')}>
                拒绝
              </button>
              <button className="btn primary" disabled={busy || versionStatus !== 'APPROVED'}
                onClick={() => act(() => api.publishVersion(versionId), '已发布（PUBLISHED，immutable）')}>
                发布
              </button>
            </div>
            <p className="muted small">
              状态：{versionStatus} · AI 永不自动发布；PUBLISHED 后不可修改（需创建新版本）。
            </p>
          </>
        )}
      </div>
    </div>
  );
}
