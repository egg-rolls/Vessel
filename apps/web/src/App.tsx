import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ConnectionState, GatewayClient } from './gatewayClient';
import type {
  AskUserAnswer,
  AskUserQuestion,
  AskUserRequest,
  CapabilityManifest,
  ConfigSourcesResponse,
  DurableRunSummary,
  FeishuStatus,
  HelloInfo,
  McpServerStatus,
  Message,
  MetricsSnapshot,
  RunEvent,
  SessionDetail,
  SessionInfo,
  StreamChunk,
  ToolInfo,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from './types';

const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? '';

/** 默认隐藏的内部事件：状态同步/提示词上下文，不是用户关心的对话内容。 */
const INTERNAL_EVENT_TYPES = new Set([
  'context.changed',
  'session.saved',
  'llm.request',
  'llm.response',
]);

/** 会话排序：updated_at 倒序，同值 session_id 升序（与 TUI 一致）。 */
function sortSessions(list: SessionInfo[]): SessionInfo[] {
  return [...list].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
    if (a.session_id === b.session_id) return 0;
    return a.session_id < b.session_id ? -1 : 1;
  });
}

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
  /** 首个事件时间（没有 run.started 时用于排序） */
  firstTs?: number;
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
    if (group.firstTs === undefined) group.firstTs = ev.ts;
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
      case 'run.cancelled': {
        flush();
        const d = ev.data as { duration_ms?: number };
        group.durationMs = d.duration_ms;
        group.status = 'cancelled';
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

function groupEvents(entries: TimelineEntry[], showInternal: boolean): RunGroup[] {
  const byRun = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    if (!showInternal && INTERNAL_EVENT_TYPES.has(entry.event.type)) continue;
    const runId = entry.event.run_id;
    const list = byRun.get(runId);
    if (list) list.push(entry);
    else byRun.set(runId, [entry]);
  }
  return [...byRun.entries()]
    .map(([runId, list]) => buildGroup(runId, list))
    .sort((a, b) => (a.startedAt ?? a.firstTs ?? 0) - (b.startedAt ?? b.firstTs ?? 0));
}

// ── 工具函数 ──
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatTime(ts?: number): string {
  if (ts == null) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      <span className="event-body">{renderEventBody(event)}</span>
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
  hideInput = false,
  onCancel,
}: {
  group: RunGroup;
  cancelled: boolean;
  cancelling: boolean;
  /** 历史消息里已经有同一条用户输入时，不再重复显示 run.input */
  hideInput?: boolean;
  onCancel: (group: RunGroup) => void;
}) {
  const status =
    group.status === 'cancelled' || (cancelled && group.status === 'failed')
      ? 'cancelled'
      : group.status;
  // 流式文本已经渲染在 items 里时，不再重复显示 run.completed.output。
  const inlineText = group.items
    .filter((item): item is { kind: 'text'; text: string; key: string } => item.kind === 'text')
    .map((item) => item.text)
    .join('')
    .trim();
  const outputAlreadyShown = group.output !== undefined && inlineText.includes(group.output.trim());
  return (
    <div className={`run-card ${status}`}>
      <div className="run-header">
        <span className={`status-chip ${status}`}>{status}</span>
        <span className="mono run-id" title={group.runId}>
          {truncate(group.runId, 24)}
        </span>
        {group.startedAt != null && <span className="dim">{formatTime(group.startedAt)}</span>}
        {group.sessionId && <span className="dim">session {truncate(group.sessionId, 16)}</span>}
        {group.status === 'running' && group.jobId && !cancelled && (
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

      {group.input && !hideInput && <div className="run-input">{group.input}</div>}

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
          {group.output && !outputAlreadyShown && <pre className="run-output">{group.output}</pre>}
        </div>
      )}
      {group.status === 'failed' && status === 'failed' && (
        <div className="run-footer failed">✗ failed {truncate(group.error ?? '', 240)}</div>
      )}
      {status === 'cancelled' && <div className="run-footer cancelled">⏹ cancelled</div>}
    </div>
  );
}

// ── 历史消息（sessions.get hydrate 后的消息视图）──
function TranscriptMessage({ message }: { message: Message }) {
  if (message.role === 'system') return null;

  if (message.role === 'tool') {
    const label = message.name || message.tool_call_id || 'tool';
    return (
      <div className="msg msg-tool">
        <span className="msg-role mono">{label}</span>
        <pre className="msg-tool-result">{message.content}</pre>
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-bubble">{message.content}</div>
      </div>
    );
  }

  const calls = message.tool_calls ?? [];
  return (
    <div className="msg msg-assistant">
      <div className="msg-role">助手</div>
      {message.content && <div className="msg-text">{message.content}</div>}
      {calls.map((call) => (
        <div className="msg-toolcall" key={call.id}>
          <span className="mono">{call.function.name}</span>
          <span className="dim">{truncate(call.function.arguments || '', 120)}</span>
        </div>
      ))}
    </div>
  );
}

function Transcript({ messages }: { messages: Message[] }) {
  const visible = messages.filter((message) => message.role !== 'system');
  if (visible.length === 0) return null;
  return (
    <div className="transcript">
      {visible.map((message, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 历史消息是不可变的只读列表
        <TranscriptMessage key={index} message={message} />
      ))}
    </div>
  );
}

