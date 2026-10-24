import { useState } from 'react';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { displayGatewayUrl } from '../../gateway/url';
import { t, useLocale } from '../../i18n';
import { useNodeNames } from '../nodes/useNodeNames';

function stateLabel(state: string): string {
  switch (state) {
    case 'connecting':
      return t('nav.conn.connecting');
    case 'open':
      return t('status.connected');
    case 'reconnecting':
      return t('nav.conn.reconnecting');
    case 'closed':
      return t('nav.conn.closed');
    case 'error':
      return t('nav.conn.error');
    default:
      return t('nav.conn.idle');
  }
}

/** Settings → Connection：gateway URL / token 唯一入口（顶栏不再放表单）。 */
export function ConnectionForm() {
  useLocale();
  const {
    gatewayUrl,
    token,
    devProxyAuth,
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
  const { current } = useNodes();
  const nodeNames = useNodeNames();
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
      toast.info(t('connection.reconnecting'));
      return;
    }
    if (connect({ gatewayUrl: urlDraft, token: tokenDraft })) {
      toast.info(t('connection.connecting'));
    }
  };

  return (
    <div className="settings-section">
      <section className="panel">
        <h2 className="section-title">{t('connection.title')}</h2>
        <p className="section-desc">
          {devProxyAuth ? t('settings.connection.devProxyNotice') : t('connection.description')}
        </p>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Gateway URL</span>
            <input
              className={`input ${!devProxyAuth && urlError ? 'invalid' : ''}`.trim()}
              value={
                devProxyAuth ? displayGatewayUrl(gatewayUrl, window.location.origin) : urlDraft
              }
              onChange={(event) => {
                if (devProxyAuth) return;
                setUrlDraft(event.target.value);
                clearTokenError();
              }}
              readOnly={devProxyAuth}
              placeholder={t('connection.urlPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!devProxyAuth && urlError ? true : undefined}
              aria-describedby={!devProxyAuth && urlError ? 'connection-url-error' : undefined}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            {!devProxyAuth && urlError && (
              <span className="field-error" id="connection-url-error" role="alert">
                {urlError}
              </span>
            )}
            <span className="field-hint mono">
              {t('connection.current', {
                url: displayGatewayUrl(gatewayUrl, window.location.origin),
              })}
            </span>
          </label>

          {!devProxyAuth && (
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
                placeholder={t('connection.tokenPlaceholder')}
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
          )}
        </div>

        <div className="form-actions">
          {!devProxyAuth && (
            <button type="button" className="btn btn-primary" onClick={submit}>
              {connectionState === 'open' ? t('connection.reconnect') : t('connection.connect')}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={retry}
            disabled={!token.trim() || connectionState === 'open'}
          >
            {t('connection.retryNow')}
          </button>
          {!devProxyAuth && (
            <button
              type="button"
              className="btn btn-danger-ghost"
              onClick={() => {
                disconnect();
                setTokenDraft('');
                toast.info(t('connection.disconnected'));
              }}
              disabled={!token.trim()}
            >
              {t('connection.disconnect')}
            </button>
          )}
        </div>

        {lastError && (
          <p className="form-error" role="alert">
            {lastError}
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">{t('connection.diagnostics')}</h2>
        <dl className="diag-list">
          <dt>{t('connection.state')}</dt>
          <dd>{stateLabel(connectionState)}</dd>
          <dt>Gateway</dt>
          <dd className="mono">{displayGatewayUrl(gatewayUrl, window.location.origin)}</dd>
          <dt>{t('connection.protocol')}</dt>
          <dd className="mono">
            {hello ? `v${hello.protocol.version}` : '—'}
            {hello?.protocol.features.includes('tls') ? ' · TLS' : ''}
          </dd>
          <dt>{t('connection.node')}</dt>
          <dd className="mono">{current ? (nodeNames.get(nodeKeyOf(current)) ?? '—') : '—'}</dd>
          <dt>{t('connection.tenant')}</dt>
          <dd className="mono">{tenantId ?? '—'}</dd>
          <dt>{t('connection.latestSeq')}</dt>
          <dd className="mono">{hello ? hello.latest_seq : '—'}</dd>
          <dt>{t('connection.featureCount')}</dt>
          <dd className="mono">
            {hello?.protocol.features.length ?? '—'}
            {hello
              ? t('connection.featureList', { features: hello.protocol.features.join(', ') })
              : ''}
          </dd>
          <dt>Close code</dt>
          <dd className="mono">
            {closeCode === null ? '—' : closeCode}
            {closeCode === 4401
              ? t('connection.closeCodeToken')
              : closeCode === 4403
                ? t('connection.closeCodeForbidden')
                : closeCode === 4400
                  ? t('connection.closeCodeProtocol')
                  : ''}
          </dd>
        </dl>
        {!hello && <p className="section-desc">{t('connection.failureHint')}</p>}
      </section>

      <p className="sr-only" aria-live="polite">
        {epoch > 0 && connectionState === 'open' ? t('connection.connected') : ''}
      </p>
    </div>
  );
}
