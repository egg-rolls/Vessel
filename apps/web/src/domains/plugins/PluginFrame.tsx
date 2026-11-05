/**
 * 第三方 plugin UI 的唯一宿主：sandboxed iframe + postMessage RPC 桥。
 *
 * 安全边界（CONTRACT-0.43 §7）：
 * - 只给 `allow-scripts allow-forms`，不给 `allow-same-origin`；页面是不透明源。
 * - 只接受来自本 iframe `contentWindow` 的消息；opaque sandbox 的 `event.origin`
 *   为字符串 `"null"`，因此按 source 做硬校验，origin 只做允许值校验。
 * - plugin id 来自已渲染的 contributions；方法名必须在该 plugin 的 rpc/commands 白名单。
 * - 未知消息静默丢弃，不抛错、不回显。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import { pluginFrameUrl } from './plugin-contributions';

const RPC_MESSAGE = 'vessel.plugin.rpc';
const RPC_RESULT = 'vessel.plugin.rpc.result';
const REFRESH_MESSAGE = 'vessel.plugin.refresh';
const MAX_MESSAGE_ID = 128;

export interface PluginFrameContext {
  run?: string;
  session?: string;
}

function rpcError(error: unknown): { code: string; message: string } {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return { code: typeof code === 'string' ? code : 'internal', message };
}

export function PluginFrame({
  pluginId,
  entry,
  title,
  methods,
  context,
  className,
}: {
  pluginId: string;
  entry: string;
  title: string;
  /** 允许调用的方法名（来自该 plugin 的 contributions.rpc / commands）。 */
  methods: ReadonlySet<string>;
  context?: PluginFrameContext;
  className?: string;
}) {
  const locale = useLocale();
  const { client, gatewayUrl, eventStore } = useConnection();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const contextRun = context?.run;
  const contextSession = context?.session;
  const src = useMemo(
    () =>
      pluginFrameUrl(gatewayUrl, pluginId, entry, {
        run: contextRun,
        session: contextSession,
        lang: locale,
      }),
    [gatewayUrl, pluginId, entry, contextRun, contextSession, locale],
  );

  const postToFrame = useCallback((message: unknown) => {
    // opaque sandbox 的 origin 是 "null"；接收方按 event.source 校验发送者。
    iframeRef.current?.contentWindow?.postMessage(message, '*');
  }, []);

  // iframe → host：校验 source / origin / plugin id / 方法白名单后转发 gateway。
  useEffect(() => {
    if (src === null) return;
    const frameOrigin = new URL(src).origin;
    const inFlight = new Set<string>();
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== 'null' && event.origin !== frameOrigin) return;
      const data: unknown = event.data;
      if (data === null || typeof data !== 'object') return;
      const message = data as Record<string, unknown>;
      if (message.type !== RPC_MESSAGE) return;
      const id = message.id;
      const method = message.method;
      if (typeof id !== 'string' || id === '' || id.length > MAX_MESSAGE_ID) return;
      if (typeof method !== 'string' || !methods.has(method)) return;
      if (inFlight.has(id)) return;
      inFlight.add(id);
      void client
        .rpc<unknown>(`plugin.${pluginId}.${method}`, message.params)
        .then((result) => postToFrame({ type: RPC_RESULT, id, result }))
        .catch((error: unknown) => postToFrame({ type: RPC_RESULT, id, error: rpcError(error) }))
        .finally(() => inFlight.delete(id));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [client, pluginId, methods, postToFrame, src]);

  // host → iframe：`plugin.ready` 或热重载后的 `plugin.changed` 让页面自行重取数据。
  useEffect(() => {
    if (src === null) return;
    let lastVersion = eventStore.getSnapshot().version;
    return eventStore.subscribe(() => {
      const snapshot = eventStore.getSnapshot();
      if (snapshot.version === lastVersion) return;
      lastVersion = snapshot.version;
      const recent = snapshot.entries.slice(-20);
      for (let index = recent.length - 1; index >= 0; index -= 1) {
        const event = recent[index]?.event;
        if (!event) continue;
        // 热重载：entry/src 可能已变化（由父级重挂载），未变时让页面刷新数据。
        if (event.type === 'plugin.changed') {
          postToFrame({ type: REFRESH_MESSAGE });
          break;
        }
        if (event.type !== 'plugin.ready') continue;
        const data = event.data;
        const owner = data.plugin_id ?? data.pluginId ?? data.id ?? data.name;
        if (typeof owner === 'string' && owner !== pluginId) continue;
        postToFrame({ type: REFRESH_MESSAGE });
        break;
      }
    });
  }, [eventStore, pluginId, postToFrame, src]);

  const retry = useCallback(() => {
    setFailed(null);
    setLoaded(false);
    setReloadKey((value) => value + 1);
  }, []);

  if (src === null) {
    return <ErrorState message={t('plugins.frame.invalidEntry')} />;
  }

  return (
    <div className={cn('relative min-h-0', className ?? 'h-[360px]')}>
      {!loaded && failed === null && <LoadingState label={t('plugins.frame.loading')} rows={3} />}
      {failed !== null && <ErrorState message={failed} onRetry={retry} />}
      <iframe
        key={reloadKey}
        ref={iframeRef}
        title={title}
        src={src}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className={cn(
          'h-full w-full border-0 bg-surface',
          (!loaded || failed !== null) && 'hidden',
        )}
        onLoad={() => {
          setLoaded(true);
          setFailed(null);
        }}
        onError={() => setFailed(t('plugins.frame.loadError'))}
      />
    </div>
  );
}
