import { useState } from 'react';

/**
 * 入口页：输入名字 → 创建房间 / 输入房间ID加入（F2–F5）。
 */
export default function LobbyScreen({ initialName, onCreate, onJoin, connected }) {
  const [name, setName] = useState(initialName);
  const [joinCode, setJoinCode] = useState('');

  const nameValid = name.trim().length > 0;

  const handleCreate = () => {
    if (!nameValid) return;
    onCreate(name.trim());
  };

  const handleJoin = () => {
    if (!nameValid || !joinCode.trim()) return;
    onJoin(name.trim(), joinCode.trim().toUpperCase());
  };

  return (
    <main className="lobby">
      <section className="lobby-card">
        <p className="world-brief">
          全球突变，Roblox降临现实。没有账号的人，将变成培根头……
        </p>

        <label className="field">
          <span>你的名字</span>
          <input
            value={name}
            maxLength={16}
            placeholder="输入名字（1-16字符）"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
        </label>

        <button className="btn primary" disabled={!nameValid || !connected} onClick={handleCreate}>
          创建房间
        </button>

        <div className="divider">或加入好友的房间</div>

        <label className="field">
          <span>房间ID</span>
          <input
            value={joinCode}
            maxLength={6}
            placeholder="例如 ABC123"
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
          />
        </label>

        <button className="btn" disabled={!nameValid || !joinCode.trim() || !connected} onClick={handleJoin}>
          加入房间
        </button>
      </section>
    </main>
  );
}
