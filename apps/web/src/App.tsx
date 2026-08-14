import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ConnectionState, GatewayClient } from './gatewayClient';
import type { RunEvent, SessionInfo, StreamChunk } from './types';

const GATEWAY_URL =
  (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:8642';

// ── 时间线模型：RunEvent 按 run_id 分组，并把 llm.stream.chunk 的 text_delta 拼成文本块 ──
type TimelineItem = { kind: 'text'; text: string } | { kind: 'event'; event: RunEvent };

interface RunGroup {
  runId: string;
  sessionId?: string;
  input?: string;
  output?: string;
  error?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  iterations?: number;
  items: TimelineItem[];
}

function buildGroup(runId: string, events: RunEvent[]): RunGroup {
  const group: RunGroup = { runId, status: 'running', items: [] };
  let buf = '';
  const flush = () => {
    if (buf) {
      group.items.push({ kind: 'text', text: buf });
      buf = '';
    }
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'run.started': {
        const d = ev.data as { input?: string; session_id?: string };
        group.input = d.input;
        group.sessionId = d.session_id;
        group.startedAt = ev.ts;
        continue;
      }
      case 'run.completed': {
        flush();
        const d = ev.data as { output?: string; duration_ms?: number; iterations?: number };
        group.output = d.output;
        group.durationMs = d.duration_ms;
        group.iterations = d.iterations;
        group.status = 'completed';
        group.completedAt = ev.ts;
        continue;
      }
      case 'run.failed': {
        flush();
        const d = ev.data as { error?: string; duration_ms?: number };
        group.error = d.error;
        group.durationMs = d.duration_ms;
        group.status = 'failed';
        group.completedAt = ev.ts;
        continue;
      }
      case 'llm.stream.chunk': {
        const chunk = (ev.data as { chunk?: StreamChunk }).chunk;
        if (chunk?.type === 'text_delta' && chunk.delta) buf += chunk.delta;
        else if (chunk?.type === 'finish') flush();
        continue;
      }
      default:
        flush();
        group.items.push({ kind: 'event', event: ev });
    }
  }
  flush();
  return group;
}

function groupEvents(events: RunEvent[]): RunGroup[] {
  const byRun = new Map<string, RunEvent[]>();
  for (const ev of events) {
    const list = byRun.get(ev.run_id);
    if (list) list.push(ev);
    else byRun.set(ev.run_id, [ev]);
  }
  return [...byRun.entries()].map(([runId, list]) => buildGroup(runId, list));
}

