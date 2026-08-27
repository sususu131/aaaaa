/**
 * AI 行动选项（Step 11-12）。
 * 点击只把行动文本填入聊天输入框，玩家可自由修改后自行发送——
 * 选项是建议，不是强制行动。
 */
export default function ActionOptions({ options, onPick }) {
  return (
    <div className="action-options">
      {options.map((o, i) => (
        <button key={i} className="option-btn" title={o.action} onClick={() => onPick(o.action)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
