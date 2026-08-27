import { useEffect, useRef, useState } from 'react';
import ActionOptions from './ActionOptions.jsx';

/**
 * 聊天区：消息流 + @提及补全 + GM 结构化回复（含行动选项）。
 * 输入框内容受控于 App（AI 选项点击后填入，可编辑，不自动发送）。
 */
export default function ChatPanel({
  messages,
  myName,
  players,
  chatDraft,
  onChatDraftChange,
  onSend,
  onPickOption,
}) {
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

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
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <section className="chat-panel">
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && <p className="chat-empty">还没有消息。输入 @AI 开始跑团…</p>}
        {messages.map((m) => {
          if (m.type === 'system') {
            return (
              <p key={m.id} className="msg system">
                {m.text}
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
          placeholder="输入消息… @AI 呼唤主持人，@玩家 提及队友"
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
