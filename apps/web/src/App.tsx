import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ConnectionState, GatewayClient } from './gatewayClient';
import type {
  AskUserAnswer,
  AskUserQuestion,
  AskUserRequest,
  HelloInfo,
  RunEvent,
  SessionInfo,
  StreamChunk,
  ToolInfo,
} from './types';

const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? '';

// ── 时间线模型：事件按 run_id 分组，并把 llm.stream.chunk 的 text_delta 拼成文本块 ──
type TimelineItem =
  | { kind: 'text'; text: string; key: string }
  | { kind: 'event'; event: RunEvent; key: string };

interface TimelineEntry {
  event: RunEvent;
  seq: number;
  jobId?: string;
}

interface RunGroup {
  runId: string;
  jobId?: string;
  sessionId?: string;
  input?: string;
  output?: string;
  error?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  iterations?: number;
  items: TimelineItem[];
}

interface PermissionRequest {
  requestId: string;
  tool: string;
  input: unknown;
  runId: string;
  expiresAt: number;
}

function buildGroup(runId: string, entries: TimelineEntry[]): RunGroup {
  const group: RunGroup = { runId, status: 'running', items: [] };
  let buf = '';
  let textIndex = 0;
  const flush = () => {
    if (buf) {
      group.items.push({ kind: 'text', text: buf, key: `text-${runId}-${textIndex++}` });
      buf = '';
    }
  };

  for (const entry of entries) {
    const ev = entry.event;
    if (entry.jobId) group.jobId = entry.jobId;
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
        group.items.push({ kind: 'event', event: ev, key: `ev-${entry.seq}` });
    }
  }
  flush();
  return group;
}

