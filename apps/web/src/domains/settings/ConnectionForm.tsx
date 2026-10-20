import { useState } from 'react';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import { displayGatewayUrl } from '../../gateway/url';

const STATE_LABELS: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中…',
  open: 'online',
  reconnecting: '重连中…',
  closed: '已断开',
  error: '连接失败',
};

/** Settings → Connection：gateway URL / token 唯一入口（顶栏不再放表单）。 */
export function ConnectionForm() {
  const {
    gatewayUrl,
    token,
    gatewayError,
    tokenError,
    lastError,
    connectionState,
    hello,
    tenantId,
    epoch,
    closeCode,
    connect,
    disconnect,
    retry,
    clearTokenError,
  } = useConnection();
  const toast = useToast();
  const [urlDraft, setUrlDraft] = useState(gatewayUrl);
  const [tokenDraft, setTokenDraft] = useState(token);

  const urlError = gatewayError;

  const submit = () => {
    // 地址/token 未变化且已连接时，按「重新连接」处理，而不是无操作。
    if (
      connectionState === 'open' &&
      urlDraft.trim() === gatewayUrl &&
      tokenDraft.trim() === token
    ) {
      retry();
      toast.info('正在重新连接 gateway…');
      return;
    }
    if (connect({ gatewayUrl: urlDraft, token: tokenDraft })) {
      toast.info('正在连接 gateway…');
    }
  };

  return (
    <div className="settings-section">
      <section className="panel">
        <h2 className="section-title">连接 gateway</h2>
        <p className="section-desc">
          token 只保存在 sessionStorage；URL 保存在 localStorage。非回环地址必须使用 HTTPS。
        </p>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Gateway URL</span>
            <input
              className={`input ${urlError ? 'invalid' : ''}`.trim()}
              value={urlDraft}
              onChange={(event) => {
                setUrlDraft(event.target.value);
                clearTokenError();
              }}
              placeholder="留空 = 同源（推荐）"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={urlError ? true : undefined}
              aria-describedby={urlError ? 'connection-url-error' : undefined}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            {urlError && (
              <span className="field-error" id="connection-url-error" role="alert">
                {urlError}
              </span>
            )}
            <span className="field-hint mono">
              当前：{displayGatewayUrl(gatewayUrl, window.location.origin)}
            </span>
          </label>

          <label className="field">
            <span className="field-label">Token</span>
            <input
              className={`input ${tokenError ? 'invalid' : ''}`.trim()}
              type="password"
              value={tokenDraft}
              onChange={(event) => {
                setTokenDraft(event.target.value);
                clearTokenError();
              }}
              placeholder="gateway token（或通过 #token=… 打开）"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={tokenError ? true : undefined}
              aria-describedby={tokenError ? 'connection-token-error' : undefined}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            {tokenError && (
              <span className="field-error" id="connection-token-error" role="alert">
                {tokenError}
              </span>
            )}
          </label>
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={submit}>
            {connectionState === 'open' ? '重新连接' : '连接'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={retry}
            disabled={!token.trim() || connectionState === 'open'}
          >
            立即重试
          </button>
          <button
            type="button"
            className="btn btn-danger-ghost"
            onClick={() => {
              disconnect();
              setTokenDraft('');
              toast.info('已断开并清除 token');
            }}
            disabled={!token.trim()}
          >
            断开并清除 token
          </button>
        </div>

        {lastError && (
          <p className="form-error" role="alert">
            {lastError}
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">诊断</h2>
        <dl className="diag-list">
          <dt>连接状态</dt>
          <dd>{STATE_LABELS[connectionState] ?? connectionState}</dd>
          <dt>Gateway</dt>
          <dd className="mono">{displayGatewayUrl(gatewayUrl, window.location.origin)}</dd>
          <dt>协议版本</dt>
          <dd className="mono">
            {hello ? `v${hello.protocol.version}` : '—'}
            {hello?.protocol.features.includes('tls') ? ' · TLS' : ''}
          </dd>
          <dt>节点</dt>
          <dd className="mono">{hello ? hello.node.node_id : '—'}</dd>
          <dt>租户</dt>
          <dd className="mono">{tenantId ?? '—'}</dd>
          <dt>最新 seq</dt>
          <dd className="mono">{hello ? hello.latest_seq : '—'}</dd>
          <dt>Feature 数</dt>
          <dd className="mono">
            {hello?.protocol.features.length ?? '—'}
            {hello ? `（${hello.protocol.features.join(', ')}）` : ''}
          </dd>
          <dt>Close code</dt>
          <dd className="mono">
            {closeCode === null ? '—' : closeCode}
            {closeCode === 4401
              ? ' · token 无效'
              : closeCode === 4403
                ? ' · 无权访问该租户'
                : closeCode === 4400
                  ? ' · 协议不兼容'
                  : ''}
          </dd>
        </dl>
        {!hello && (
          <p className="section-desc">
            连接失败时请依次检查：地址是否可达、Origin 是否在 serve.allowed_origins、 token
            是否有效、非回环是否使用 HTTPS。
          </p>
        )}
      </section>

      <p className="sr-only" aria-live="polite">
        {epoch > 0 && connectionState === 'open' ? '已连接 gateway' : ''}
      </p>
    </div>
  );
}