// ── 工具函数 ──
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatTime(ts?: number): string {
  if (ts == null) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

// ── 单条事件渲染 ──
function EventRow({ event }: { event: RunEvent }) {
  switch (event.type) {
    case 'tool.call.started': {
      const d = event.data as { tool_name?: string; arguments?: unknown };
      const args = d.arguments == null ? '' : JSON.stringify(d.arguments);
      return (
        <div className="row tool-started">
          <span className="kind">🔧</span>
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          {args && <span className="dim">{truncate(args, 160)}</span>}
        </div>
      );
    }
    case 'tool.call.completed': {
      const d = event.data as { tool_name?: string; duration_ms?: number };
      return (
        <div className="row tool-completed">
          <span className="kind">✓</span>
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          {d.duration_ms != null && <span className="dim">{d.duration_ms}ms</span>}
        </div>
      );
    }
    case 'tool.call.failed': {
      const d = event.data as { tool_name?: string; error?: string };
      return (
        <div className="row tool-failed">
          <span className="kind">✗</span>
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          <span className="err">{truncate(d.error ?? '', 160)}</span>
        </div>
      );
    }
    case 'guardrail.blocked': {
      const d = event.data as { guardrail_name?: string; reason?: string };
      return (
        <div className="row guardrail">
          <span className="kind">🚫</span>
          <span className="mono">{d.guardrail_name ?? 'guardrail'}</span>
          <span className="dim">{truncate(d.reason ?? '', 160)}</span>
        </div>
      );
    }
    case 'guardrail.modified': {
      const d = event.data as { guardrail_name?: string; stage?: string };
      return (
        <div className="row guardrail">
          <span className="kind">✎</span>
          <span className="mono">{d.guardrail_name ?? 'guardrail'}</span>
          <span className="dim">{d.stage ?? ''}</span>
        </div>
      );
    }
    case 'llm.request': {
      const d = event.data as { messages?: unknown[]; tools?: unknown[] };
      return (
        <div className="row llm">
          <span className="kind">↗</span>
          <span>llm.request</span>
          <span className="dim">
            {d.messages?.length ?? 0} msgs{d.tools?.length ? ` · ${d.tools.length} tools` : ''}
          </span>
        </div>
      );
    }
    case 'llm.response': {
      const d = event.data as { finish_reason?: string; usage?: { total_tokens?: number } };
      return (
        <div className="row llm">
          <span className="kind">↙</span>
          <span>llm.response</span>
          <span className="dim">
            {d.finish_reason ?? ''}
            {d.usage?.total_tokens != null ? ` · ${d.usage.total_tokens} tok` : ''}
          </span>
        </div>
      );
    }
    case 'error': {
      const d = event.data as { error?: string };
      return (
        <div className="row raw-error">
          <span className="kind">⚠</span>
          <span className="err">{truncate(d.error ?? 'error', 240)}</span>
        </div>
      );
    }
    default:
      return (
        <div className="row raw">
          <span className="kind">•</span>
          <span className="mono">{event.type}</span>
          <span className="dim">{truncate(JSON.stringify(event.data), 200)}</span>
        </div>
      );
  }
}

// ── 单次 run 卡片：顶部 run.started 边界，底部 run.completed/run.failed 边界 ──
function RunCard({ group }: { group: RunGroup }) {
  return (
    <div className={`run-card ${group.status}`}>
      <div className="run-header">
        <span className={`status-chip ${group.status}`}>{group.status}</span>
        <span className="mono run-id" title={group.runId}>
          {truncate(group.runId, 24)}
        </span>
        {group.startedAt != null && <span className="dim">{formatTime(group.startedAt)}</span>}
        {group.sessionId && <span className="dim">session {truncate(group.sessionId, 16)}</span>}
      </div>

      {group.input && <div className="run-input">{group.input}</div>}

      <div className="run-items">
        {group.items.map((it) =>
          it.kind === 'text' ? (
            <div className="text-block" key={`text-${it.text}`}>
              {it.text}
            </div>
          ) : (
            <EventRow
              key={`ev-${it.event.ts}-${it.event.type}-${it.event.run_id}`}
              event={it.event}
            />
          ),
        )}
      </div>

      {group.status === 'completed' && (
        <div className="run-footer completed">
          <div className="foot-meta">
            ✓ completed
            {group.durationMs != null && <span className="dim">{group.durationMs}ms</span>}
            {group.iterations != null && <span className="dim">{group.iterations} iters</span>}
            {group.completedAt != null && (
              <span className="dim">{formatTime(group.completedAt)}</span>
            )}
          </div>
          {group.output && <pre className="run-output">{group.output}</pre>}
        </div>
      )}
      {group.status === 'failed' && (
        <div className="run-footer failed">✗ failed {truncate(group.error ?? '', 240)}</div>
      )}
    </div>
  );
}

// ── 主应用 ──
export default function App() {
  const [token, setToken] = useState<string>(() => {
    const url = new URLSearchParams(window.location.search).get('token');
    return url ?? localStorage.getItem('vessel.token') ?? '';
  });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connState, setConnState] = useState<ConnectionState>('idle');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);

  const client = useMemo(() => new GatewayClient(GATEWAY_URL), []);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const setTokenAndPersist = (v: string) => {
    setToken(v);
    if (v) localStorage.setItem('vessel.token', v);
    else localStorage.removeItem('vessel.token');
  };

  const refreshSessions = useCallback(
    (silent = false) => {
      const tk = token.trim();
      if (!tk) return;
      client
        .fetchSessions(tk)
        .then(setSessions)
        .catch((e: unknown) => {
          if (!silent) setError(e instanceof Error ? e.message : String(e));
        });
    },
    [token, client],
  );

  // WS 连接 + 事件订阅（token 变化时重连；断线后 1.5s 自动重连并重新回放历史）
  useEffect(() => {
    const tk = token.trim();
    if (!tk) {
      setConnState('idle');
      setEvents([]);
      return;
    }

    setEvents([]);
    let reconnectTimer: number | undefined;
    const offEvent = client.onEvent((ev) => setEvents((prev) => [...prev, ev]));
    const offState = client.onState((s) => {
      setConnState(s);
      if (s === 'closed' || s === 'error') {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
          setEvents([]);
          client
            .connect(tk)
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        }, 1500);
      }
    });
    client.connect(tk).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

    return () => {
      offEvent();
      offState();
      window.clearTimeout(reconnectTimer);
      client.close();
    };
  }, [token, client]);

  // 会话列表：首次拉取 + 每 8s 静默刷新
  useEffect(() => {
    if (!token.trim()) {
      setSessions([]);
      return;
    }
    refreshSessions(false);
    const id = window.setInterval(() => refreshSessions(true), 8000);
    return () => window.clearInterval(id);
  }, [token, refreshSessions]);

  // 新事件自动滚动到底部
  useEffect(() => {
    if (events.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length]);

  const handleSend = async () => {
    const tk = token.trim();
    const text = input.trim();
    if (!tk || !text || sending) return;
    setSending(true);
    setError(null);
    setLastOutput(null);
    try {
      const output = await client.run(tk, text, selectedId ?? undefined);
      setLastOutput(output);
      setInput('');
      refreshSessions(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const groups = useMemo(() => groupEvents(events), [events]);
  const visibleGroups = useMemo(() => {
    if (!selectedId) return groups;
    return groups.filter((g) => g.sessionId === selectedId);
  }, [groups, selectedId]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Vessel</span>
        <span className={`conn conn-${connState}`} title="gateway 连接状态">
          <span className="conn-dot" />
          {connState}
        </span>
        <input
          className="token-input"
          type="password"
          value={token}
          onChange={(e) => setTokenAndPersist(e.target.value)}
          placeholder="gateway token（或 ?token=）"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="gateway-url dim">{GATEWAY_URL}</span>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => refreshSessions(false)}
          disabled={!token.trim()}
        >
          刷新
        </button>
      </header>

      {error && (
        <button type="button" className="error-banner" onClick={() => setError(null)}>
          {error} <span className="dim">(点击关闭)</span>
        </button>
      )}

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-title">
            会话 <span className="dim">({sessions.length})</span>
          </div>
          <div className="sessions">
            <button
              type="button"
              className={`session-item ${selectedId === null ? 'active' : ''}`}
              onClick={() => setSelectedId(null)}
            >
              <div className="session-title">全部 runs</div>
              <div className="session-preview dim">不筛选会话</div>
            </button>
            {sessions.map((s) => (
              <button
                key={s.session_id}
                type="button"
                className={`session-item ${s.session_id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(s.session_id)}
              >
                <div className="session-title">{s.title || s.preview || s.session_id}</div>
                <div className="session-preview">{s.preview || s.session_id}</div>
                <div className="session-meta">
                  <span className={`chip ${s.status}`}>{s.status}</span>
                  <span>{s.message_count} msgs</span>
                  <span className="dim">{formatTime(s.updated_at)}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="timeline">
          {visibleGroups.length === 0 && (
            <div className="empty">
              {events.length === 0 ? '等待事件…（连接 gateway 后自动回放历史）' : '当前筛选无事件'}
            </div>
          )}
          {visibleGroups.map((g) => (
            <RunCard key={g.runId} group={g} />
          ))}
          <div ref={bottomRef} />
        </main>
      </div>

      <footer className="control">
        <span className="control-session" title={selectedId ?? undefined}>
          {selectedId ? `→ ${truncate(selectedId, 20)}` : '新会话'}
        </span>
        <input
          className="control-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={token.trim() ? '输入 prompt，回车发送' : '请先填入 token'}
          disabled={!token.trim() || sending}
        />
        <button
          type="button"
          className="send-btn"
          onClick={() => void handleSend()}
          disabled={!token.trim() || sending || !input.trim()}
        >
          {sending ? '运行中…' : '发送'}
        </button>
        {lastOutput != null && (
          <span className="dim last-output">✓ {truncate(lastOutput, 60)}</span>
        )}
      </footer>
    </div>
  );
}