function groupEvents(entries: TimelineEntry[]): RunGroup[] {
  const byRun = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const runId = entry.event.run_id;
    const list = byRun.get(runId);
    if (list) list.push(entry);
    else byRun.set(runId, [entry]);
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

/** 行内时间戳（带毫秒，便于区分同一秒内的多条事件） */
function formatRowTime(ts: number): string {
  const d = new Date(ts);
  const base = d.toLocaleTimeString('zh-CN', { hour12: false });
  return `${base}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 读取 URL fragment / sessionStorage 里的 token（fragment 不发给服务端） */
function initialToken(): string {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fromHash = hash.get('token');
  if (fromHash) {
    sessionStorage.setItem('vessel.token', fromHash);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    return fromHash;
  }
  return sessionStorage.getItem('vessel.token') ?? '';
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'connecting':
      return '连接中…';
    case 'open':
      return 'online';
    case 'reconnecting':
      return '重连中…';
    case 'closed':
      return '已断开';
    case 'error':
      return '连接失败';
    default:
      return state;
  }
}

function prettyInput(input: unknown): string {
  try {
    return truncate(JSON.stringify(input, null, 2) ?? String(input), 2000);
  } catch {
    return String(input);
  }
}

// ── 事件类型标签（时间线色块）──
function eventTag(type: string): { label: string; cls: string } {
  if (type.startsWith('tool.call.')) {
    if (type.endsWith('.failed')) return { label: 'tool.fail', cls: 'tag-tool-fail' };
    if (type.endsWith('.completed')) return { label: 'tool.ok', cls: 'tag-tool-done' };
    return { label: 'tool', cls: 'tag-tool-start' };
  }
  if (type.startsWith('guardrail.')) return { label: type, cls: 'tag-guard' };
  if (type.startsWith('llm.')) return { label: type, cls: 'tag-llm' };
  if (type === 'error') return { label: 'error', cls: 'tag-error' };
  return { label: type, cls: 'tag-raw' };
}

// ── 单条事件渲染：时间戳 + 类型色块 + 内容 ──
function EventRow({ event }: { event: RunEvent }) {
  const tag = eventTag(event.type);
  return (
    <div className={`row ${tag.cls}`}>
      <span className="ts dim">{formatRowTime(event.ts)}</span>
      <span className={`type-tag ${tag.cls}`}>{tag.label}</span>
      {renderEventBody(event)}
    </div>
  );
}

function renderEventBody(event: RunEvent) {
  switch (event.type) {
    case 'tool.call.started': {
      const d = event.data as { tool_name?: string; arguments?: unknown };
      const args = d.arguments == null ? '' : JSON.stringify(d.arguments);
      return (
        <>
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          {args && <span className="dim">{truncate(args, 160)}</span>}
        </>
      );
    }
    case 'tool.call.completed': {
      const d = event.data as { tool_name?: string; duration_ms?: number };
      return (
        <>
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          {d.duration_ms != null && <span className="dim">{d.duration_ms}ms</span>}
        </>
      );
    }
    case 'tool.call.failed': {
      const d = event.data as { tool_name?: string; error?: string };
      return (
        <>
          <span className="mono">{d.tool_name ?? 'tool'}</span>
          <span className="err">{truncate(d.error ?? '', 160)}</span>
        </>
      );
    }
    case 'guardrail.blocked': {
      const d = event.data as { guardrail_name?: string; reason?: string };
      return (
        <>
          <span className="mono">{d.guardrail_name ?? 'guardrail'}</span>
          <span className="dim">{truncate(d.reason ?? '', 160)}</span>
        </>
      );
    }
    case 'guardrail.modified': {
      const d = event.data as { guardrail_name?: string; stage?: string };
      return (
        <>
          <span className="mono">{d.guardrail_name ?? 'guardrail'}</span>
          <span className="dim">{d.stage ?? ''}</span>
        </>
      );
    }
    case 'llm.request': {
      const d = event.data as { messages?: unknown[]; tools?: unknown[] };
      return (
        <span className="dim">
          {d.messages?.length ?? 0} msgs{d.tools?.length ? ` · ${d.tools.length} tools` : ''}
        </span>
      );
    }
    case 'llm.response': {
      const d = event.data as { finish_reason?: string; usage?: { total_tokens?: number } };
      return (
        <span className="dim">
          {d.finish_reason ?? ''}
          {d.usage?.total_tokens != null ? ` · ${d.usage.total_tokens} tok` : ''}
        </span>
      );
    }
    case 'error': {
      const d = event.data as { error?: string };
      return <span className="err">{truncate(d.error ?? 'error', 240)}</span>;
    }
    default:
      return <span className="dim">{truncate(JSON.stringify(event.data), 200)}</span>;
  }
}

// ── 单次 run 卡片：顶部 run.started 边界，底部 run.completed/run.failed 边界 ──
function RunCard({
  group,
  cancelled,
  cancelling,
  onCancel,
}: {
  group: RunGroup;
  cancelled: boolean;
  cancelling: boolean;
  onCancel: (group: RunGroup) => void;
}) {
  const status = cancelled && group.status === 'failed' ? 'cancelled' : group.status;
  return (
    <div className={`run-card ${status}`}>
      <div className="run-header">
        <span className={`status-chip ${status}`}>{status}</span>
        <span className="mono run-id" title={group.runId}>
          {truncate(group.runId, 24)}
        </span>
        {group.startedAt != null && <span className="dim">{formatTime(group.startedAt)}</span>}
        {group.sessionId && <span className="dim">session {truncate(group.sessionId, 16)}</span>}
        {group.status === 'running' && group.jobId && (
          <button
            type="button"
            className="cancel-btn"
            onClick={() => onCancel(group)}
            disabled={cancelling}
          >
            {cancelling ? '取消中…' : '取消'}
          </button>
        )}
      </div>

      {group.input && <div className="run-input">{group.input}</div>}

      <div className="run-items">
        {group.items.map((it) =>
          it.kind === 'text' ? (
            <div className="text-block" key={it.key}>
              {it.text}
            </div>
          ) : (
            <EventRow key={it.key} event={it.event} />
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
      {group.status === 'failed' && status === 'failed' && (
        <div className="run-footer failed">✗ failed {truncate(group.error ?? '', 240)}</div>
      )}
      {status === 'cancelled' && <div className="run-footer cancelled">⏹ cancelled</div>}
    </div>
  );
}

// ── 权限确认弹窗 ──
function PermissionModal({
  request,
  pendingCount,
  now,
  onDecide,
}: {
  request: PermissionRequest;
  pendingCount: number;
  now: number;
  onDecide: (decision: 'allow' | 'deny', remember: boolean) => void;
}) {
  const remaining = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  return (
    <div className="modal-backdrop">
      <div className="permission-modal" role="dialog" aria-modal="true" aria-label="工具执行确认">
        <div className="permission-title">工具执行确认</div>
        <div className="permission-meta dim">
          run {truncate(request.runId, 16)} · 剩余 {remaining}s
          {pendingCount > 1 ? ` · 还有 ${pendingCount - 1} 个待处理` : ''}
        </div>
        <div className="permission-tool mono">{request.tool}</div>
        <pre className="permission-input">{prettyInput(request.input)}</pre>
        <div className="permission-actions">
          <button type="button" className="deny-btn" onClick={() => onDecide('deny', false)}>
            拒绝
          </button>
          <button type="button" className="ghost-btn" onClick={() => onDecide('allow', true)}>
            始终允许
          </button>
          <button type="button" className="send-btn" onClick={() => onDecide('allow', false)}>
            允许
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ask_user 弹窗 ──
function AskModal({
  request,
  pendingCount,
  now,
  onSubmit,
  onCancel,
}: {
  request: AskUserRequest;
  pendingCount: number;
  now: number;
  onSubmit: (answers: AskUserAnswer[]) => void;
  onCancel: () => void;
}) {
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ''));
  const [selected, setSelected] = useState<string[][]>(() => request.questions.map(() => []));
  const remaining = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  const toggle = (index: number, option: string, multi: boolean) => {
    setSelected((prev) => {
      const next = prev.map((item) => [...item]);
      if (!multi) {
        next[index] = [option];
        return next;
      }
      const set = new Set(next[index] ?? []);
      if (set.has(option)) set.delete(option);
      else set.add(option);
      next[index] = [...set];
      return next;
    });
  };

  const answers: AskUserAnswer[] = request.questions.map((question, index) => {
    const text = (custom[index] ?? '').trim();
    const picked = selected[index] ?? [];
    return {
      header: question.header,
      question: question.question,
      answer: text || picked.join(', '),
    };
  });
  const complete = answers.every((answer) => answer.answer.length > 0);

  return (
    <div className="modal-backdrop">
      <div className="permission-modal" role="dialog" aria-modal="true" aria-label="Agent 提问">
        <div className="permission-title">Agent 提问</div>
        <div className="permission-meta dim">
          run {truncate(request.runId, 16)} · 剩余 {remaining}s
          {pendingCount > 1 ? ` · 还有 ${pendingCount - 1} 个待处理` : ''}
        </div>
        <div className="ask-list">
          {request.questions.map((question, index) => (
            <div
              className="ask-question"
              key={`${request.requestId}-${question.header}-${question.question}`}
            >
              <div className="ask-header">{question.header}</div>
              <div className="ask-text">{question.question}</div>
              {question.options && question.options.length > 0 && (
                <div className="ask-options">
                  {question.options.map((option) => {
                    const picked = (selected[index] ?? []).includes(option);
                    return (
                      <label className={`ask-option ${picked ? 'picked' : ''}`} key={option}>
                        <input
                          type={question.multi_select ? 'checkbox' : 'radio'}
                          name={`ask-${request.requestId}-${index}`}
                          checked={picked}
                          onChange={() => toggle(index, option, question.multi_select === true)}
                        />
                        <span>{option}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <input
                className="ask-input"
                value={custom[index] ?? ''}
                onChange={(e) =>
                  setCustom((prev) => {
                    const next = [...prev];
                    next[index] = e.target.value;
                    return next;
                  })
                }
                placeholder={question.options ? '或输入自定义回答' : '输入回答'}
              />
            </div>
          ))}
        </div>
        <div className="permission-actions">
          <button type="button" className="deny-btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="send-btn"
            disabled={!complete}
            onClick={() => onSubmit(answers)}
          >
            提交
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 主应用 ──
export default function App() {
  const [token, setToken] = useState<string>(initialToken);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [connState, setConnState] = useState<ConnectionState>('idle');
  const [hello, setHello] = useState<HelloInfo | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [asks, setAsks] = useState<AskUserRequest[]>([]);
  const [gapNotice, setGapNotice] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [cancelledJobs, setCancelledJobs] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const client = useMemo(() => new GatewayClient(GATEWAY_URL), []);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastSeq = useRef(0);

  const setTokenAndPersist = (value: string) => {
    setToken(value);
    if (value) sessionStorage.setItem('vessel.token', value);
    else sessionStorage.removeItem('vessel.token');
  };

  const refreshNow = useCallback(() => {
    if (client.connectionState !== 'open') return;
    client
      .listSessions()
      .then(setSessions)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    client
      .listTools()
      .then(setTools)
      .catch(() => {
        // 工具列表失败不阻塞主流程
      });
  }, [client]);

  // WS 连接 + 事件订阅（token 变化时重连；断线指数退避，用 since 续订）
  useEffect(() => {
    const tk = token.trim();
    if (!tk) {
      setConnState('idle');
      setEntries([]);
      setHello(null);
      setTools([]);
      setPermissions([]);
      setAsks([]);
      return;
    }

    let disposed = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    lastSeq.current = 0;
    setEntries([]);
    setPermissions([]);
    setAsks([]);
    setTools([]);
    setGapNotice(null);
    setHello(null);

    const addPermission = (event: RunEvent) => {
      const d = event.data as { requestId?: unknown; tool?: unknown; input?: unknown };
      if (typeof d.requestId !== 'string') return;
      const requestId = d.requestId;
      setPermissions((prev) =>
        prev.some((item) => item.requestId === requestId)
          ? prev
          : [
              ...prev,
              {
                requestId,
                tool: typeof d.tool === 'string' ? d.tool : 'tool',
                input: d.input,
                runId: event.run_id,
                expiresAt: Date.now() + 120_000,
              },
            ],
      );
    };

    const addAsk = (event: RunEvent) => {
      const d = event.data as { requestId?: unknown; questions?: unknown };
      if (typeof d.requestId !== 'string' || !Array.isArray(d.questions)) return;
      const requestId = d.requestId;
      const questions = d.questions.filter(
        (item): item is AskUserQuestion =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as AskUserQuestion).question === 'string',
      );
      if (questions.length === 0) return;
      setAsks((prev) =>
        prev.some((item) => item.requestId === requestId)
          ? prev
          : [
              ...prev,
              { requestId, questions, runId: event.run_id, expiresAt: Date.now() + 120_000 },
            ],
      );
    };

    const offEvent = client.onEvent((event, meta) => {
      if (meta.seq <= lastSeq.current) return;
      lastSeq.current = meta.seq;
      setEntries((prev) => [
        ...prev,
        {
          event,
          seq: meta.seq,
          ...(meta.jobId ? { jobId: meta.jobId } : {}),
        },
      ]);
      if (event.type === 'tool.permission.request') addPermission(event);
      if (event.type === 'ask.user.requested') addAsk(event);
      if (event.type === 'run.completed' || event.type === 'run.failed') {
        setPermissions((prev) => prev.filter((item) => item.runId !== event.run_id));
        setAsks((prev) => prev.filter((item) => item.runId !== event.run_id));
      }
    });

    const offHello = client.onHello((info) => {
      attempt = 0;
      setHello(info);
      setError(null);
      setGapNotice(null);
      client
        .listSessions()
        .then(setSessions)
        .catch(() => {
          // 会话列表由定时刷新兜底
        });
      client
        .listTools()
        .then(setTools)
        .catch(() => {
          // 工具列表失败不阻塞主流程
        });
    });

    const offGap = client.onGap((gap) => {
      // 历史被截断：清空时间线，从保留区重新累积（服务端随后会回放 > to_seq 的事件）。
      setEntries([]);
      lastSeq.current = gap.to_seq;
      setGapNotice(`历史事件已截断（${gap.from_seq}–${gap.to_seq}），已重新同步`);
    });

    const offState = client.onState((state) => {
      if (!disposed) setConnState(state);
    });

    const offClose = client.onClose((code) => {
      if (disposed) return;
      if (code === 4400 || code === 4401) {
        setError(
          code === 4400
            ? '协议版本不兼容（需要 vessel.gateway/1）'
            : '鉴权失败：token 错误或已失效',
        );
        return;
      }
      // 自动重连（1s 起，指数退避，上限 30s，带 jitter）
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      attempt += 1;
      setConnState('reconnecting');
      retryTimer = window.setTimeout(() => {
        if (disposed) return;
        void client.connect(tk, lastSeq.current).catch((e: unknown) => {
          if (!disposed) setError(e instanceof Error ? e.message : String(e));
        });
      }, delay);
    });

    void client.connect(tk, 0).catch((e: unknown) => {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      disposed = true;
      offEvent();
      offHello();
      offGap();
      offState();
      offClose();
      window.clearTimeout(retryTimer);
      client.close();
    };
  }, [token, client]);

  // 会话列表定期刷新（仅连接可用时）
  useEffect(() => {
    if (!token.trim()) {
      setSessions([]);
      return;
    }
    const id = window.setInterval(() => {
      if (client.connectionState === 'open') {
        client
          .listSessions()
          .then(setSessions)
          .catch(() => {
            // 静默失败
          });
      }
    }, 8000);
    return () => window.clearInterval(id);
  }, [token, client]);

  // 交互请求倒计时
  useEffect(() => {
    if (permissions.length === 0 && asks.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [permissions.length, asks.length]);

  useEffect(() => {
    if (permissions.length === 0 && asks.length === 0) return;
    setPermissions((prev) => prev.filter((item) => item.expiresAt > now));
    setAsks((prev) => prev.filter((item) => item.expiresAt > now));
  }, [now, permissions.length, asks.length]);

  // 新事件自动滚动到底部
  useEffect(() => {
    if (entries.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length]);

  const handleSend = async () => {
    const tk = token.trim();
    const text = input.trim();
    if (!tk || !text || submitting) return;
    setSubmitting(true);
    setError(null);
    setLastOutput(null);
    try {
      const result = await client.submitRun(text, selectedId ?? undefined);
      setInput('');
      if (result.status === 'queued') setLastOutput('已排队');
      if (client.connectionState === 'open') {
        client
          .listSessions()
          .then(setSessions)
          .catch(() => {});
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (group: RunGroup) => {
    if (!group.jobId) return;
    const jobId = group.jobId;
    setCancelling((prev) => new Set(prev).add(jobId));
    try {
      const result = await client.cancelRun(jobId);
      if (result.cancelled) {
        setCancelledJobs((prev) => new Set(prev).add(jobId));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const decidePermission = async (decision: 'allow' | 'deny', remember: boolean) => {
    const current = permissions[0];
    if (!current) return;
    try {
      await client.respondPermission(current.requestId, decision, remember);
      setPermissions((prev) => prev.filter((item) => item.requestId !== current.requestId));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const answerAsk = async (answers: AskUserAnswer[]) => {
    const current = asks[0];
    if (!current) return;
    try {
      await client.respondAsk(current.requestId, answers);
      setAsks((prev) => prev.filter((item) => item.requestId !== current.requestId));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const groups = useMemo(() => groupEvents(entries), [entries]);
  const visibleGroups = useMemo(() => {
    if (!selectedId) return groups;
    return groups.filter((group) => group.sessionId === selectedId);
  }, [groups, selectedId]);

  const pendingPermission = permissions[0];
  const pendingAsk = asks[0];
  const nodeLabel = hello?.node.name ?? hello?.node.node_id?.slice(0, 12) ?? '';

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Vessel</span>
        <span className={`conn conn-${connState}`} title="gateway 连接状态">
          <span className="conn-dot" />
          {connectionLabel(connState)}
        </span>
        {hello && (
          <span className="protocol-badge mono" title={`node ${nodeLabel}`}>
            v{hello.protocol.version}
          </span>
        )}
        <input
          className="token-input"
          type="password"
          value={token}
          onChange={(e) => setTokenAndPersist(e.target.value)}
          placeholder="gateway token（或打开 #token=…）"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="gateway-url dim">{GATEWAY_URL || window.location.origin}</span>
        <button
          type="button"
          className="ghost-btn"
          onClick={refreshNow}
          disabled={!token.trim() || connState !== 'open'}
        >
          刷新
        </button>
      </header>

      {error && (
        <button type="button" className="error-banner" onClick={() => setError(null)}>
          {error} <span className="dim">(点击关闭)</span>
        </button>
      )}

      {gapNotice && (
        <button type="button" className="gap-banner" onClick={() => setGapNotice(null)}>
          {gapNotice} <span className="dim">(点击关闭)</span>
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

          <div className="sidebar-title">
            工具 <span className="dim">({tools.length})</span>
          </div>
          <div className="tools">
            {tools.length === 0 ? (
              <div className="tools-empty dim">
                {connState === 'open' ? 'gateway 未提供工具' : '连接后显示工具'}
              </div>
            ) : (
              tools.map((tool) => (
                <div className="tool-item" key={tool.name} title={tool.description || tool.name}>
                  <div className="tool-name">
                    <span className="tool-dot" />
                    <span className="mono">{tool.name}</span>
                    {tool.has_permission_check && (
                      <span className="tool-lock" title="需要确认">
                        ·
                      </span>
                    )}
                  </div>
                  {tool.description && (
                    <div className="tool-desc">{truncate(tool.description, 90)}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </aside>

        <main className="timeline">
          {visibleGroups.length === 0 && (
            <div className="empty">
              {entries.length === 0 ? '等待事件…（连接 gateway 后自动回放历史）' : '当前筛选无事件'}
            </div>
          )}
          {visibleGroups.map((group) => (
            <RunCard
              key={group.runId}
              group={group}
              cancelled={group.jobId ? cancelledJobs.has(group.jobId) : false}
              cancelling={group.jobId ? cancelling.has(group.jobId) : false}
              onCancel={handleCancel}
            />
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
          disabled={!token.trim() || submitting || connState !== 'open'}
        />
        <button
          type="button"
          className="send-btn"
          onClick={() => void handleSend()}
          disabled={!token.trim() || submitting || !input.trim() || connState !== 'open'}
        >
          {submitting ? '提交中…' : '发送'}
        </button>
        {lastOutput != null && (
          <span className="dim last-output">✓ {truncate(lastOutput, 60)}</span>
        )}
      </footer>

      {pendingAsk ? (
        <AskModal
          key={pendingAsk.requestId}
          request={pendingAsk}
          pendingCount={asks.length}
          now={now}
          onSubmit={(answers) => void answerAsk(answers)}
          onCancel={() => void answerAsk([])}
        />
      ) : pendingPermission ? (
        <PermissionModal
          request={pendingPermission}
          pendingCount={permissions.length}
          now={now}
          onDecide={(decision, remember) => void decidePermission(decision, remember)}
        />
      ) : null}
    </div>
  );
}
