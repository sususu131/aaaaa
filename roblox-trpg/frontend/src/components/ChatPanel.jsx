import { useEffect, useRef, useState } from 'react';
import ActionOptions from './ActionOptions.jsx';

/**
 * 聊天区：消息流 + @提及补全 + GM 结构化回复（含行动选项）。
 * 输入框内容受控于 App（AI 选项点击后填入 @AI 前缀，可编辑，不自动发送）。
 * 阶段31：消息区是固定高度的可滚动容器（像聊天软件）——
 *  - 新消息到达时若贴底则自动滚到底；不在底部则显示「↓ 最新消息」跳转钮；
 *  - 上滑到顶时从服务器分页拉取更早消息（chat:history），并保持视口不跳动。
 */
export default function ChatPanel({
  messages,
  myName,
  players,
  chatDraft,
  onChatDraftChange,
  onSend,
  onPickOption,
  onLoadOlder,
  hasOlder,
}) {
  const listRef = useRef(null);
  const nearBottomRef = useRef(true); // 发新消息时是否贴底（决定是否自动跟随滚动）
  const loadingRef = useRef(false); // 上滑加载去重
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = (smooth = false) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  // 新消息：贴底 → 跟随滚动；离底 → 显示跳转钮（不打断用户回看）
  useEffect(() => {
    if (nearBottomRef.current) {
      scrollToBottom();
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [messages]);

  /** 上滑到顶：拉取更早的历史消息，并按内容高度差恢复滚动位置（视口不跳）。 */
  const loadOlder = async () => {
    if (loadingRef.current || !hasOlder || !onLoadOlder || messages.length === 0) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    const el = listRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    try {
      await onLoadOlder(messages[0].id);
    } finally {
      setLoadingOlder(false);
      loadingRef.current = false;
      requestAnimationFrame(() => {
        const el2 = listRef.current;
        if (el2) el2.scrollTop = el2.scrollHeight - prevHeight + prevTop;
      });
    }
  };

  const onScroll = (e) => {
    const el = e.target;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distanceToBottom < 60;
    nearBottomRef.current = near;
    if (near) setShowJump(false);
    if (el.scrollTop <= 48 && !loadingRef.current) loadOlder();
  };

  const send = () => {
    const value = chatDraft.trim();
    if (!value) return;
    onSend(value);
  };

  // ── @ 提及补全：输入 @ 时显示 @AI + 房间玩家 ──
  const mentionMatch = chatDraft.match(/@([^\s@]*)$/);
  const mentionQuery = mentionMatch ? mentionMatch[1].toLowerCase() : null;
  const mentionCandidates =
    mentionQuery === null
      ? []
      : [
          { tag: '@AI', hint: '呼唤游戏主持人（GM）' },
          ...players.filter((p) => p.name !== myName).map((p) => ({ tag: `@${p.name}`, hint: '提及玩家' })),
        ].filter((c) => c.tag.slice(1).toLowerCase().startsWith(mentionQuery));

  const insertMention = (tag) => {
    onChatDraftChange(chatDraft.replace(/@([^\s@]*)$/, `${tag} `));
  };

  const formatTime = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // 关键游戏事件（骰子/检定/获得/世界变化）：渲染为事件条
  const renderEvent = (m) => {
    let d = {};
    try {
      d = JSON.parse(m.text);
    } catch {
      return m.text; // 阶段31：dungeon 进程消息为纯文本，直接显示
    }
    switch (d.event) {
      case 'dice:rolled':
        return `🎲 服务器掷骰 ${d.count}d${d.sides} = [${(d.rolls || []).join(', ')}] 合计 ${d.total}`;
      case 'skill:check':
        return `⚔ ${d.playerName} 技能检定「${d.skill}」：玩家骰${d.playerRoll}${d.modifier ? `+${d.modifier}` : ''} vs 难度骰${d.difficultyRoll} → ${d.success ? '✅成功' : d.draw ? '🤝平局' : '❌失败'}`;
      case 'skill:gained':
        return `✨ ${d.playerName} 获得技能「${d.skillName}」（来源副本：${d.dungeon}）`;
      case 'item:gained':
        return `🎁 ${d.playerName} 获得物品「${d.itemName}」×${d.quantity}`;
      case 'world:changed':
        return `🌍 世界状态变更：${d.field} = ${JSON.stringify(d.value)}（v${d.version}）`;
      case 'dungeon:completed':
        return `🏁 副本「${d.dungeon}」通关：${(d.players || []).join('、')}`;
      default:
        return JSON.stringify(d).slice(0, 100);
    }
  };

  const EVENT_TYPES = ['dice', 'skill_check', 'gain', 'world', 'dungeon'];

  return (
    <section className="chat-panel">
      <div className="chat-messages" ref={listRef} onScroll={onScroll}>
        {loadingOlder && <p className="chat-loadline">⏳ 加载更早的消息…</p>}
        {!hasOlder && messages.length > 0 && <p className="chat-loadline muted">— 没有更早的消息了 —</p>}
        {messages.length === 0 && <p className="chat-empty">还没有消息。输入 @AI 开始跑团…</p>}
        {messages.map((m) => {
          if (m.type === 'system') {
            return (
              <p key={m.id} className="msg system">
                {m.text}
              </p>
            );
          }
          if (EVENT_TYPES.includes(m.type)) {
            return (
              <p key={m.id} className="msg event-line">
                {renderEvent(m)}
              </p>
            );
          }
          if (m.type === 'gm') {
            return (
              <div key={m.id} className="msg gm">
                <span className="msg-meta gm-meta">
                  🎲 GM{m.askerName ? `（回应 ${m.askerName}）` : ''} {formatTime(m.at)}
                </span>
                <span className="msg-text">{m.narrative}</span>
                {m.options && m.options.length > 0 && (
                  <ActionOptions options={m.options} onPick={onPickOption} />
                )}
                {m.sourceReferences && m.sourceReferences.length > 0 && (
                  <details className="source-refs">
                    <summary>资料来源（{m.sourceReferences.length}）</summary>
                    <ul>
                      {m.sourceReferences.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          }
          return (
            <div key={m.id} className={`msg ${m.playerName === myName ? 'mine' : ''}`}>
              <span className="msg-meta">
                <strong>{m.playerName}</strong> {formatTime(m.at)}
              </span>
              <span className="msg-text">{m.text}</span>
            </div>
          );
        })}
      </div>

      {showJump && (
        <button className="jump-latest" onClick={() => scrollToBottom(true)}>
          ↓ 最新消息
        </button>
      )}

      {mentionCandidates.length > 0 && (
        <div className="mention-box">
          {mentionCandidates.map((c) => (
            <button key={c.tag} onClick={() => insertMention(c.tag)}>
              {c.tag} <span className="muted">{c.hint}</span>
            </button>
          ))}
        </div>
      )}

      <div className="chat-input-row">
        <input
          value={chatDraft}
          maxLength={2000}
          placeholder="输入消息… @AI 呼唤主持人 / 副本运行中 @AI 提交行动"
          onChange={(e) => onChatDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary" onClick={send} disabled={!chatDraft.trim()}>
          发送
        </button>
      </div>
    </section>
  );
}
