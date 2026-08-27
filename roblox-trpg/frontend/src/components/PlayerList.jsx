/**
 * 玩家列表：实时同步（F6/F9）。阶段1统一显示为培根头占位。
 */
export default function PlayerList({ players, myName, maxPlayers }) {
  const slots = Array.from({ length: maxPlayers });

  return (
    <aside className="player-panel">
      <h2>玩家（{players.length}/{maxPlayers}）</h2>
      <ul className="player-list">
        {slots.map((_, i) => {
          const p = players[i];
          return (
            <li key={p ? p.name : `empty-${i}`} className={`player-item ${p ? '' : 'empty'}`}>
              <span className="avatar">🥓</span>
              {p ? (
                <span className="player-name">
                  {p.name}
                  {p.name === myName && <em>（我）</em>}
                </span>
              ) : (
                <span className="player-name muted">等待加入…</span>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
