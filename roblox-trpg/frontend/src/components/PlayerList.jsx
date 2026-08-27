/**
 * 玩家列表：实时同步。已绑定公开 Roblox 资料的显示头像，否则培根头。
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
            <li key={p ? `${p.uid || p.name}-${i}` : `empty-${i}`} className={`player-item ${p ? '' : 'empty'}`}>
              {p && p.headshotUrl ? (
                <img src={p.headshotUrl} alt="" className="avatar-img" />
              ) : (
                <span className="avatar">🥓</span>
              )}
              <span className="player-name-col">
                <span className="player-name">
                  {p ? p.name : '等待加入…'}
                  {p && p.name === myName && <em>（我）</em>}
                </span>
                {p && p.roblox ? (
                  <span className="roblox-tag" title={`Roblox User ID: ${p.roblox.userId}`}>
                    R6 · {p.roblox.displayName || p.roblox.username}
                  </span>
                ) : p ? (
                  <span className="bacon-tag">培根头</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
