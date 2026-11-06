import { useEffect, useState } from 'react';
import { useToast } from '../../components/ToastProvider';
import { Button, Field, Input, KeyValueList, Section } from '../../components/ui';
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

function modeLabel(mode: 'pending' | 'platform' | 'legacy'): string {
  if (mode === 'platform') return t('connection.modePlatform');
  if (mode === 'legacy') return t('connection.modeLegacy');
  return t('connection.modePending');
}

/**
 * Settings → Connection：平台 URL / 平台 token /（可选）node token 唯一入口。
 *
 * 0.49：平台 token 只进 sessionStorage 平台槽；node token 由
 * `platform.nodes.credentials` 或此处的可选输入提供，key 优先 node_id。
 * 页面由 legacy `--serve` 提供时，本表单退回旧的 node URL + node token 语义。
 */
export function ConnectionForm() {
  useLocale();
  const {
    platformUrl,
    platformToken,
    nodeUrl,
    nodeToken,
    mode,
    platformError,
    devProxyAuth,
    gatewayError,
    tokenError,
    lastError,
    connectionState,
    hello,
    tenantId,
    epoch,
    closeCode,
    hasToken,
    connect,
    disconnect,
    retry,
    clearTokenError,
  } = useConnection();
  const { current } = useNodes();
  const nodeNames = useNodeNames();
  const toast = useToast();
  const legacy = mode === 'legacy';
  const [urlDraft, setUrlDraft] = useState(platformUrl);
  const [tokenDraft, setTokenDraft] = useState(platformToken);
  const [nodeTokenDraft, setNodeTokenDraft] = useState('');

  // legacy 回退后 token 槽换成旧 `vessel.token`；只在模式切换时同步一次。
  // biome-ignore lint/correctness/useExhaustiveDependencies: mode 是唯一同步触发器
  useEffect(() => {
    if (mode === 'legacy') setTokenDraft(nodeToken);
  }, [mode]);

  const urlError = gatewayError ?? platformError;

  const submit = () => {
    // 地址/token 未变化且已连接时，按「重新连接」处理，而不是无操作。
    if (
      connectionState === 'open' &&
      urlDraft.trim() === platformUrl &&
      tokenDraft.trim() === platformToken &&
      nodeTokenDraft.trim() === ''
    ) {
      retry();
      toast.info(t('connection.reconnecting'));
      return;
    }
    const options = legacy
      ? { platformUrl: urlDraft, token: tokenDraft }
      : { platformUrl: urlDraft, token: tokenDraft, nodeToken: nodeTokenDraft };
    if (connect(options)) {
      toast.info(t('connection.connecting'));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Section
        title={t('connection.title')}
        description={
          devProxyAuth ? t('settings.connection.devProxyNotice') : t('connection.description')
        }
      >
        <div className="form-grid">
          <Field
            label={legacy ? t('connection.nodeUrl') : t('connection.platformUrl')}
            htmlFor="connection-url"
            error={
              !devProxyAuth && urlError ? (
                <span id="connection-url-error">{urlError}</span>
              ) : undefined
            }
            hint={
              <span className="font-mono">
                {t('connection.current', {
                  url: displayGatewayUrl(legacy ? nodeUrl : platformUrl, window.location.origin),
                })}
              </span>
            }
          >
            <Input
              id="connection-url"
              invalid={!devProxyAuth && Boolean(urlError)}
              value={
                devProxyAuth ? displayGatewayUrl(platformUrl, window.location.origin) : urlDraft
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
              aria-describedby={!devProxyAuth && urlError ? 'connection-url-error' : undefined}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </Field>

          {!devProxyAuth && (
            <Field
              label={legacy ? t('connection.nodeToken') : t('connection.platformToken')}
              htmlFor="connection-token"
              error={tokenError ? <span id="connection-token-error">{tokenError}</span> : undefined}
            >
              <Input
                id="connection-token"
                invalid={Boolean(tokenError)}
                type="password"
                value={tokenDraft}
                onChange={(event) => {
                  setTokenDraft(event.target.value);
                  clearTokenError();
                }}
                placeholder={
                  legacy
                    ? t('connection.nodeTokenPlaceholder')
                    : t('connection.platformTokenPlaceholder')
                }
                spellCheck={false}
                autoComplete="off"
                aria-describedby={tokenError ? 'connection-token-error' : undefined}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
            </Field>
          )}

          {!devProxyAuth && !legacy && (
            <Field label={t('connection.nodeTokenOptional')} htmlFor="connection-node-token">
              <Input
                id="connection-node-token"
                type="password"
                value={nodeTokenDraft}
                onChange={(event) => {
                  setNodeTokenDraft(event.target.value);
                  clearTokenError();
                }}
                placeholder={t('connection.nodeTokenPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
            </Field>
          )}
        </div>

        <div className="form-actions">
          {!devProxyAuth && (
            <Button variant="primary" onClick={submit}>
              {connectionState === 'open' ? t('connection.reconnect') : t('connection.connect')}
            </Button>
          )}
          <Button onClick={retry} disabled={connectionState === 'open' || !hasToken}>
            {t('connection.retryNow')}
          </Button>
          {!devProxyAuth && (
            <Button
              variant="dangerGhost"
              onClick={() => {
                disconnect();
                setTokenDraft('');
                setNodeTokenDraft('');
                toast.info(t('connection.disconnected'));
              }}
              disabled={!hasToken}
            >
              {t('connection.disconnect')}
            </Button>
          )}
        </div>

        {lastError && (
          <p className="form-error" role="alert">
            {lastError}
          </p>
        )}
        {platformError && (
          <p className="form-error" role="alert">
            {platformError}
          </p>
        )}
      </Section>

      <Section title={t('connection.diagnostics')}>
        <KeyValueList
          items={[
            {
              key: 'state',
              label: t('connection.state'),
              value: stateLabel(connectionState),
            },
            {
              key: 'mode',
              label: t('connection.mode'),
              value: modeLabel(mode),
            },
            {
              key: 'platform',
              label: t('connection.platformUrl'),
              value: (
                <span className="font-mono">
                  {displayGatewayUrl(platformUrl, window.location.origin)}
                </span>
              ),
            },
            {
              key: 'node-url',
              label: t('connection.nodeUrl'),
              value: (
                <span className="font-mono">
                  {displayGatewayUrl(nodeUrl, window.location.origin)}
                </span>
              ),
            },
            {
              key: 'protocol',
              label: t('connection.protocol'),
              value: (
                <span className="font-mono">
                  {hello ? `v${hello.protocol.version}` : '—'}
                  {hello?.protocol.features.includes('tls') ? ' · TLS' : ''}
                </span>
              ),
            },
            {
              key: 'node',
              label: t('connection.node'),
              value: (
                <span className="font-mono">
                  {current ? (nodeNames.get(nodeKeyOf(current)) ?? '—') : '—'}
                </span>
              ),
            },
            {
              key: 'tenant',
              label: t('connection.tenant'),
              value: <span className="font-mono">{tenantId ?? '—'}</span>,
            },
            {
              key: 'latestSeq',
              label: t('connection.latestSeq'),
              value: <span className="font-mono">{hello ? hello.latest_seq : '—'}</span>,
            },
            {
              key: 'featureCount',
              label: t('connection.featureCount'),
              value: (
                <span className="font-mono">
                  {hello?.protocol.features.length ?? '—'}
                  {hello
                    ? t('connection.featureList', {
                        features: hello.protocol.features.join(', '),
                      })
                    : ''}
                </span>
              ),
            },
            {
              key: 'closeCode',
              label: 'Close code',
              value: (
                <span className="font-mono">
                  {closeCode === null ? '—' : closeCode}
                  {closeCode === 4401
                    ? t('connection.closeCodeToken')
                    : closeCode === 4403
                      ? t('connection.closeCodeForbidden')
                      : closeCode === 4400
                        ? t('connection.closeCodeProtocol')
                        : ''}
                </span>
              ),
            },
          ]}
        />
        {!hello && (
          <p className="mt-1.5 max-w-prose text-md text-muted">{t('connection.failureHint')}</p>
        )}
      </Section>

      <p className="sr-only" aria-live="polite">
        {epoch > 0 && connectionState === 'open' ? t('connection.connected') : ''}
      </p>
    </div>
  );
}
