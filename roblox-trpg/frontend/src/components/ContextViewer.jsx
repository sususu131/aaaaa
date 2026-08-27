import { useEffect, useState } from 'react';
import { socket } from '../lib/socket.js';

/**
 * Context Viewer（Step 15-16）：GM 调试窗口。
 * 分类显示 10 个 Context 分区 + 各部分与总 token 占用。
 * 服务端已脱敏：不包含 API Key / 会话令牌等敏感信息。
 */
export default function ContextViewer({ onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [openKey, setOpenKey] = useState('events');

  useEffect(() => {
    socket.emit('context:view', {}, (res) => {
      if (!res || !res.ok) {
        setError((res && res.error) || '无法获取 Context');
      } else {
        setData(res);
      }
    });
  }, []);

  const fmt = (n) => n.toLocaleString();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Context Viewer（调试）</h2>
          <button className="btn small" onClick={onClose}>
            关闭
          </button>
        </div>

        {error && <p className="error-bar">{error}</p>}

        {data && (
          <>
            <div className="context-total">
              <strong>
                {fmt(data.totalTokens)} / {fmt(data.budget)} tokens（估计值）
              </strong>
              <div className="token-bar">
                <div
                  className="token-fill"
                  style={{ width: `${Math.min(100, (data.totalTokens / data.budget) * 100)}%` }}
                />
              </div>
            </div>

            <div className="context-breakdown">
              {data.sections.map((s) => (
                <span
                  key={s.key}
                  className={`chip ${openKey === s.key ? 'active' : ''}`}
                  onClick={() => setOpenKey(s.key)}
                >
                  {s.label} · {fmt(s.tokens)}
                </span>
              ))}
            </div>

            <pre className="context-content">
              {(data.sections.find((s) => s.key === openKey) || data.sections[0]).content}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