/** 弹窗可访问性：初始焦点、Tab 焦点圈、Esc 关闭、关闭后恢复焦点。 */
function useModalA11y(onClose: () => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = containerRef.current;
    const focusables = () =>
      root
        ? [
            ...root.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ].filter((element) => element.offsetParent !== null || element === document.activeElement)
        : [];

    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, []);

  return containerRef;
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
  const dialogRef = useModalA11y(() => onDecide('deny', false));
  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="permission-modal"
        role="dialog"
        aria-modal="true"
        aria-label="工具执行确认"
        aria-describedby="permission-summary"
      >
        <div className="permission-title">工具执行确认</div>
        <div className="permission-meta dim" id="permission-summary">
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
  const dialogRef = useModalA11y(onCancel);

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
      <div
        ref={dialogRef}
        className="permission-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Agent 提问"
        aria-describedby={`ask-summary-${request.requestId}`}
      >
        <div className="permission-title">Agent 提问</div>
        <div className="permission-meta dim" id={`ask-summary-${request.requestId}`}>
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
  /** 新会话草稿 id：提交前就确定目标 session，避免服务端落到 activeSessionId。 */
  const [draftSessionId, setDraftSessionId] = useState<string | null>(null);
  /** 选中会话的持久化历史（sessions.get）。 */
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const [sessionListError, setSessionListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
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
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [durableRuns, setDurableRuns] = useState<DurableRunSummary[]>([]);
  const [resuming, setResuming] = useState<Set<string>>(new Set());
  const [resumed, setResumed] = useState<Set<string>>(new Set());
  const [workflows, setWorkflows] = useState<WorkflowRunSummary[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowRunDetail | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowInputs, setWorkflowInputs] = useState('');
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowNotice, setWorkflowNotice] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [feishu, setFeishu] = useState<FeishuStatus | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityManifest | null>(null);
  const [configSources, setConfigSources] = useState<ConfigSourcesResponse | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [panelErrors, setPanelErrors] = useState<{
    mcp?: string;
    durable?: string;
    workflow?: string;
    metrics?: string;
    feishu?: string;
    capabilities?: string;
  }>({});
  const [now, setNow] = useState(() => Date.now());
  /** 是否显示 context.changed / session.saved / llm.* 等内部事件 */
  const [showInternal, setShowInternal] = useState(false);
  const [sessionQuery, setSessionQuery] = useState('');
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const client = useMemo(() => new GatewayClient(GATEWAY_URL), []);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelineRef = useRef<HTMLElement | null>(null);
  const nearBottomRef = useRef(true);
  const hydrateGen = useRef(0);
  const lastSeq = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const setTokenAndPersist = (value: string) => {
    setToken(value);
    if (value) sessionStorage.setItem('vessel.token', value);
    else sessionStorage.removeItem('vessel.token');
  };

  const refreshSessions = useCallback(() => {
    if (client.connectionState !== 'open') return;
    client
      .listSessions()
      .then((list) => {
        setSessions(sortSessions(list));
        setSessionListError(null);
      })
      .catch((e: unknown) => setSessionListError(errorMessage(e)));
  }, [client]);

  /** 读取选中会话的持久化历史；silent=true 用于 run 结束后的后台刷新。 */
  const loadSessionDetail = useCallback(
    (sessionId: string, silent = false) => {
      // 代次保护：较慢的旧请求不能覆盖较新的 hydrate 结果
      const gen = ++hydrateGen.current;
      if (!silent) setHydrating(true);
      setHydrateError(null);
      client
        .getSession(sessionId)
        .then((detail) => {
          if (gen !== hydrateGen.current || selectedIdRef.current !== sessionId) return;
          setSessionDetail(detail);
        })
        .catch((e: unknown) => {
          if (gen !== hydrateGen.current || selectedIdRef.current !== sessionId) return;
          const message = errorMessage(e);
          const notFound =
            (e as { code?: string }).code === 'not_found' || message.startsWith('not_found:');
          if (notFound) {
            // 新会话尚未落盘：视为空历史，不是错误
            setSessionDetail({ session_id: sessionId, messages: [] });
            setHydrateError(null);
          } else {
            setHydrateError(message);
          }
        })
        .finally(() => {
          // 最新代次负责收尾：silent 刷新也可能抢占并接替非 silent 请求
          if (gen === hydrateGen.current && selectedIdRef.current === sessionId) {
            setHydrating(false);
          }
        });
    },
    [client],
  );

  /** 按 hello.features 拉取 durable / MCP 面板数据 */
  const loadPanels = useCallback(() => {
    if (client.connectionState !== 'open') return;
    const features = client.protocol?.protocol.features ?? [];

    if (features.includes('mcp-status')) {
      client
        .listMcpServers()
        .then((servers) => {
          setMcpServers(servers);
          setPanelErrors((prev) => ({ ...prev, mcp: undefined }));
        })
        .catch((e: unknown) => {
          setPanelErrors((prev) => ({ ...prev, mcp: errorMessage(e) }));
        });
    } else {
      setMcpServers([]);
    }

    if (features.includes('durable-resume')) {
      client
        .listDurableRuns({ status: 'interrupted', limit: 20 })
        .then((runs) => {
          setDurableRuns(runs);
          setPanelErrors((prev) => ({ ...prev, durable: undefined }));
        })
        .catch((e: unknown) => {
          setPanelErrors((prev) => ({ ...prev, durable: errorMessage(e) }));
        });
    } else {
      setDurableRuns([]);
    }

    if (features.includes('workflow')) {
      client
        .listWorkflows({ limit: 20 })
        .then((runs) => {
          setWorkflows(runs);
          setPanelErrors((prev) => ({ ...prev, workflow: undefined }));
        })
        .catch((e: unknown) => {
          setPanelErrors((prev) => ({ ...prev, workflow: errorMessage(e) }));
        });
    } else {
      setWorkflows([]);
      setSelectedWorkflow(null);
    }

    if (features.includes('metrics')) {
      client
        .getMetrics()
        .then((snapshot) => {
          setMetrics(snapshot);
          setPanelErrors((prev) => ({ ...prev, metrics: undefined }));
        })
        .catch((e: unknown) => {
          setPanelErrors((prev) => ({ ...prev, metrics: errorMessage(e) }));
        });
    } else {
      setMetrics(null);
    }

    if (features.includes('feishu')) {
      client
        .getFeishuStatus()
        .then((status) => {
          setFeishu(status);
          setPanelErrors((prev) => ({ ...prev, feishu: undefined }));
        })
        .catch((e: unknown) => {
          setPanelErrors((prev) => ({ ...prev, feishu: errorMessage(e) }));
        });
    } else {
      setFeishu(null);
    }

    // 0.5：能力清单总是可用（无需 feature 广告）
    client
      .getCapabilities()
      .then((manifest) => {
        setCapabilities(manifest);
        setPanelErrors((prev) => ({ ...prev, capabilities: undefined }));
      })
      .catch((e: unknown) => {
        setPanelErrors((prev) => ({ ...prev, capabilities: errorMessage(e) }));
      });
    client
      .getTenantId()
      .then((id) => setTenantId(id ?? null))
      .catch(() => setTenantId(null));

    if (features.includes('config')) {
      client
        .getConfigSources()
        .then(setConfigSources)
        .catch(() => setConfigSources(null));
    } else {
      setConfigSources(null);
    }
  }, [client]);

  const refreshNow = useCallback(() => {
    if (client.connectionState !== 'open') return;
    refreshSessions();
    client
      .listTools()
      .then(setTools)
      .catch(() => {
        // 工具列表失败不阻塞主流程
      });
    if (selectedIdRef.current) loadSessionDetail(selectedIdRef.current);
    loadPanels();
  }, [client, loadPanels, refreshSessions, loadSessionDetail]);

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
      setWorkflows([]);
      setSelectedWorkflow(null);
      setMetrics(null);
      setFeishu(null);
      setCapabilities(null);
      setConfigSources(null);
      setTenantId(null);
      setSessions([]);
      setSelectedId(null);
      setDraftSessionId(null);
      setSessionDetail(null);
      setSessionListError(null);
      setHydrateError(null);
      setHydrating(false);
      setLastOutput(null);
      return;
    }

    let disposed = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    lastSeq.current = 0;
    setEntries([]);
    setPermissions([]);
    setAsks([]);
    setSelectedId(null);
    setDraftSessionId(null);
    setSessionDetail(null);
    setSessionListError(null);
    setHydrateError(null);
    setHydrating(false);
    setLastOutput(null);
    setTools([]);
    setMcpServers([]);
    setDurableRuns([]);
    setWorkflows([]);
    setSelectedWorkflow(null);
    setMetrics(null);
    setFeishu(null);
    setCapabilities(null);
    setConfigSources(null);
    setTenantId(null);
    setWorkflowNotice(null);
    setPanelErrors({});
    setResuming(new Set());
    setResumed(new Set());
    setGapNotice(null);
    setHello(null);

    // workflow / 飞书事件到达后 500ms 防抖刷新面板，避免每个 step 事件都发请求。
    let panelTimer: number | undefined;
    const schedulePanels = () => {
      if (panelTimer !== undefined) return;
      panelTimer = window.setTimeout(() => {
        panelTimer = undefined;
        loadPanels();
      }, 500);
    };

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
      if (
        event.type === 'run.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.cancelled'
      ) {
        setPermissions((prev) => prev.filter((item) => item.runId !== event.run_id));
        setAsks((prev) => prev.filter((item) => item.runId !== event.run_id));
        refreshSessions();
        const current = selectedIdRef.current;
        if (current) {
          // 落盘后再 hydrate，避免历史与实时卡片重复
          const sessionId = (event.data as { session_id?: unknown }).session_id;
          if (typeof sessionId !== 'string' || sessionId === current) {
            window.setTimeout(() => loadSessionDetail(current, true), 120);
          }
        }
      }
      if (event.type === 'session.saved') {
        const sessionId = (event.data as { session_id?: unknown }).session_id;
        if (typeof sessionId === 'string' && selectedIdRef.current === sessionId) {
          loadSessionDetail(sessionId, true);
        }
      }
      if (event.type === 'run.resumed' || event.type === 'run.checkpoint') {
        window.setTimeout(loadPanels, 200);
      }
      if (event.type.startsWith('workflow.') || event.type.startsWith('channel.feishu.')) {
        schedulePanels();
      }
    });

    const offHello = client.onHello((info) => {
      attempt = 0;
      // gateway 重启后 seq 从 1 重新计数；旧 lastSeq 会永久丢弃新事件。
      // 注意：追平后 from_seq = latest_seq + 1 是正常值，不能用它判断回退。
      if (info.latest_seq < lastSeq.current) {
        const reset = lastSeq.current > 0;
        lastSeq.current = info.latest_seq;
        if (reset) {
          setEntries([]);
          setGapNotice('gateway 已重启，事件序号已重置，已重新同步');
        }
      }
      setHello(info);
      if (info.tenant_id) setTenantId(info.tenant_id);
      setError(null);
      loadPanels();
      refreshSessions();
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
      window.clearTimeout(panelTimer);
      client.close();
    };
  }, [token, client, loadPanels, loadSessionDetail, refreshSessions]);

  // 会话列表定期刷新（仅连接可用时）
  useEffect(() => {
    if (!token.trim()) {
      setSessions([]);
      return;
    }
    const id = window.setInterval(refreshSessions, 8000);
    return () => window.clearInterval(id);
  }, [token, refreshSessions]);

  // 选中会话时从服务端 hydrate 持久化历史
  useEffect(() => {
    if (!selectedId || connState !== 'open') return;
    loadSessionDetail(selectedId);
  }, [selectedId, connState, loadSessionDetail]);

  // durable / MCP 面板定期刷新（10s；未启用的 feature 会被 loadPanels 清空）
  useEffect(() => {
    if (!token.trim()) return;
    const id = window.setInterval(loadPanels, 10_000);
    return () => window.clearInterval(id);
  }, [token, loadPanels]);

  // 交互请求倒计时
  useEffect(() => {
    if (permissions.length === 0 && asks.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [permissions.length, asks.length]);

  useEffect(() => {
    const expiredPermission = permissions.some((item) => item.expiresAt <= now);
    const expiredAsk = asks.some((item) => item.expiresAt <= now);
    if (!expiredPermission && !expiredAsk) return;
    setNotice(
      expiredPermission
        ? '权限请求已超时，run 可能已失败；请检查时间线或重新发送。'
        : '提问请求已超时，run 可能已失败；请检查时间线或重新发送。',
    );
    setPermissions((prev) => prev.filter((item) => item.expiresAt > now));
    setAsks((prev) => prev.filter((item) => item.expiresAt > now));
  }, [now, permissions, asks]);

  // 输入框随内容增高（最多 160px）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 输入变化时重算高度
  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [input]);

  const handleTimelineScroll = useCallback(() => {
    const element = timelineRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const near = distance < 96;
    nearBottomRef.current = near;
    setNearBottom(near);
  }, []);

  const scrollToBottom = useCallback(() => {
    nearBottomRef.current = true;
    setNearBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  // 仅在接近底部时跟随新事件，避免用户上翻阅读时被拉回
  useEffect(() => {
    if (entries.length === 0) return;
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [entries.length]);

  // 切换会话 / 历史加载完成后直接展示最新内容
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionDetail 变化时跳到最新
  useEffect(() => {
    if (!selectedId) return;
    nearBottomRef.current = true;
    setNearBottom(true);
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [selectedId, sessionDetail?.session_id]);

  const handleSend = async () => {
    const tk = token.trim();
    const text = input.trim();
    if (!tk || !text || submitting) return;
    const targetSessionId = selectedId ?? draftSessionId ?? undefined;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    setLastOutput(null);
    try {
      const result = await client.submitRun(text, targetSessionId);
      setInput('');
      // 新会话草稿转为正式目标：后续事件与历史都落到同一个 session id
      if (targetSessionId && !selectedId) {
        setSelectedId(targetSessionId);
        setDraftSessionId(null);
        setSessionDetail({ session_id: targetSessionId, messages: [] });
        setHydrateError(null);
      }
      if (result.status === 'queued') setLastOutput('已排队');
      refreshSessions();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  /** 新会话：先在前端确定 session id，避免服务端回落到 activeSessionId。 */
  const startNewSession = () => {
    setSelectedId(null);
    setDraftSessionId(crypto.randomUUID());
    setSessionDetail(null);
    setHydrateError(null);
    setHydrating(false);
    setInput('');
  };

  /** 全部 runs：不筛选会话，也不指定提交目标。 */
  const showAllRuns = () => {
    setSelectedId(null);
    setDraftSessionId(null);
    setSessionDetail(null);
    setHydrateError(null);
    setHydrating(false);
  };

  const selectSession = (sessionId: string) => {
    setSelectedId(sessionId);
    setDraftSessionId(null);
    setSessionDetail(null);
    setHydrateError(null);
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

  const handleResume = async (runId: string) => {
    if (resuming.has(runId) || resumed.has(runId)) return;
    setResuming((prev) => new Set(prev).add(runId));
    try {
      await client.resumeDurableRun(runId);
      setResumed((prev) => new Set(prev).add(runId));
      loadPanels();
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === 'run_already_running') {
        setResumed((prev) => new Set(prev).add(runId));
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setResuming((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }
  };

  const handleWorkflowSelect = async (id: string) => {
    try {
      setSelectedWorkflow(await client.getWorkflow(id));
      setWorkflowNotice(null);
    } catch (e: unknown) {
      setWorkflowNotice(errorMessage(e));
    }
  };

  const handleWorkflowStart = async () => {
    const name = workflowName.trim();
    if (!name || workflowBusy) return;
    let inputs: Record<string, string> | undefined;
    if (workflowInputs.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(workflowInputs);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('inputs 必须是 JSON 对象');
        }
        const map: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value !== 'string') throw new Error('inputs 的值必须是字符串');
          map[key] = value;
        }
        inputs = map;
      } catch (e: unknown) {
        setWorkflowNotice(errorMessage(e));
        return;
      }
    }
    setWorkflowBusy(true);
    setWorkflowNotice(null);
    try {
      const started = await client.startWorkflow(name, inputs);
      setWorkflowNotice(`已排队：${started.workflow_run_id}`);
      setWorkflowName('');
      setWorkflowInputs('');
      loadPanels();
    } catch (e: unknown) {
      setWorkflowNotice(errorMessage(e));
    } finally {
      setWorkflowBusy(false);
    }
  };

  const handleWorkflowResume = async (id: string) => {
    if (workflowBusy) return;
    setWorkflowBusy(true);
    setWorkflowNotice(null);
    try {
      await client.resumeWorkflow(id);
      setWorkflowNotice(`已恢复：${id}`);
      loadPanels();
    } catch (e: unknown) {
      setWorkflowNotice(errorMessage(e));
    } finally {
      setWorkflowBusy(false);
    }
  };

  const handleWorkflowCancel = async (id: string) => {
    if (workflowBusy) return;
    setWorkflowBusy(true);
    setWorkflowNotice(null);
    try {
      await client.cancelWorkflow(id);
      setWorkflowNotice(`已取消：${id}`);
      setSelectedWorkflow(null);
      loadPanels();
    } catch (e: unknown) {
      setWorkflowNotice(errorMessage(e));
    } finally {
      setWorkflowBusy(false);
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

  const groups = useMemo(() => groupEvents(entries, showInternal), [entries, showInternal]);
  const visibleSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) =>
      [session.title, session.preview, session.session_id].some((value) =>
        (value ?? '').toLowerCase().includes(query),
      ),
    );
  }, [sessions, sessionQuery]);
  const visibleGroups = useMemo(() => {
    if (!selectedId) {
      // 新会话草稿还没有事件：保持空时间线，避免混入全部 runs。
      return draftSessionId ? [] : groups;
    }
    const detail = sessionDetail?.session_id === selectedId ? sessionDetail : null;
    return groups.filter((group) => {
      if (group.sessionId !== selectedId) return false;
      if (group.status !== 'completed' || !detail) return true;
      // 只有确认「用户输入 + 最终输出」都已落盘时才隐藏 live 卡片，
      // 避免 hydrate 失败或竞态时整个 run 从界面上消失。
      const messages = detail.messages;
      const input = group.input?.trim();
      const userSaved =
        !input || messages.some((m) => m.role === 'user' && m.content.trim() === input);
      if (!userSaved) return true;
      const output = group.output?.trim();
      // 没有可见输出（纯工具轮 / 旧事件）时无法确认已落盘，保留卡片更安全
      if (!output) return true;
      return !messages.some(
        (m) =>
          m.role === 'assistant' &&
          (m.content.trim() === output || (output.length >= 8 && m.content.includes(output))),
      );
    });
  }, [groups, selectedId, sessionDetail, draftSessionId]);

  const pendingPermission = permissions[0];
  const pendingAsk = asks[0];
  const modalOpen = Boolean(pendingAsk || pendingPermission);
  const transcriptMessages = sessionDetail?.messages ?? [];
  const hasTranscript = transcriptMessages.some((message) => message.role !== 'system');
  const selectedSession = selectedId
    ? sessions.find((session) => session.session_id === selectedId)
    : undefined;
  const featureList = hello?.protocol.features ?? [];
  const showMcp = featureList.includes('mcp-status');
  const showDurable = featureList.includes('durable-resume');
  const showWorkflow = featureList.includes('workflow');
  const showMetrics = featureList.includes('metrics');
  const showFeishu = featureList.includes('feishu');
  const showCapabilities = connState === 'open';
  const showConfig = featureList.includes('config');
  const nodeLabel = hello?.node.name ?? hello?.node.node_id?.slice(0, 12) ?? '';

  return (
    <div className="app">
      <header className="topbar" inert={modalOpen || undefined}>
        <span className="brand">Vessel</span>
        <span className="brand-sub">agent runtime</span>
        <span className={`conn conn-${connState}`} title="gateway 连接状态">
          <span className="conn-dot" />
          {connectionLabel(connState)}
        </span>
        {hello && (
          <span className="protocol-badge mono" title={`node ${nodeLabel}`}>
            v{hello.protocol.version}
          </span>
        )}
        {tenantId && (
          <span className="protocol-badge mono" title="当前 tenant">
            tenant {tenantId}
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
          className={`ghost-btn ${showInternal ? 'active' : ''}`}
          onClick={() => setShowInternal((value) => !value)}
          title="显示 context.changed / session.saved / llm.* 等内部事件"
          disabled={connState !== 'open'}
        >
          内部事件
        </button>
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
        <button
          type="button"
          className="error-banner"
          onClick={() => setError(null)}
          inert={modalOpen || undefined}
        >
          {error} <span className="dim">(点击关闭)</span>
        </button>
      )}

      {gapNotice && (
        <button
          type="button"
          className="gap-banner"
          onClick={() => setGapNotice(null)}
          inert={modalOpen || undefined}
        >
          {gapNotice} <span className="dim">(点击关闭)</span>
        </button>
      )}

      {notice && (
        <button
          type="button"
          className="notice-banner"
          onClick={() => setNotice(null)}
          inert={modalOpen || undefined}
        >
          {notice} <span className="dim">(点击关闭)</span>
        </button>
      )}

      <div className="body" inert={modalOpen || undefined}>
        <aside className="sidebar">
          <div className="sidebar-title">
            <span>
              会话{' '}
              <span className="count">
                {sessionQuery.trim()
                  ? `${visibleSessions.length}/${sessions.length}`
                  : sessions.length}
              </span>
            </span>
            <button
              type="button"
              className="section-toggle"
              onClick={() => setSessionsCollapsed((value) => !value)}
              aria-expanded={!sessionsCollapsed}
              aria-controls="session-list"
            >
              {sessionsCollapsed ? '展开' : '收起'}
            </button>
          </div>
          {!sessionsCollapsed && (
            <>
              <div className="session-actions">
                <button
                  type="button"
                  className={`action-btn primary ${draftSessionId ? 'active' : ''}`}
                  onClick={startNewSession}
                >
                  <span aria-hidden="true">＋</span> 新会话
                </button>
                <button
                  type="button"
                  className={`action-btn ${selectedId === null && draftSessionId === null ? 'active' : ''}`}
                  onClick={showAllRuns}
                >
                  全部 runs
                </button>
              </div>
              <div className="session-controls">
                <input
                  className="session-search"
                  value={sessionQuery}
                  onChange={(e) => setSessionQuery(e.target.value)}
                  placeholder="搜索会话"
                  spellCheck={false}
                />
              </div>
              <div className="sessions" id="session-list">
                {sessionListError && <div className="panel-empty err">{sessionListError}</div>}
                {!sessionListError && sessions.length === 0 && (
                  <div className="panel-empty dim">
                    {connState === 'open' ? '暂无会话' : '连接后显示会话'}
                  </div>
                )}
                {visibleSessions.map((s) => {
                  const title = s.title || s.preview || s.session_id;
                  const preview = s.preview && s.preview !== s.title ? s.preview : '';
                  return (
                    <button
                      key={s.session_id}
                      type="button"
                      className={`session-item ${s.session_id === selectedId ? 'active' : ''}`}
                      onClick={() => selectSession(s.session_id)}
                    >
                      <span className="session-title">{title}</span>
                      {preview && <span className="session-preview">{preview}</span>}
                      <span className="session-meta">
                        <span className={`chip ${s.status}`}>{s.status}</span>
                        <span>{s.message_count} 条</span>
                        <span className="dim">{formatTime(s.updated_at)}</span>
                      </span>
                    </button>
                  );
                })}
                {visibleSessions.length === 0 && sessions.length > 0 && (
                  <div className="panel-empty dim">无匹配会话</div>
                )}
              </div>
            </>
          )}

          <div className="sidebar-title">
            <span>
              工具 <span className="count">{tools.length}</span>
            </span>
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

          <button
            type="button"
            className={`advanced-toggle ${showAdvanced ? 'open' : ''}`}
            onClick={() => setShowAdvanced((value) => !value)}
            aria-expanded={showAdvanced}
          >
            <span>能力与运行态</span>
            <span className="advanced-mark" aria-hidden="true">
              {showAdvanced ? '−' : '+'}
            </span>
          </button>

          {showAdvanced && (
            <>
              {showCapabilities && (
                <>
                  <div className="sidebar-title">
                    Capabilities{' '}
                    <span className="dim">({capabilities?.methods.length ?? 0} methods)</span>
                  </div>
                  <div className="tools">
                    {panelErrors.capabilities ? (
                      <div className="panel-empty err">{panelErrors.capabilities}</div>
                    ) : !capabilities ? (
                      <div className="panel-empty dim">连接后显示能力清单</div>
                    ) : (
                      <>
                        <div className="tool-item">
                          <div className="tool-name">
                            <span className="mono">v{capabilities.version}</span>
                            <span className="dim">schema {capabilities.config_schema_version}</span>
                          </div>
                          <div className="tool-desc">
                            {capabilities.tools.length} tools · {capabilities.plugins.length}{' '}
                            plugins
                          </div>
                        </div>
                        {capabilities.plugins.slice(0, 6).map((plugin) => (
                          <div className="tool-item" key={plugin.name}>
                            <div className="tool-name">
                              <span className="mono">{plugin.name}</span>
                              <span className="dim">{plugin.enabled ? 'on' : 'off'}</span>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>

                  {showConfig && (
                    <>
                      <div className="sidebar-title">
                        Config sources{' '}
                        <span className="dim">
                          ({Object.keys(configSources?.sources ?? {}).length})
                        </span>
                      </div>
                      <div className="tools">
                        {!configSources ? (
                          <div className="panel-empty dim">连接后显示配置来源</div>
                        ) : Object.keys(configSources.sources).length === 0 ? (
                          <div className="panel-empty dim">无来源信息</div>
                        ) : (
                          Object.entries(configSources.sources)
                            .slice(0, 12)
                            .map(([key, source]) => (
                              <div className="tool-item" key={key} title={key}>
                                <div className="tool-name">
                                  <span className="mono">{truncate(key, 28)}</span>
                                  <span className="dim">{source}</span>
                                </div>
                              </div>
                            ))
                        )}
                      </div>
                    </>
                  )}
                </>
              )}

              {showMcp && (
                <>
                  <div className="sidebar-title">
                    MCP servers <span className="dim">({mcpServers.length})</span>
                  </div>
                  <div className="mcp-list">
                    {panelErrors.mcp ? (
                      <div className="panel-empty err">{panelErrors.mcp}</div>
                    ) : mcpServers.length === 0 ? (
                      <div className="panel-empty dim">无 MCP server</div>
                    ) : (
                      mcpServers.map((server) => (
                        <div
                          className="mcp-item"
                          key={server.name}
                          title={server.error ?? server.name}
                        >
                          <div className="mcp-head">
                            <span className={`mcp-status ${server.status}`}>{server.status}</span>
                            <span className="mono">{server.name}</span>
                            <span className="dim">{server.tools.length} tools</span>
                          </div>
                          {server.tools.length > 0 && (
                            <div className="mcp-tools dim">
                              {truncate(server.tools.join(', '), 100)}
                            </div>
                          )}
                          {server.error && (
                            <div className="mcp-error err">{truncate(server.error, 120)}</div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}

              {showDurable && (
                <>
                  <div className="sidebar-title">
                    Interrupted runs <span className="dim">({durableRuns.length})</span>
                  </div>
                  <div className="durable-list">
                    {panelErrors.durable ? (
                      <div className="panel-empty err">{panelErrors.durable}</div>
                    ) : durableRuns.length === 0 ? (
                      <div className="panel-empty dim">没有未完成的 run</div>
                    ) : (
                      durableRuns.map((run) => (
                        <div className="durable-item" key={run.run_id}>
                          <div className="durable-head">
                            <span className={`status-chip ${run.status}`}>{run.status}</span>
                            <span className="mono run-id" title={run.run_id}>
                              {truncate(run.run_id, 18)}
                            </span>
                            <span className="dim">{formatTime(run.updated_at)}</span>
                          </div>
                          <div className="durable-meta dim">
                            {run.agent_id ? `agent ${run.agent_id}` : ''}
                            {run.session_id
                              ? `${run.agent_id ? ' · ' : ''}session ${truncate(run.session_id, 12)}`
                              : ''}
                          </div>
                          {run.preview && (
                            <div className="durable-preview">{truncate(run.preview, 90)}</div>
                          )}
                          <button
                            type="button"
                            className="resume-btn"
                            disabled={resuming.has(run.run_id) || resumed.has(run.run_id)}
                            onClick={() => void handleResume(run.run_id)}
                          >
                            {resumed.has(run.run_id)
                              ? '已排队'
                              : resuming.has(run.run_id)
                                ? '恢复中…'
                                : '恢复'}
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}

              {showWorkflow && (
                <>
                  <div className="sidebar-title">
                    Workflows <span className="dim">({workflows.length})</span>
                  </div>
                  <div className="workflow-panel">
                    <div className="workflow-start">
                      <input
                        className="workflow-name"
                        value={workflowName}
                        onChange={(e) => setWorkflowName(e.target.value)}
                        placeholder="workflow name"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="resume-btn"
                        disabled={!workflowName.trim() || workflowBusy}
                        onClick={() => void handleWorkflowStart()}
                      >
                        {workflowBusy ? '处理中…' : '启动'}
                      </button>
                    </div>
                    <textarea
                      className="workflow-inputs"
                      value={workflowInputs}
                      onChange={(e) => setWorkflowInputs(e.target.value)}
                      placeholder='inputs JSON（可选，如 {"env":"prod"}）'
                      rows={2}
                      spellCheck={false}
                    />
                    {workflowNotice && <div className="panel-empty dim">{workflowNotice}</div>}
                    {panelErrors.workflow ? (
                      <div className="panel-empty err">{panelErrors.workflow}</div>
                    ) : workflows.length === 0 ? (
                      <div className="panel-empty dim">暂无 workflow run</div>
                    ) : (
                      workflows.map((run) => (
                        <div className="workflow-item" key={run.workflow_run_id}>
                          <button
                            type="button"
                            className="workflow-head"
                            onClick={() => void handleWorkflowSelect(run.workflow_run_id)}
                          >
                            <span className={`status-chip ${run.status}`}>{run.status}</span>
                            <span className="mono">{truncate(run.workflow_name, 18)}</span>
                            <span className="dim">
                              {run.completed_steps}/{run.step_count}
                            </span>
                          </button>
                          <div className="workflow-meta dim">
                            <span className="mono" title={run.workflow_run_id}>
                              {truncate(run.workflow_run_id, 14)}
                            </span>
                            <span>{formatTime(run.updated_at)}</span>
                          </div>
                          {run.error && (
                            <div className="workflow-error err">{truncate(run.error, 100)}</div>
                          )}
                          <div className="workflow-actions">
                            {(run.status === 'interrupted' ||
                              run.status === 'failed' ||
                              run.status === 'pending') && (
                              <button
                                type="button"
                                className="resume-btn"
                                disabled={workflowBusy}
                                onClick={() => void handleWorkflowResume(run.workflow_run_id)}
                              >
                                恢复
                              </button>
                            )}
                            {run.status !== 'completed' &&
                              run.status !== 'failed' &&
                              run.status !== 'cancelled' && (
                                <button
                                  type="button"
                                  className="resume-btn cancel"
                                  disabled={workflowBusy}
                                  onClick={() => void handleWorkflowCancel(run.workflow_run_id)}
                                >
                                  取消
                                </button>
                              )}
                          </div>
                          {selectedWorkflow?.workflow_run_id === run.workflow_run_id && (
                            <div className="workflow-detail">
                              {selectedWorkflow.steps.length === 0 ? (
                                <div className="panel-empty dim">无步骤信息</div>
                              ) : (
                                selectedWorkflow.steps.map((step) => (
                                  <div className="workflow-step" key={step.id}>
                                    <div className="workflow-step-head">
                                      <span className={`status-chip ${step.status}`}>
                                        {step.status}
                                      </span>
                                      <span className="mono">{step.id}</span>
                                      <span className="dim">
                                        {step.type} · {step.attempts} tries
                                      </span>
                                    </div>
                                    {step.output_preview && (
                                      <div className="workflow-step-output">
                                        {truncate(step.output_preview, 120)}
                                      </div>
                                    )}
                                    {step.error && (
                                      <div className="workflow-step-error err">
                                        {truncate(step.error, 100)}
                                      </div>
                                    )}
                                  </div>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}

              {showMetrics && (
                <>
                  <div className="sidebar-title">Metrics</div>
                  {panelErrors.metrics ? (
                    <div className="panel-empty err">{panelErrors.metrics}</div>
                  ) : !metrics ? (
                    <div className="panel-empty dim">暂无 metrics</div>
                  ) : (
                    <div className="metrics-panel">
                      <div className="metrics-row">
                        <span className="dim">runs</span>
                        <span className="mono">
                          {metrics.runs.started} start · {metrics.runs.completed} done ·{' '}
                          {metrics.runs.failed} fail
                        </span>
                      </div>
                      <div className="metrics-row">
                        <span className="dim">tools</span>
                        <span className="mono">
                          {metrics.tool_calls.total} calls · {metrics.tool_calls.failed} failed
                        </span>
                      </div>
                      <div className="metrics-row">
                        <span className="dim">tokens</span>
                        <span className="mono">
                          {metrics.llm.total_tokens} ({metrics.llm.prompt_tokens}+
                          {metrics.llm.completion_tokens})
                        </span>
                      </div>
                      <div className="metrics-row">
                        <span className="dim">duration</span>
                        <span className="mono">
                          avg {Math.round(metrics.duration_ms.avg)}ms · max{' '}
                          {Math.round(metrics.duration_ms.max)}ms
                        </span>
                      </div>
                      <div className="metrics-row dim">
                        <span>updated</span>
                        <span>{formatTime(metrics.updated_at)}</span>
                      </div>
                    </div>
                  )}
                </>
              )}

              {showFeishu && (
                <>
                  <div className="sidebar-title">Feishu</div>
                  {panelErrors.feishu ? (
                    <div className="panel-empty err">{panelErrors.feishu}</div>
                  ) : !feishu ? (
                    <div className="panel-empty dim">暂无渠道状态</div>
                  ) : (
                    <div className="feishu-panel">
                      <div className="feishu-head">
                        <span className={`mcp-status ${feishu.connected ? 'connected' : 'failed'}`}>
                          {feishu.connected ? 'connected' : 'disconnected'}
                        </span>
                        <span className="mono dim">{feishu.appIdMasked || '-'}</span>
                      </div>
                      <div className="feishu-meta dim">
                        chats {feishu.active_chats} · queued {feishu.queued_messages}
                      </div>
                      {feishu.last_error && (
                        <div className="feishu-error err">{truncate(feishu.last_error, 120)}</div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </aside>

        <main className="timeline" ref={timelineRef} onScroll={handleTimelineScroll}>
          {selectedId && (
            <div className="conversation-head">
              <div className="conversation-heading">
                <div className="conversation-title">
                  {selectedSession?.title || truncate(selectedId, 32)}
                </div>
                <div className="conversation-meta dim">
                  {selectedSession?.message_count != null
                    ? `${selectedSession.message_count} 条消息`
                    : '会话历史'}
                  {selectedSession?.updated_at
                    ? ` · 更新于 ${formatTime(selectedSession.updated_at)}`
                    : ''}
                  <span className="mono"> · {truncate(selectedId, 20)}</span>
                </div>
              </div>
              <button
                type="button"
                className="ghost-btn small"
                onClick={() => loadSessionDetail(selectedId)}
                disabled={hydrating}
              >
                {hydrating ? '加载中…' : '刷新历史'}
              </button>
            </div>
          )}

          {hydrateError && (
            <div className="state-block err">
              历史加载失败：{hydrateError}
              <button
                type="button"
                className="ghost-btn small"
                onClick={() => selectedId && loadSessionDetail(selectedId)}
              >
                重试
              </button>
            </div>
          )}

          {selectedId && hydrating && !hasTranscript && (
            <div className="state-block dim">正在加载会话历史…</div>
          )}

          {selectedId &&
            !hydrating &&
            !hydrateError &&
            !hasTranscript &&
            visibleGroups.length === 0 && (
              <div className="state-block dim">该会话暂无对话记录。</div>
            )}

          {selectedId && hasTranscript && <Transcript messages={transcriptMessages} />}

          {selectedId && visibleGroups.length > 0 && hasTranscript && (
            <div className="divider-label">
              <span>继续中</span>
            </div>
          )}

          {visibleGroups.length > 0 && (
            <div className="timeline-hint dim">实时事件 · 按时间正序</div>
          )}

          {visibleGroups.length === 0 && !selectedId && (
            <div className="empty">
              {draftSessionId
                ? '新会话已就绪，发送第一条消息开始。'
                : entries.length === 0
                  ? '尚未收到事件。连接 gateway 后，实时事件会出现在这里。'
                  : '当前筛选无事件。'}
            </div>
          )}

          {visibleGroups.map((group) => (
            <RunCard
              key={group.runId}
              group={group}
              cancelled={group.jobId ? cancelledJobs.has(group.jobId) : false}
              cancelling={group.jobId ? cancelling.has(group.jobId) : false}
              hideInput={
                hasTranscript &&
                transcriptMessages.some(
                  (message) => message.role === 'user' && message.content === group.input,
                )
              }
              onCancel={handleCancel}
            />
          ))}
          <div ref={bottomRef} />

          {!nearBottom && (
            <button type="button" className="to-bottom" onClick={scrollToBottom}>
              回到底部 ↓
            </button>
          )}
        </main>
      </div>

      <footer className="control" inert={modalOpen || undefined}>
        <div className="composer">
          <div className="composer-meta">
            <span className="control-session" title={selectedId ?? undefined}>
              {selectedId
                ? `→ ${selectedSession?.title || truncate(selectedId, 24)}`
                : draftSessionId
                  ? '＋ 新会话'
                  : '全部 runs'}
            </span>
            <span className="composer-hint dim">Enter 发送 · Shift+Enter 换行</span>
          </div>
          <div className="composer-row">
            <textarea
              ref={composerRef}
              className="control-input"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={
                token.trim()
                  ? draftSessionId
                    ? '开始一个新会话…'
                    : '输入 prompt'
                  : '请先填入 gateway token'
              }
              disabled={!token.trim() || submitting || connState !== 'open' || modalOpen}
              spellCheck={false}
            />
            <button
              type="button"
              className="send-btn"
              onClick={() => void handleSend()}
              disabled={
                !token.trim() || submitting || !input.trim() || connState !== 'open' || modalOpen
              }
            >
              {submitting ? '发送中' : '发送'}
            </button>
          </div>
          {lastOutput != null && (
            <span className="last-output dim">✓ {truncate(lastOutput, 60)}</span>
          )}
        </div>
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
