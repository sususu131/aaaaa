import { useEffect, useRef, useState } from 'react';

/**
 * 聊天区：消息流 + 输入框（F7/F8）。系统消息以灰色居中显示。
 */
export default function ChatPanel({ messages, myName, onSend }) {
  const [text, setText] = useState('');
  const listRef = useRef(null);

  // 新消息自动滚动到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText('');
  };

  const formatTime = (iso) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <section className="chat-panel">
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && <p className="chat-empty">还没有消息，说点什么吧…</p>}
        {messages.map((m) =>
          m.type === 'system' ? (
            <p key={m.id} className="msg system">
              {m.text}
            </p>
          ) : (
            <div key={m.id} className={`msg ${m.playerName === myName ? 'mine' : ''}`}>
              <span className="msg-meta">
                <strong>{m.playerName}</strong> {formatTime(m.at)}
              </span>
              <span className="msg-text">{m.text}</span>
            </div>
          )
        )}
      </div>
      <div className="chat-input-row">
        <input
          value={text}
          maxLength={500}
          placeholder="输入消息，回车发送…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button className="btn primary" onClick={send} disabled={!text.trim()}>
          发送
        </button>
      </div>
    </section>
  );
}
