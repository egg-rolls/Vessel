/**
 * Ink REPL 主组件
 * @module @vessel-agent/tui
 *
 * 用 Ink 框架替换 readline，实现 React 组件式终端 UI。
 * 保持 startRepl(ctx) 函数签名不变，壳不感知替换。
 *
 * 架构（审计后收敛）：全部 UI 状态收敛进 useReplState（useReducer），
 * 命令为纯函数（返回 output/nextState），Ink 层以不可变合并消费 nextState。
 */

import { Box, render, Static, Text, useApp, useInput, useStdout, useWindowSize } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CommandResult,
  createCommands,
  doResume,
  GOODBYE_TEXT,
} from '../commands/commands.js';
import {
  deleteSessionAction,
  renameSessionAction,
  sessionActionResult,
} from '../commands/sessions-command.js';
import { AskUserDialog } from '../components/AskUserDialog.js';
import { BottomBar } from '../components/BottomBar.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  type CommandItem,
  decideCommandEnter,
  filterCommands,
  InlineAutocomplete,
} from '../components/InlineAutocomplete.js';
import { InteractiveViewHost } from '../components/InteractiveViewHost.js';
import { QueuePreview } from '../components/QueuePreview.js';
import { QuickHelp, shouldOpenQuickHelp } from '../components/QuickHelp.js';
import { SessionTable } from '../components/SessionTable.js';
import { useSpinnerState } from '../components/StateTracker.js';
import { StatusBar, type StatusKind } from '../components/StatusBar.js';
import { StreamOutput } from '../components/StreamOutput.js';
import { SubagentActivity } from '../components/SubagentActivity.js';
import { shouldPageOutput, TextViewer } from '../components/TextViewer.js';
import { UiItemView } from '../components/UiItemView.js';
import { UpdateBanner } from '../components/UpdateBanner.js';
import { resolveLocale, setLocale, t } from '../i18n/index.js';
import { formatPermissionQuestion } from '../renderer/tool-confirm.js';
import type { DurableRunHandle, ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import { glyph, theme } from '../theme.js';
import { asTuiEvent } from '../types/events.js';
import { collectFileReferences } from '../utils/file-reference.js';
import { getCurrentGitBranch } from '../utils/git.js';
import { sanitizeTerminalText } from '../utils/sanitize-terminal-text.js';
import { summarizeToolInput } from '../utils/tool-input-summary.js';
import { renderViewAsText } from '../views/render-text.js';
import { viewContextKey } from '../views/selection.js';
import type { ViewAction } from '../views/types.js';
import { useAgentRegistry } from './agent-registry.js';
import { maybeClearOnStart } from './clear-on-start.js';
import { failureFallbackAction, failureViewerTitle } from './error-archive.js';
import {
  BOTTOM_BAR_ROWS,
  computeLiveLayout,
  defaultBottomBarVisible,
  type OverlayKind,
  queuePreviewRows,
  STATUS_BAR_ROWS,
} from './layout.js';
import { PermissionPendingController } from './permission-pending.js';
import { fullTextOfItem, type UiItem } from './project/ui-item.js';
import { loadResumeSessions } from './resume-picker.js';
import { executeResume, executeTurn } from './run-turn.js';
import { useRuntimeCounters } from './runtime-counters.js';
import { buildStartupHeader } from './startup-header.js';
import { buildStartupNotice, loadStartupFacts, loadStartupNotice } from './startup-notice.js';
import {
  applyStatusBarToggle,
  matchStatusBarHotkey,
  resolveInitialStatusBars,
  type StatusBarsValue,
  type StatusBarsVisibility,
  statusBarsVisibility,
} from './status-format.js';
import { useStatusMetrics } from './status-metrics.js';
import { useReplState } from './use-repl-state.js';

/** Ink 已清掉 live frame 后，再清 scrollback 并把光标移回左上 */
const CLEAR_SCROLLBACK_SEQUENCE = '\x1b[3J\x1b[H';

/** 纯函数：该 item 是否有值得进 pager 的完整载荷（Ctrl+O） */
function shouldPageItem(item: UiItem): boolean {
  switch (item.kind) {
    case 'tool':
      return Boolean(item.view.result || item.view.error);
    case 'error':
      return item.text.split('\n').length > 1 || item.text.length > 200;
    case 'assistant':
    case 'reasoning':
      return item.text.split('\n').length > 3 || item.text.length > 240;
    case 'notice':
      return item.detail !== undefined || item.text.length > 240;
    case 'command':
      return item.text.length > 240 || (item.output?.length ?? 0) > 240;
    case 'agent':
      return item.task !== undefined || (item.children?.length ?? 0) > 0;
    case 'permission':
    case 'run':
    case 'user':
      return false;
  }
}

interface InkReplProps {
  ctx: ReplContext;
  /** /exit 命令触发退出（区别于 Ctrl+C）；由 startInkRepl 决定是否补写 farewell */
  onExitCommand?: () => void;
  /**
   * /clear、Ctrl+L 的唯一清屏入口：由 startInkRepl 绑定到 Ink `render()` 返回实例的
   * `clear()`（重置 previousLineCount），再写 `ESC[3J ESC[H`。
   * 禁止在 Ink 挂载期间直接 stdout.write 清屏序列。
   */
  clearScreen: () => void;
}

/**
 * Ink REPL 主组件
 */
function InkRepl({ ctx, onExitCommand, clearScreen }: InkReplProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [ui, dispatch] = useReplState(ctx);
  const state = ui.repl;

  /**
   * 权限确认挂起状态（DECISION-024 Addendum A）：没有超时计时器。
   * 弹窗一直等待，直到用户应答、Esc/Ctrl+C 取消并 abort、工具失败或 run 终态。
   */
  const permissionPendingRef = useRef<PermissionPendingController | null>(null);
  if (permissionPendingRef.current === null) {
    permissionPendingRef.current = new PermissionPendingController();
  }
  /** 订阅回调里读取最新 overlay（不随 effect 重建订阅） */
  const permissionOverlayRef = useRef(ui.permissionOverlay);
  permissionOverlayRef.current = ui.permissionOverlay;
  /** 0.11.1：同一 requestId 只允许发布一次 response（防重复点击 / 竞态） */
  const submittedPermissionRef = useRef<Set<string>>(new Set());
  const markPermissionSubmitted = useCallback((requestId: string): boolean => {
    if (submittedPermissionRef.current.has(requestId)) return false;
    submittedPermissionRef.current.add(requestId);
    return true;
  }, []);
  /** 队列串行执行守卫（避免同一 tick 重复出队） */
  const queueDrainingRef = useRef(false);
  /** 矮终端提示只写一次 scrollback */
  const lowHeightNoticeShownRef = useRef(false);
  /** 命令视图的异步动作：旧响应不得覆盖新响应 */
  const viewRequestIdRef = useRef(0);
  /** picker 重拉：旧响应不得覆盖新响应 */
  const resumeRequestIdRef = useRef(0);
  /** 本轮取消是否已由 StreamOutput 归档（避免再追加一条独立的 Cancelled 提示） */
  const streamCancellationArchivedRef = useRef(false);
  /** 本轮失败是否已由 StreamOutput 归档（失败只产生一条历史项） */
  const streamFailureArchivedRef = useRef(false);
  /** 本轮普通消息原文；事件流在 user.message 之前失败时补一条 user item */
  const pendingUserTextRef = useRef<string | undefined>(undefined);

  // ── 0.13 上/下栏显隐 ──────────────────────────────
  // 初始值：VESSEL_STATUS_BARS > ui.statusBars > 自动（上栏开、下栏 rows>=18）。
  // 手动切换后本次进程内优先；写回 YAML 由 ctx.settings.setStatusBars（asm 注入）完成。
  const initialStatusBars = useMemo(
    () =>
      resolveInitialStatusBars({
        env: process.env.VESSEL_STATUS_BARS,
        config: (ctx.config as unknown as { ui?: { statusBars?: unknown } }).ui?.statusBars,
      }),
    [ctx.config],
  );
  const initialVisibility: StatusBarsVisibility | null =
    initialStatusBars.value !== undefined ? statusBarsVisibility(initialStatusBars.value) : null;
  const [topOverride, setTopOverride] = useState<boolean | null>(null);
  const [bottomOverride, setBottomOverride] = useState<boolean | null>(null);
  /** 本次会话内 "always" 批准的工具（配置快照之外，立即计入 auto 数） */
  const [sessionAlways, setSessionAlways] = useState<ReadonlySet<string>>(() => new Set());

  const persistStatusBars = useCallback(
    (value: StatusBarsValue) => {
      const settings = ctx.settings;
      const setter = settings?.setStatusBars;
      if (!settings || !setter) return;
      // 写回失败不回滚界面：本次会话仍按用户选择显示。
      void setter.call(settings, value).catch(() => {});
    },
    [ctx.settings],
  );

  // 窗口尺寸在热键处理前计算，保证 overlay 打开时也能即时恢复/隐藏栏位。
  const windowSize = useWindowSize();
  const terminalRows = windowSize.rows > 0 ? windowSize.rows : (stdout.rows ?? 24);
  const terminalColumns = windowSize.columns > 0 ? windowSize.columns : (stdout.columns ?? 80);
  // 独占弹窗优先级：权限 > ask > picker > view > help > pager。
  // 弹窗打开时 live 区不再 display:none，而是折叠到固定行数（见 computeLiveLayout）。
  const overlayKind: OverlayKind = ui.permissionOverlay
    ? 'permission'
    : ui.askUserActive
      ? 'ask'
      : state.showResumePicker
        ? 'picker'
        : ui.view !== null
          ? 'view'
          : ui.quickHelpOpen
            ? 'help'
            : ui.textViewer !== null
              ? 'pager'
              : 'none';
  const exclusiveOverlayActive = overlayKind !== 'none';
  const showTop = topOverride ?? initialVisibility?.top ?? true;
  const showBottom =
    bottomOverride ?? initialVisibility?.bottom ?? defaultBottomBarVisible(terminalRows);
  // 独占 overlay（view / picker / permission / ask-user / help / pager）显示时下栏让位；
  // 终端过窄（<40 列）时 formatBottomBar 不渲染，行预算也不能白扣。
  const bottomBarVisible = showBottom && !exclusiveOverlayActive;
  const bottomBarRendered = bottomBarVisible && terminalColumns >= 40;

  // locale 切换后重建注册表：help / autocomplete 的 description 由 t() 在创建时求值。
  // biome-ignore lint/correctness/useExhaustiveDependencies: localeVersion is not read in the factory, only used to invalidate
  const commands = useMemo(() => createCommands(), [ui.localeVersion]);

  // /status 只读展示队列长度：UI 队列态不在 ReplContext 里，单独同步进 ReplState。
  useEffect(() => {
    dispatch({ type: 'patchRepl', patch: { queuedCount: ui.queuedInput.length } });
  }, [ui.queuedInput.length, dispatch]);

  /**
   * /runs resume 与视图动作 Enter 共用的运行态接管：
   * 复用 runStart/runEnd、Esc/Ctrl+C 取消路径与归档语义。
   */
  const startResumeRun = useCallback(
    async (handle: DurableRunHandle) => {
      const abort = new AbortController();
      streamFailureArchivedRef.current = false;
      dispatch({ type: 'runStart', abort });
      const outcome = await executeResume(handle, abort);
      if (outcome.status === 'cancelled') {
        // 有流式内容时，StreamOutput 已归档带「已取消」标注的正文；
        // 仅在没有内容可归档时补一条简短的取消提示。
        if (!streamCancellationArchivedRef.current) {
          dispatch({
            type: 'appendItem',
            item: { kind: 'notice', level: 'warn', text: t('common.cancelled') },
          });
        }
        streamCancellationArchivedRef.current = false;
      } else if (outcome.status === 'failed') {
        // StreamOutput 已归档时不再补第二条；事件缺失时才回退。
        const action = failureFallbackAction(streamFailureArchivedRef.current, outcome.error);
        streamFailureArchivedRef.current = false;
        if (action) dispatch(action);
      }
      dispatch({ type: 'runEnd' });
    },
    [dispatch],
  );

  // 预计算的命令列表（用于内联补全）；hidden alias（/sessions）不出现
  const allCommands = useMemo<CommandItem[]>(() => {
    return commands.visibleList().map((entry) => ({
      name: `/${entry.name}`,
      description: entry.description,
      usage: entry.usage,
      category: entry.category,
      keywords: entry.keywords,
      hidden: entry.hidden,
      available: entry.available ? entry.available(ctx) : true,
      ...(entry.unavailableHint ? { unavailableHint: entry.unavailableHint } : {}),
    }));
  }, [commands, ctx]);

  // 从当前输入中提取命令过滤词（"/" 之后、第一个空格之前的命令名部分）
  const commandFilter = ui.input.startsWith('/') ? (ui.input.slice(1).split(/\s+/)[0] ?? '') : '';
  const filteredCommands = useMemo(
    () => filterCommands(allCommands, commandFilter, { recent: ui.recentCommands }),
    [allCommands, commandFilter, ui.recentCommands],
  );
  // 补全只在命令名阶段（/ 开头、尚未输入空格、非精确匹配）显示：
  // - 一旦输入空格进入参数输入即隐藏，避免 Tab/Enter 把已输入参数覆盖成命令名
  // - 精确匹配某命令名时隐藏补全框，改由 argHint 显示参数提示
  const isExactCommand =
    ui.input.startsWith('/') && allCommands.some((cmd) => cmd.name === ui.input);
  const showAutocomplete =
    ui.view === null &&
    ui.run.phase === 'idle' &&
    ui.input.startsWith('/') &&
    !ui.input.includes(' ') &&
    !isExactCommand &&
    filteredCommands.length > 0 &&
    !ui.askUserActive;

  // 参数占位提示：当输入精确匹配某命令名时，显示灰色参数提示（如 " [number|id]"）
  const argHint = useMemo(() => {
    const trimmed = ui.input.trim();
    if (!trimmed.startsWith('/')) return null;
    const matched = allCommands.find((cmd) => cmd.name === trimmed);
    if (!matched?.usage) return null;
    const hint = matched.usage.slice(matched.name.length);
    return hint || null;
  }, [ui.input, allCommands]);

  // 过滤词变化时重置选择索引
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when filteredCommands reference changes
  useEffect(() => {
    dispatch({ type: 'setAutocompleteIndex', index: 0 });
  }, [filteredCommands]);

  // 同步 currentSessionId 到 ctx（壳 / SSE bridge 等读 ctx.currentSessionId）
  useEffect(() => {
    ctx.currentSessionId = state.currentSessionId;
  }, [state.currentSessionId, ctx]);

  /** 启动头 + 能力提示只写一次；/clear 后不重建（R0 风险 5） */
  const startupWrittenRef = useRef(false);
  useEffect(() => {
    if (startupWrittenRef.current) return;
    startupWrittenRef.current = true;
    let disposed = false;
    void loadStartupFacts(ctx)
      .then((facts) => {
        if (disposed) return;
        const header = buildStartupHeader({
          columns: stdout.columns ?? 80,
          rows: stdout.rows ?? 24,
          ...(ctx.version ? { version: ctx.version } : {}),
          summary: {
            model: ctx.provider.model,
            sessionId: ctx.currentSessionId,
            ...(ctx.tenant ? { tenantId: ctx.tenant.tenant_id } : {}),
            mcpCount: facts.mcpServers?.length ?? 0,
            interruptedRuns: facts.interruptedRuns?.length ?? 0,
            feishuConnected: facts.feishu?.connected ?? false,
          },
        });
        const notice = buildStartupNotice(facts);
        const lines = notice ? [...header, notice] : header;
        // 启动头 / wordmark / tagline / 能力提示统一暗金品牌色（打开终端第一眼看到的文字）。
        if (lines.length > 0) {
          dispatch({ type: 'appendHistoryLines', lines, tone: 'brand' });
        }
      })
      .catch(() => {
        // 启动信息失败不阻塞 REPL
      });
    return () => {
      disposed = true;
    };
  }, [ctx, dispatch, stdout]);

  // 权限确认请求（ADR-029）：展示弹窗；不做超时，只由应答/取消/失败/run 终态关闭。
  useEffect(() => {
    const unsubscribe = ctx.events.subscribe((rawEvent) => {
      const event = asTuiEvent(rawEvent);
      switch (event.type) {
        case 'tool.permission.request': {
          const requestId = event.data.requestId;
          permissionPendingRef.current?.start(requestId);
          dispatch({
            type: 'setPermissionOverlay',
            overlay: {
              requestId,
              run_id: event.run_id,
              toolName: event.data.tool,
              input: event.data.input,
              ...(event.data.session_id !== undefined ? { session_id: event.data.session_id } : {}),
            },
          });
          break;
        }
        case 'tool.call.failed': {
          const overlay = permissionOverlayRef.current;
          if (
            overlay &&
            overlay.run_id === event.run_id &&
            overlay.toolName === event.data.tool_name
          ) {
            // 当前等待确认的工具已失败：标记已答并关闭弹窗。
            permissionPendingRef.current?.answer(overlay.requestId);
          }
          dispatch({
            type: 'clearPermissionForTool',
            runId: event.run_id,
            toolName: event.data.tool_name,
          });
          break;
        }
        case 'run.completed':
        case 'run.failed':
        case 'run.cancelled': {
          // run 终态：弹窗随之关闭。
          const overlay = permissionOverlayRef.current;
          if (overlay && overlay.run_id === event.run_id) {
            permissionPendingRef.current?.answer(overlay.requestId);
          }
          dispatch({ type: 'clearPermissionForRun', runId: event.run_id });
          break;
        }
        default:
          break;
      }
    });
    return () => {
      permissionPendingRef.current?.dispose();
      unsubscribe();
    };
  }, [ctx.events, dispatch]);

  // picker 三态：loading / ready / error；retry 时 resumeReloadToken 自增触发重拉。
  // biome-ignore lint/correctness/useExhaustiveDependencies: resumeReloadToken is an intentional re-fetch trigger
  useEffect(() => {
    if (!state.showResumePicker) return;
    const requestId = ++resumeRequestIdRef.current;
    let cancelled = false;
    dispatch({ type: 'resumePickerLoading' });
    void loadResumeSessions(ctx).then((result) => {
      // 快速连续 retry 时，旧响应不得覆盖新响应。
      if (cancelled || requestId !== resumeRequestIdRef.current) return;
      if (result.status === 'ready') {
        dispatch({ type: 'resumePickerReady', sessions: result.sessions });
      } else {
        dispatch({ type: 'resumePickerError', message: result.message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [state.showResumePicker, ui.resumeReloadToken, ctx, dispatch]);

  // 处理输入（TextInput 的 onSubmit —— Enter 的唯一入口）
  // 注意：Ink 的 useInput 子组件先于父组件触发，且无法 stopPropagation，
  // 所以 Enter 的"补全 vs 执行"决策必须在此处（onSubmit）做，不能在 useInput 里做。
  const handleSubmit = useCallback(
    async (value: string) => {
      // 队列编辑 Enter：保存并退出，不执行（B5）。
      if (ui.queueEditIndex !== null) {
        dispatch({ type: 'updateQueuedInput', index: ui.queueEditIndex, value });
        dispatch({ type: 'setInput', input: '' });
        dispatch({ type: 'bumpCaret' });
        return;
      }

      // 补全 case：输入是未完成的命令名 -> 补全到当前选中命令，不执行。
      // 用户再按一次 Enter 才执行。（决策逻辑见 decideCommandEnter，已单测覆盖）
      const decision = decideCommandEnter(
        value,
        allCommands,
        filteredCommands,
        ui.autocompleteIndex,
      );
      if (decision.action === 'complete') {
        dispatch({ type: 'setInput', input: decision.commandName });
        dispatch({ type: 'bumpCaret' });
        return; // 仅补全，不执行
      }

      if (!value.trim()) return;

      // 运行中禁止并发 run（AgentRuntime.run 会重置 stats 并共享 context）。
      // 除 /exit 外一律入队，run 结束后按顺序自动执行。
      const isExitCommand = value.trim() === '/exit';
      if (ui.run.phase !== 'idle' && !isExitCommand) {
        dispatch({ type: 'enqueueInput', value });
        dispatch({ type: 'setInput', input: '' });
        dispatch({
          type: 'appendItem',
          item: {
            kind: 'notice',
            level: 'info',
            text: t('repl.queued', { count: ui.queuedInput.length + 1, value }),
          },
        });
        return;
      }

      dispatch({ type: 'recordInput', value });
      dispatch({ type: 'setInput', input: '' });

      // 处理命令。命令是纯函数：execute 应用 nextState 到传入的 working 副本，
      // Ink 层再用 result.nextState 做不可变合并（不直接改 React state 对象）。
      if (value.startsWith('/')) {
        // 只有 slash 命令本地落 user item；普通消息由 user.message 事件渲染。
        dispatch({
          type: 'appendItem',
          item: { kind: 'user', text: value, at: Date.now() },
        });
        // registry 已统一兜底；这里再防一层，保证命令实现异常不会让 REPL 崩溃。
        let result: CommandResult;
        try {
          result = await commands.execute(value, ctx, { ...state });
        } catch (error) {
          dispatch({ type: 'appendHistory', line: formatRpcError(error) });
          return;
        }
        if (result.handled) {
          const recentName = value.trim().replace(/^\//, '').split(/\s+/)[0] ?? '';
          if (recentName) dispatch({ type: 'pushRecentCommand', name: recentName });
          // /settings 已 setLocale：重建命令并重渲染，状态栏 / 弹窗 / help 立即跟随。
          if (result.localeChanged) dispatch({ type: 'bumpLocale' });

          // 命令返回交互视图：打开独占 overlay，不把整张表写进 scrollback。
          if (result.view) {
            if (result.nextState) dispatch({ type: 'patchRepl', patch: result.nextState });
            dispatch({ type: 'openView', envelope: result.view });
            dispatch({ type: 'setInput', input: '' });
            return;
          }

          // 特殊处理 /clear - 先走 Ink 实例的 clear()（重置 previousLineCount），
          // 再清 scrollback；禁止在 Ink 挂载期间直接 stdout.write 清屏序列。
          if (result.clearScreen) {
            clearScreen();
            dispatch({ type: 'clearHistory' });
            dispatch({ type: 'bumpClearSignal' }); // 触发 StreamOutput 清空
          } else if (result.output) {
            // 命令输出可能夹带控制序列：展示/归档前统一清洗。
            const output = sanitizeTerminalText(result.output);
            if (shouldPageOutput(output)) {
              const name = value.trim().replace(/^\//, '').split(/\s+/)[0] ?? '';
              const title = name
                ? `${name.charAt(0).toUpperCase()}${name.slice(1)}`
                : t('common.output');
              dispatch({
                type: 'openTextViewer',
                title,
                lines: output.split('\n'),
              });
            } else {
              // 短输出照旧写入 scrollback
              dispatch({ type: 'appendHistory', line: output });
            }
          }
          if (result.items?.length) {
            // /resume 等命令附带的结构化历史项
            dispatch({ type: 'appendItems', items: result.items });
          } else if (result.history?.length) {
            // 纯文本兼容路径
            dispatch({ type: 'appendHistoryLines', lines: result.history });
          }
          if (result.nextState) {
            dispatch({ type: 'patchRepl', patch: result.nextState });
          }
          // /runs resume：复用既有运行态（runStart/runEnd），Esc / Ctrl+C 走同一取消路径。
          if (result.resumeRun) await startResumeRun(result.resumeRun);
          return;
        }

        // 未知命令：显示提示，不发 AI
        const [cmdName = value] = value.trim().split(/\s+/);
        dispatch({
          type: 'appendItem',
          item: {
            kind: 'notice',
            level: 'warn',
            text: t('repl.unknownCommand', { name: cmdName }),
          },
        });
        return;
      }

      // 处理普通消息 - 调用 runtime.run
      // StreamOutput 组件通过事件流显示 token-by-token 输出，
      // run 完成后通过 onComplete 回调将响应归档到 history。
      // signal 来自本轮 AbortController：Esc / 运行中 Ctrl+C 会中断它。
      const abort = new AbortController();
      streamFailureArchivedRef.current = false;
      pendingUserTextRef.current = value;
      dispatch({ type: 'runStart', abort });
      try {
        const branch = await getCurrentGitBranch();
        // `@path` 引用展开（C10）：扫到的文件读为注入消息，用户原文不变
        const { messages, warnings, references } = collectFileReferences(value);
        for (const warning of warnings) {
          dispatch({
            type: 'appendItem',
            item: { kind: 'notice', level: 'warn', text: warning },
          });
        }
        for (const ref of references) {
          dispatch({
            type: 'appendItem',
            item: {
              kind: 'notice',
              level: 'info',
              text: t('repl.fileReference', {
                path: ref.path,
                bytes: ref.bytes,
                suffix: ref.truncated ? t('repl.fileTruncated') : '',
              }),
            },
          });
        }
        const outcome = await executeTurn({
          abort,
          run: (signal) =>
            ctx.runtime.run(value, state.currentSessionId, { branch, messages, signal }),
        });
        if (outcome.status === 'cancelled') {
          // 取消前已流出的内容由 StreamOutput 归档（含「已取消」标注）；
          // 没有内容时保留一条简短提示，避免用户以为什么都没发生。
          if (!streamCancellationArchivedRef.current) {
            dispatch({
              type: 'appendItem',
              item: { kind: 'notice', level: 'warn', text: t('common.cancelled') },
            });
          }
          streamCancellationArchivedRef.current = false;
        } else if (outcome.status === 'failed') {
          // 单源：StreamOutput 已在 run.failed 时归档；只有事件缺失时才回退补一条。
          const action = failureFallbackAction(streamFailureArchivedRef.current, outcome.error);
          streamFailureArchivedRef.current = false;
          if (action) dispatch(action);
        }
      } catch (error) {
        // 只可能是 run 之前的准备工作（git 分支、文件扫描）失败；没有 StreamOutput 归档。
        const pending = pendingUserTextRef.current;
        if (pending !== undefined) {
          dispatch({
            type: 'appendItem',
            item: { kind: 'user', text: pending, at: Date.now() },
          });
        }
        const action = failureFallbackAction(false, error);
        if (action) dispatch(action);
      } finally {
        pendingUserTextRef.current = undefined;
        dispatch({ type: 'runEnd' });
      }
    },
    [
      ctx,
      state,
      commands,
      allCommands,
      filteredCommands,
      ui.autocompleteIndex,
      ui.run.phase,
      ui.queuedInput.length,
      ui.queueEditIndex,
      dispatch,
      startResumeRun,
      clearScreen,
    ],
  );

  /** 队列执行时读取最新 handleSubmit（phase 必须是最新值） */
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  // 运行结束后按顺序执行队列；draining 守卫 + queueTick 保证异步命令也能继续出队。
  // biome-ignore lint/correctness/useExhaustiveDependencies: queueTick is an intentional re-run trigger
  useEffect(() => {
    if (queueDrainingRef.current) return;
    if (ui.run.phase !== 'idle' || !state.running) return;
    if (ui.queuedInput.length === 0) return;
    if (ui.view || state.showResumePicker || ui.permissionOverlay || ui.askUserActive) return;
    const next = ui.queuedInput[0];
    if (next === undefined) return;
    queueDrainingRef.current = true;
    dispatch({ type: 'dequeueInput' });
    void handleSubmitRef.current(next).finally(() => {
      queueDrainingRef.current = false;
      dispatch({ type: 'bumpQueueTick' });
    });
  }, [
    ui.run.phase,
    ui.queuedInput,
    ui.view,
    ui.permissionOverlay,
    ui.askUserActive,
    ui.queueTick,
    state.running,
    state.showResumePicker,
    dispatch,
  ]);

  const closeView = useCallback(() => {
    // 使在途响应失效，避免关闭后 late dispatch。
    viewRequestIdRef.current += 1;
    dispatch({ type: 'closeView' });
  }, [dispatch]);

  /**
   * 视图动作：路由回产生该视图的命令（registry.dispatchViewAction）。
   *
   * - refresh 进入 loading 态；失败时进入 error 态（可 r 重试），不会卡在 loading。
   * - resume/cancel 等动作返回 `resumeRun` 时，先关闭视图再接管运行态
   *   （与 /runs resume 同一条路径）。
   * - 其它动作成功返回 output 时按 toast 追加一行，视图保持打开。
   */
  const handleViewAction = useCallback(
    async (action: ViewAction, selectionKey: string, actionValue?: string) => {
      const active = ui.view;
      if (!active) return;
      const isRefresh = action.id === 'refresh';
      // 所有动作都推进 requestId：关闭视图/切换视图/连续触发动作后，
      // 任何 late response（包括 resume/cancel）都必须丢弃。
      const requestId = ++viewRequestIdRef.current;
      if (isRefresh) dispatch({ type: 'viewLoading', requestId });

      const viewKey = viewContextKey(active.envelope.view);
      const result = await commands.dispatchViewAction(
        active.envelope.source,
        {
          actionId: action.id,
          selectionKey,
          ...(actionValue !== undefined ? { value: actionValue } : {}),
          viewKind: active.envelope.view.kind,
          ...(viewKey !== undefined ? { viewKey } : {}),
        },
        ctx,
        { ...state },
      );

      // 旧响应不得覆盖新响应（关闭/切换视图后也不得 late resume/cancel）。
      if (requestId !== viewRequestIdRef.current) return;

      if (result.nextState) dispatch({ type: 'patchRepl', patch: result.nextState });

      // 运行态接管：视图让位给正常 run 生命周期（先保留 "Resuming..." 状态行）。
      if (result.resumeRun) {
        if (result.output) dispatch({ type: 'appendHistory', line: result.output });
        closeView();
        await startResumeRun(result.resumeRun);
        return;
      }

      if (result.view) {
        dispatch({
          type: 'viewData',
          envelope: result.view,
          ...(selectionKey ? { selectedKey: selectionKey } : {}),
          ...(isRefresh ? { requestId } : {}),
        });
      } else if (isRefresh) {
        dispatch({
          type: 'viewError',
          message: (result.output ?? t('common.refreshFailed')).trim() || t('common.refreshFailed'),
          requestId,
        });
      } else if (result.output) {
        dispatch({ type: 'appendHistory', line: result.output });
      }
    },
    [ui.view, commands, ctx, state, dispatch, closeView, startResumeRun],
  );

  /** 只取消当前 run（不退出进程） */
  const cancelRun = useCallback(() => {
    if (ui.run.phase !== 'running') return;
    dispatch({ type: 'runCancelRequested' });
    ui.run.abort?.abort(new Error('Run cancelled by user'));
  }, [ui.run, dispatch]);

  /**
   * Ctrl+C 的统一语义：
   * - idle → 退出；
   * - 运行中 → 先解除可能阻塞 run 的交互（权限 waitFor / ask_user waitFor），
   *   再 abort；否则权限 waitFor 会让 run 一直挂起。
   */
  const cancelOrExit = useCallback(() => {
    // idle -> 退出；cancelling 时再次 Ctrl+C -> 强制退出（工具可能还在跑）
    if (ui.run.phase === 'idle' || ui.run.phase === 'cancelling') {
      exit();
      return;
    }
    if (ui.permissionOverlay && markPermissionSubmitted(ui.permissionOverlay.requestId)) {
      // 取消/abort 立即关闭弹窗并回 deny（权限不再等待超时）。
      permissionPendingRef.current?.answer(ui.permissionOverlay.requestId);
      ctx.events.publish({
        type: 'tool.permission.response',
        run_id: ui.permissionOverlay.run_id,
        data: {
          requestId: ui.permissionOverlay.requestId,
          decision: 'deny',
          ...(ui.permissionOverlay.session_id !== undefined
            ? { session_id: ui.permissionOverlay.session_id }
            : {}),
        },
        ts: Date.now(),
      });
      dispatch({ type: 'clearPermissionForRequest', requestId: ui.permissionOverlay.requestId });
    }
    if (ui.askUserActive && ui.askUserRequestId) {
      ctx.events.publish({
        type: 'ask.user.answered',
        run_id: ui.askUserRunId ?? '',
        data: { requestId: ui.askUserRequestId, answers: [] },
        ts: Date.now(),
      });
    }
    cancelRun();
  }, [ui, ctx.events, dispatch, exit, cancelRun, markPermissionSubmitted]);

  // 键盘输入处理（Tab/↑↓/Esc 在补全可见时拦截）
  // Enter 不在此处理：Ink 子组件 useInput 先于父组件、且无法 stopPropagation，
  // 故 Enter 统一交给 TextInput.onSubmit -> handleSubmit 决策（补全 or 执行）。
  useInput((inputChar, key) => {
    // 全局键：即使弹窗显示也必须生效，否则 Ctrl+C 会被弹窗吞掉、界面卡死
    if (key.ctrl && inputChar === 'c') {
      cancelOrExit();
      return;
    }

    if (key.ctrl && inputChar === 'l') {
      // Ink clear() 先重置 previousLineCount，再清 scrollback（ADR/PLAN §6）。
      clearScreen();
      // TextInput 不忽略 Ctrl+L，会先把 'l' 插进输入；用当前值覆盖并重置光标
      dispatch({ type: 'setInput', input: ui.input });
      dispatch({ type: 'bumpCaret' });
      dispatch({ type: 'clearHistory' });
      dispatch({ type: 'bumpClearSignal' });
      return;
    }

    // Ctrl+T / Ctrl+G：切换上/下栏。放在 overlay 早退之前，弹窗打开时也能恢复栏位。
    // ink-text-input 会把 Ctrl 字符插入输入框：切换后必须覆盖回当前输入并重置光标。
    const statusBarsHotkey = matchStatusBarHotkey(inputChar, key);
    if (statusBarsHotkey === 'toggleTop' || statusBarsHotkey === 'toggleBottom') {
      const result = applyStatusBarToggle(
        { top: showTop, bottom: showBottom },
        statusBarsHotkey === 'toggleTop' ? 'top' : 'bottom',
      );
      setTopOverride(result.visibility.top);
      setBottomOverride(result.visibility.bottom);
      persistStatusBars(result.value);
      dispatch({ type: 'setInput', input: ui.input });
      dispatch({ type: 'bumpCaret' });
      return;
    }

    // quick help / pager 独占焦点；按键由组件自己处理
    if (ui.quickHelpOpen || ui.textViewer) return;

    // ask-user / 权限弹窗显示时，其余键盘交给弹窗组件自己的 useInput
    if (ui.askUserActive || ui.permissionOverlay) return;

    // 命令视图打开时，键盘完全交给 InteractiveViewHost（单一焦点）。
    if (ui.view) return;

    // Ctrl+R：打开 /resume picker（下栏 session 入口）。与 Ctrl+L/O 同法覆盖被插入的字符。
    if (statusBarsHotkey === 'openSessions') {
      dispatch({ type: 'setInput', input: ui.input });
      dispatch({ type: 'bumpCaret' });
      if (!state.showResumePicker) {
        dispatch({ type: 'patchRepl', patch: { showResumePicker: true, pendingResume: false } });
      }
      return;
    }

    // 队列编辑独占 ↑↓ / Esc / Ctrl+X；其余键继续交给 TextInput。
    if (ui.queueEditIndex !== null) {
      if (key.ctrl && inputChar === 'x') {
        dispatch({ type: 'removeQueuedInput', index: ui.queueEditIndex });
        dispatch({ type: 'setInput', input: ui.queueReturnInput });
        dispatch({ type: 'bumpCaret' });
        return;
      }
      if (key.upArrow || key.downArrow) {
        const count = ui.queuedInput.length;
        if (count > 0) {
          const step = key.upArrow ? -1 : 1;
          const next = (ui.queueEditIndex + step + count) % count;
          dispatch({ type: 'setQueueEditIndex', index: next });
          dispatch({ type: 'setInput', input: ui.queuedInput[next] ?? '' });
          dispatch({ type: 'bumpCaret' });
        }
        return;
      }
      if (key.escape) {
        dispatch({ type: 'cancelQueueEdit' });
        dispatch({ type: 'bumpCaret' });
        return;
      }
      return;
    }

    if (showAutocomplete) {
      if (key.tab) {
        const selected = filteredCommands[ui.autocompleteIndex];
        if (selected) {
          dispatch({ type: 'setInput', input: selected.name });
          dispatch({ type: 'bumpCaret' });
        }
        dispatch({ type: 'setAutocompleteIndex', index: 0 });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'setAutocompleteIndex', index: Math.max(0, ui.autocompleteIndex - 1) });
        return;
      }
      if (key.downArrow) {
        dispatch({
          type: 'setAutocompleteIndex',
          index: Math.min(filteredCommands.length - 1, ui.autocompleteIndex + 1),
        });
        return;
      }
      if (key.escape) {
        dispatch({ type: 'setInput', input: '' });
        dispatch({ type: 'setAutocompleteIndex', index: 0 });
        return;
      }
      // Enter 不拦截：落到 TextInput.onSubmit -> handleSubmit
    }

    // 如果有其他独占交互组件显示，不处理其余输入
    if (state.showResumePicker) {
      return;
    }

    // Ctrl+O：任意 item 的完整载荷可进 pager；否则切换 live 区展开态。
    // TextInput 会把 Ctrl+O 当字符插入，需覆盖回去。
    if (key.ctrl && inputChar === 'o') {
      const last = ui.history.at(-1);
      if (ui.run.phase === 'idle' && last && shouldPageItem(last.item)) {
        const full = fullTextOfItem(last.item);
        if (full) {
          dispatch({
            type: 'openTextViewer',
            title: last.item.kind === 'error' ? failureViewerTitle() : t('common.output'),
            lines: full.split('\n'),
          });
          dispatch({ type: 'setInput', input: ui.input });
          dispatch({ type: 'bumpCaret' });
          return;
        }
      }
      dispatch({ type: 'toggleExpanded' });
      dispatch({ type: 'setInput', input: ui.input });
      dispatch({ type: 'bumpCaret' });
      return;
    }

    // 输入框为空且不在历史浏览时，↑↓ 进入队列编辑（队尾 / 队首）。
    if (
      ui.input === '' &&
      ui.historyIndex === null &&
      ui.queuedInput.length > 0 &&
      (key.upArrow || key.downArrow)
    ) {
      const index = key.upArrow ? ui.queuedInput.length - 1 : 0;
      dispatch({ type: 'beginQueueEdit', index, returnInput: '' });
      dispatch({ type: 'setInput', input: ui.queuedInput[index] ?? '' });
      dispatch({ type: 'bumpCaret' });
      return;
    }

    // ↑↓ 召回已提交输入；多行草稿不拦截（保留行内光标移动）。
    if (!ui.input.includes('\n')) {
      if (key.upArrow) {
        dispatch({ type: 'historyPrev' });
        dispatch({ type: 'bumpCaret' });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'historyNext' });
        dispatch({ type: 'bumpCaret' });
        return;
      }
    }

    if (key.escape) {
      // TextInput 不忽略 Esc，会把 ESC 序列插进输入；用当前值覆盖回去（并重置光标）
      dispatch({ type: 'setInput', input: ui.input });
      dispatch({ type: 'bumpCaret' });
      // 运行中 Esc = 取消本轮 run
      if (ui.run.phase === 'running') cancelRun();
      return;
    }
  });

  // 权限确认回调（ADR-029：发布 tool.permission.response，decision=allow/deny）
  const handlePermission = useCallback(
    (answer: string) => {
      const overlay = ui.permissionOverlay;
      if (!overlay) return;
      // 0.11.1：同一请求只提交一次（重复 Enter / 快速按键不再发布第二条 response）。
      if (!markPermissionSubmitted(overlay.requestId)) return;
      permissionPendingRef.current?.answer(overlay.requestId);

      const always = answer === 'always';
      ctx.events.publish({
        type: 'tool.permission.response',
        run_id: overlay.run_id,
        data: {
          requestId: overlay.requestId,
          decision: answer === 'y' || always ? 'allow' : 'deny',
          // "always" → 记住批准（runtime 维护 approvedTools，后续同工具免确认）
          remember: always,
          ...(overlay.session_id !== undefined ? { session_id: overlay.session_id } : {}),
          answered_by: 'human',
          answered_via: 'tui',
        },
        ts: Date.now(),
      });
      dispatch({ type: 'setPermissionOverlay', overlay: null });

      // "always" 同时写回用户 YAML（跨进程）；未注入写回接口时降级为本次会话。
      if (always) {
        // 下栏 auto 计数：配置快照不会随本次批准刷新，用会话集合补上。
        setSessionAlways((prev) => {
          if (prev.has(overlay.toolName)) return prev;
          const next = new Set(prev);
          next.add(overlay.toolName);
          return next;
        });
        const control = ctx.permissions;
        if (!control) {
          dispatch({
            type: 'appendItem',
            item: {
              kind: 'notice',
              level: 'info',
              text: t('permission.sessionOnly', { tool: overlay.toolName }),
            },
          });
        } else {
          void control
            .add(overlay.toolName)
            .then(() => {
              dispatch({
                type: 'appendItem',
                item: {
                  kind: 'notice',
                  level: 'info',
                  text: t('permission.persisted', { tool: overlay.toolName }),
                },
              });
            })
            .catch((error: unknown) => {
              dispatch({
                type: 'appendItem',
                item: {
                  kind: 'notice',
                  level: 'warn',
                  text: t('permission.persistFailed', {
                    tool: overlay.toolName,
                    error: formatRpcError(error),
                  }),
                },
              });
            });
        }
      }
    },
    [ui.permissionOverlay, ctx.events, ctx.permissions, dispatch, markPermissionSubmitted],
  );

  // ask-user 弹窗激活状态回调（子组件汇报 requestId/runId，供 Ctrl+C 主动解除 waitFor）
  const handleAskUserActive = useCallback(
    (active: boolean, requestId?: string, runId?: string) => {
      dispatch({ type: 'setAskUserActive', active, requestId, runId });
    },
    [dispatch],
  );

  // StreamOutput 完成回调：整轮结构化 items 归档到 history（不再压成字符串）
  const handleStreamComplete = useCallback(
    (items: UiItem[], reason: 'completed' | 'failed' | 'cancelled') => {
      streamCancellationArchivedRef.current = reason === 'cancelled';
      // 失败由 StreamOutput 单源归档（error item + run summary），父组件不再重复追加。
      streamFailureArchivedRef.current = reason === 'failed';
      // run 在 user.message 之前失败（典型是 input guardrail 拦截）时事件里没有用户输入。
      const pending = pendingUserTextRef.current;
      if (
        reason !== 'completed' &&
        pending !== undefined &&
        !items.some((item) => item.kind === 'user')
      ) {
        dispatch({
          type: 'appendItem',
          item: { kind: 'user', text: pending, at: Date.now() },
        });
      }
      if (items.length > 0) {
        dispatch({ type: 'appendItems', items });
        return;
      }
      if (reason === 'cancelled') {
        dispatch({
          type: 'appendItem',
          item: { kind: 'notice', level: 'warn', text: t('common.cancelled') },
        });
      } else if (reason === 'failed') {
        dispatch({
          type: 'appendItem',
          item: { kind: 'error', text: t('item.errorUnknown') },
        });
      }
    },
    [dispatch],
  );

  // Ctrl+O：StreamOutput 把当前完整 items 刷入 Static scrollback
  const handleStreamFlush = useCallback(
    (items: UiItem[]) => {
      dispatch({ type: 'appendItems', items });
    },
    [dispatch],
  );

  // 退出处理：running=false 只由 /exit 置位，交由 startInkRepl 在 unmount 后写 farewell。
  useEffect(() => {
    if (!state.running) {
      onExitCommand?.();
      ctx.onExit();
      exit();
    }
  }, [state.running, ctx, exit, onExitCommand]);

  // 实时区域高度上限：给状态栏、输入行、running 行、补全框留出空间。
  // 根 Box 不再设置 height —— 固定 height 会让 Ink 判定为 fullscreen 并每帧 clearTerminal，
  // 在 Windows/PowerShell 下会导致历史、流式输出和底栏互相覆盖。
  // Ink 的 resize 只重算 Yoga 并序列化现有树，不会重跑 React render；
  // 窗口尺寸在热键处理前用 useWindowSize 订阅，保证矮终端分级能即时生效。
  const queueRows = exclusiveOverlayActive
    ? 0
    : queuePreviewRows(ui.queuedInput.length, terminalRows);
  const layout = computeLiveLayout(terminalRows, queueRows, {
    topRows: showTop ? STATUS_BAR_ROWS : 0,
    bottomRows: bottomBarRendered ? BOTTOM_BAR_ROWS : 0,
    overlay: overlayKind,
  });
  const runActive = ui.run.phase !== 'idle';
  const spinner = useSpinnerState(ctx.events);
  const metrics = useStatusMetrics(ctx, state.currentSessionId, ui.run.phase);
  // 子 agent 活动与下栏 sub N 共用同一份 agent-registry 派生（0.17 agent.* 事件）。
  const agentNodes = useAgentRegistry(ctx.events);
  const runtimeCounters = useRuntimeCounters(ctx.events, agentNodes);
  // auto 数 = 启动配置的 auto_approve + 本次会话 "always"；ask_user 由运行时永远免确认，不计入。
  const autoApproveCount = useMemo(() => {
    const names = new Set<string>([
      ...(ctx.config.permission?.autoApprove ?? []),
      ...sessionAlways,
    ]);
    names.delete('ask_user');
    return names.size;
  }, [ctx.config.permission, sessionAlways]);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  useEffect(() => {
    setTurnStartedAt(ui.run.phase === 'running' ? Date.now() : null);
  }, [ui.run.phase]);
  const statusKind: StatusKind =
    ui.run.phase === 'cancelling'
      ? 'cancelling'
      : ui.run.phase !== 'idle'
        ? spinner.verb === 'tool'
          ? 'tool'
          : 'thinking'
        : 'idle';
  const durationMs =
    turnStartedAt !== null && ui.run.phase !== 'idle'
      ? Math.max(0, metrics.now - turnStartedAt)
      : undefined;
  // minimal 档在 run 进行中保留 1 行进度；hidden 始终为 0。
  // overlay 打开时 live 折叠到固定行数（OVERLAY_LIVE_ROWS），而不是 display:none。
  const liveMaxHeight = exclusiveOverlayActive
    ? layout.liveRenderRows
    : layout.mode === 'minimal' && runActive
      ? Math.min(1, layout.liveMaxHeight)
      : layout.liveMaxHeight;
  const streamMaxLines = exclusiveOverlayActive
    ? Math.max(1, layout.liveRenderRows)
    : layout.mode === 'minimal' && runActive
      ? 1
      : layout.streamMaxLines;

  // 矮终端降级只提示一次；写入 Static/scrollback，不占 live 行。
  useEffect(() => {
    if (!layout.notice || lowHeightNoticeShownRef.current) return;
    lowHeightNoticeShownRef.current = true;
    dispatch({
      type: 'appendItem',
      item: { kind: 'notice', level: 'warn', text: layout.notice },
    });
  }, [layout.notice, dispatch]);

  return (
    <Box flexDirection="column">
      {/* 状态栏（固定顶部） + 更新提示（asm 发布 update.available 时出现） */}
      <Box flexDirection="column" flexShrink={0}>
        {showTop && !(exclusiveOverlayActive && layout.mode === 'hidden') && (
          <StatusBar
            status={statusKind}
            model={ctx.provider.model}
            context={metrics.context}
            {...(durationMs !== undefined ? { durationMs } : {})}
            compactions={state.compactions ?? 0}
            cwd={metrics.cwd}
            {...(metrics.home !== undefined ? { home: metrics.home } : {})}
            {...(metrics.branch ? { branch: metrics.branch } : {})}
            columns={terminalColumns}
            marqueeAllowed={!exclusiveOverlayActive}
          />
        )}
        {/* overlay 打开时隐藏更新横幅：高度预算只给状态栏留了 1 行 */}
        {!exclusiveOverlayActive && layout.mode !== 'minimal' && layout.mode !== 'hidden' && (
          <UpdateBanner events={ctx.events} />
        )}
      </Box>

      {/* 已完成历史交给 Ink <Static>：直接写入终端 scrollback，不再参与每帧重绘。
          key={clearSignal} 让 /clear 与 Ctrl+L 强制重挂载。每项按 item.kind 渲染。 */}
      <Static key={ui.clearSignal} items={ui.history}>
        {(entry, i) => (
          <Box key={`${i}-${ui.clearSignal}`} flexDirection="column">
            <UiItemView item={entry.item} columns={terminalColumns} expanded={ui.expandedOutput} />
          </Box>
        )}
      </Static>

      {/* 实时区域：只显示当前轮流式输出 / 子 agent 活动，限制高度防止覆盖底栏。
          独占弹窗打开时折叠到固定行数（OVERLAY_LIVE_ROWS），不再 display:none；
          只有终端矮到 liveRenderRows=0 时才隐藏，但组件保持挂载（StreamOutput 仍在归档）。 */}
      <Box
        flexDirection="column"
        overflowY="hidden"
        height={exclusiveOverlayActive && liveMaxHeight > 0 ? liveMaxHeight : undefined}
        maxHeight={exclusiveOverlayActive ? undefined : liveMaxHeight}
        display={liveMaxHeight === 0 ? 'none' : 'flex'}
      >
        <StreamOutput
          events={ctx.events}
          clearSignal={ui.clearSignal}
          maxLines={streamMaxLines}
          expanded={ui.expandedOutput}
          expandSignal={ui.expandSignal}
          onFlush={handleStreamFlush}
          onComplete={handleStreamComplete}
          detailMode={state.toolDetailMode ?? 'collapsed'}
        />
        <SubagentActivity nodes={agentNodes} />
      </Box>

      {/* 底部固定区域：overlays + 输入框 + 补全框（flexShrink=0 防止被 Yoga 压缩） */}

      {/* 命令视图（CommandView -> InteractiveViewHost）；与 picker 同为独占 overlay */}
      {ui.view && (
        <Box
          flexDirection="column"
          flexShrink={0}
          // 权限/ask-user 优先级更高：视图保持挂载（不丢状态），但让出屏幕与键盘。
          display={ui.permissionOverlay || ui.askUserActive ? 'none' : 'flex'}
        >
          <InteractiveViewHost
            envelope={ui.view.envelope}
            selectedKey={ui.view.selectedKey}
            filter={ui.view.filter}
            mode={ui.view.mode}
            draft={ui.view.draft}
            pendingAction={ui.view.pendingAction}
            columns={terminalColumns}
            maxRows={layout.viewMaxRows}
            heightMode={layout.mode}
            active={!ui.permissionOverlay && !ui.askUserActive}
            onSelect={(key) => dispatch({ type: 'viewSelect', key })}
            onFilter={(filter) => dispatch({ type: 'viewFilter', filter })}
            onMode={(mode, draft, pendingAction) =>
              dispatch({
                type: 'viewMode',
                mode,
                ...(draft !== undefined ? { draft } : {}),
                ...(pendingAction !== undefined ? { pendingAction } : {}),
              })
            }
            onAction={(action, selectionKey, value) => {
              void handleViewAction(action, selectionKey, value);
            }}
            onClose={closeView}
          />
        </Box>
      )}

      {/* 权限/ask-user 优先级高于命令视图：视图保持挂载但键盘被禁用（active=false） */}
      {state.showResumePicker && (
        <Box flexDirection="column" flexShrink={0}>
          <SessionTable
            sessions={ui.resumeSessions}
            currentSessionId={state.currentSessionId}
            status={ui.resumeStatus === 'idle' ? 'loading' : ui.resumeStatus}
            error={ui.resumeError}
            maxRows={layout.pickerMaxRows}
            heightMode={layout.mode}
            columns={terminalColumns}
            onRetry={() => dispatch({ type: 'resumePickerRetry' })}
            onDelete={async (id) => {
              const result = await deleteSessionAction(ctx, id, {
                confirmed: true,
                currentSessionId: state.currentSessionId,
              });
              const outcome = sessionActionResult(result);
              if (outcome.ok) {
                dispatch({
                  type: 'resumePickerReady',
                  sessions: ui.resumeSessions.filter((session) => session.session_id !== id),
                });
              }
              return outcome;
            }}
            onRename={async (id, title) => {
              const result = await renameSessionAction(ctx, id, title);
              const outcome = sessionActionResult(result);
              if (outcome.ok) {
                dispatch({
                  type: 'resumePickerReady',
                  sessions: ui.resumeSessions.map((session) =>
                    session.session_id === id ? { ...session, title } : session,
                  ),
                });
              }
              return outcome;
            }}
            onSelect={async (id) => {
              try {
                const { message, items, nextState } = await doResume(ctx, id, {
                  showReasoning: state.showReasoning ?? false,
                });
                dispatch({
                  type: 'patchRepl',
                  patch: { showResumePicker: false, pendingResume: false },
                });
                dispatch({ type: 'setInput', input: '' });
                dispatch({ type: 'patchRepl', patch: nextState });
                dispatch({
                  type: 'appendItem',
                  item: { kind: 'command', text: message },
                });
                if (items?.length) {
                  dispatch({ type: 'appendItems', items });
                }
                dispatch({ type: 'resumePickerReset' });
              } catch (error) {
                // 恢复失败：保持 picker 打开，错误态可 r 重试。
                dispatch({ type: 'resumePickerError', message: formatRpcError(error) });
              }
            }}
            onClose={() => {
              dispatch({
                type: 'patchRepl',
                patch: { showResumePicker: false, pendingResume: false },
              });
              dispatch({ type: 'resumePickerReset' });
            }}
          />
        </Box>
      )}

      {/* 权限确认对话框（ADR-029：订阅 tool.permission.request，发布 response） */}
      {ui.permissionOverlay && (
        <Box flexDirection="column" flexShrink={0}>
          <ConfirmDialog
            question={formatPermissionQuestion(
              ui.permissionOverlay.toolName,
              ctx.mcp?.toolSource(ui.permissionOverlay.toolName) ?? null,
            )}
            details={summarizeToolInput(ui.permissionOverlay.toolName, ui.permissionOverlay.input)}
            maxRows={layout.overlayMaxRows}
            defaultChoice="n"
            onConfirm={handlePermission}
          />
        </Box>
      )}

      {/* ask-user 问答弹窗（自身订阅 ask.user.requested / 发布 answered） */}
      <Box flexDirection="column" flexShrink={0}>
        <AskUserDialog
          events={ctx.events}
          maxRows={layout.overlayMaxRows}
          onActiveChange={handleAskUserActive}
        />
      </Box>

      {/* 队列预览（输入框上方；最多 3 条 + 尾行） */}
      {!exclusiveOverlayActive && (
        <QueuePreview
          queued={ui.queuedInput}
          editIndex={ui.queueEditIndex}
          columns={terminalColumns}
          rows={terminalRows}
        />
      )}

      {/* ? quick help（独占焦点；Backspace / Esc 关闭） */}
      {ui.quickHelpOpen &&
        !ui.view &&
        !state.showResumePicker &&
        !ui.permissionOverlay &&
        !ui.askUserActive && (
          <Box flexDirection="column" flexShrink={0}>
            <QuickHelp
              columns={terminalColumns}
              rows={Math.max(6, layout.overlayMaxRows)}
              onClose={() => dispatch({ type: 'setQuickHelp', open: false })}
            />
          </Box>
        )}

      {/* 长文本 pager（CommandResult 形状不变；仅 TTY 路径） */}
      {ui.textViewer && !ui.permissionOverlay && !ui.askUserActive && (
        <Box flexDirection="column" flexShrink={0}>
          <TextViewer
            title={ui.textViewer.title}
            lines={ui.textViewer.lines}
            columns={terminalColumns}
            rows={Math.max(7, layout.overlayMaxRows)}
            onClose={() => dispatch({ type: 'closeTextViewer' })}
          />
        </Box>
      )}

      {/* 输入框 - 只在没有独占交互组件时显示 */}
      {!state.showResumePicker &&
        !ui.view &&
        !ui.permissionOverlay &&
        !ui.askUserActive &&
        !ui.quickHelpOpen &&
        !ui.textViewer && (
          <Box flexShrink={0}>
            <Text color={theme.brand}>vessel › </Text>
            <TextInput
              key={ui.inputCaretKey}
              value={ui.input}
              onChange={(value) => {
                if (shouldOpenQuickHelp(ui.input, value)) {
                  dispatch({ type: 'setInput', input: '' });
                  dispatch({ type: 'bumpCaret' });
                  dispatch({ type: 'setQuickHelp', open: true });
                  return;
                }
                dispatch({ type: 'setInput', input: value });
              }}
              onSubmit={handleSubmit}
            />
            {argHint && <Text color={theme.faint}>{argHint}</Text>}
          </Box>
        )}

      {/* 运行态提示：输入框保持可用（可先打字），但 Enter 不会并发提交 */}
      {ui.run.phase !== 'idle' &&
        !state.showResumePicker &&
        !ui.view &&
        !ui.permissionOverlay &&
        !ui.askUserActive &&
        !ui.quickHelpOpen &&
        !ui.textViewer && (
          <Box flexDirection="column" flexShrink={0}>
            <Text color={theme.warn}>
              {ui.run.phase === 'cancelling'
                ? t('repl.cancelling')
                : t('repl.working', {
                    action: t(ui.expandedOutput ? 'repl.collapse' : 'repl.expand'),
                    suffix: ui.expandedOutput ? t('repl.fullOutputHint') : '',
                  })}
            </Text>
          </Box>
        )}

      {/* 运行态下栏（独占 overlay 时隐藏；吸收原 hint 行） */}
      {bottomBarRendered && (
        <BottomBar
          columns={terminalColumns}
          autoApproveCount={autoApproveCount}
          {...(ui.permissionOverlay ? { waitingTool: ui.permissionOverlay.toolName } : {})}
          bashCount={runtimeCounters.bash}
          subagentCount={runtimeCounters.subagents}
          currentSessionId={state.currentSessionId}
          {...(ctx.tenant?.tenant_id ? { tenantId: ctx.tenant.tenant_id } : {})}
          queuedCount={ui.queuedInput.length}
          queuePreviewVisible={ui.queuedInput.length > 0}
        />
      )}

      {/* 底部快捷键提示（无下栏且 rows >= 18 时显示；下栏已吸收该行） */}
      {!bottomBarRendered && !exclusiveOverlayActive && layout.hintRows > 0 && (
        <Box flexShrink={0} paddingX={2}>
          <Text color={theme.faint}>{t('repl.bottomHint')}</Text>
        </Box>
      )}

      {/* 内联命令补全（输入框下方） */}
      {showAutocomplete && (
        <Box flexDirection="column" flexShrink={0}>
          <InlineAutocomplete
            commands={allCommands}
            filter={commandFilter}
            selectedIndex={ui.autocompleteIndex}
            maxVisible={layout.autocompleteMax}
            recent={ui.recentCommands}
          />
        </Box>
      )}
    </Box>
  );
}

/**
 * Ink 版本的 startRepl
 * 保持与 readline 版本相同的函数签名
 *
 * 支持 TTY 和非 TTY 环境：
 * - TTY：使用完整的 Ink UI
 * - 非 TTY：使用简单的行模式（兼容管道输入）
 */
export async function startInkRepl(ctx: ReplContext): Promise<void> {
  const uiConfig = (ctx.config as { ui?: { language?: string; clearOnStart?: boolean } }).ui;
  const configLanguage = uiConfig?.language;
  setLocale(
    resolveLocale({
      env: process.env,
      ...(configLanguage ? { configLanguage } : {}),
    }),
  );

  // 非 TTY 环境（如管道输入）使用简单的行模式
  if (!process.stdin.isTTY) {
    await runSimpleMode(ctx);
    return;
  }

  // 进入清屏：仅 TTY 且 ui.clearOnStart !== false（DECISION-021 §3.1）。
  maybeClearOnStart({
    isTTY: Boolean(process.stdin.isTTY),
    clearOnStart: uiConfig?.clearOnStart,
    write: (text) => process.stdout.write(text),
  });

  // TTY 环境使用完整的 Ink UI
  let exitedViaCommand = false;
  // /clear 与 Ctrl+L 必须先走 Ink 实例的 clear()（重置 previousLineCount），
  // 再写 scrollback 清屏序列；不能在 Ink 挂载期间直接 stdout.write。
  let clearScreen = () => {};
  const instance = render(
    <InkRepl
      ctx={ctx}
      onExitCommand={() => {
        exitedViaCommand = true;
      }}
      clearScreen={() => clearScreen()}
    />,
  );
  clearScreen = () => {
    instance.clear();
    process.stdout.write(CLEAR_SCROLLBACK_SEQUENCE);
  };
  await instance.waitUntilExit();
  // /exit：Ink 已 unmount，先清掉最后一帧 live UI（状态栏 / 输入框 / 补全框），
  // 再单独写一次 Goodbye，避免被状态框和提示行夹住。Ctrl+C 退出不打印（保持原行为）。
  if (exitedViaCommand) {
    instance.clear();
    process.stdout.write(GOODBYE_TEXT);
  }
}

/**
 * 简单行模式（非 TTY 环境）
 *
 * 当 stdin 不是 TTY 时（如管道输入），使用简单的行模式
 * 避免 Ink 的 raw mode 错误
 */
async function runSimpleMode(ctx: ReplContext): Promise<void> {
  const { createCommands, consumePendingResume } = await import('../commands/commands.js');
  const { classifyError, formatClassifiedError } = await import('../error-classifier.js');

  let commands = createCommands();
  const state = {
    currentSessionId: ctx.currentSessionId,
    pendingResume: false,
    showResumePicker: false,
    running: true,
  };

  console.log(t('repl.simpleHeader', { provider: ctx.provider.name, model: ctx.provider.model }));
  console.log(t('repl.simpleSession', { id: state.currentSessionId }));
  console.log(t('repl.simplePrompt'));
  console.log(glyph.rule.repeat(48));

  // 启动横幅（simple mode 同样适用；headless / serve 不经过这里）
  const startupNotice = await loadStartupNotice(ctx);
  if (startupNotice) console.log(startupNotice);

  const lines: string[] = [];
  let lineIndex = 0;

  // 从 stdin 读取所有行
  const stdinText = await Bun.stdin.text();
  lines.push(...stdinText.split('\n').filter((l) => l.trim()));

  const nextLine = (): string | null => {
    if (lineIndex >= lines.length) return null;
    return lines[lineIndex++] ?? null;
  };

  while (state.running) {
    const line = nextLine();
    if (line === null) break;

    const trimmed = line.trim();
    if (!trimmed) continue;

    // 处理 /session resume 的 pending one-shot
    if (state.pendingResume) {
      if (/^\d+$/.test(trimmed)) {
        try {
          const resumeResult = await consumePendingResume(trimmed, ctx, state);
          if (resumeResult.output) {
            console.log(resumeResult.output);
          }
          if (resumeResult.history?.length) {
            console.log(resumeResult.history.join('\n'));
          }
        } catch (error) {
          console.error(formatRpcError(error));
          state.pendingResume = false;
        }
        continue;
      }
      state.pendingResume = false;
    }

    // 处理命令
    if (trimmed.startsWith('/')) {
      const result = await commands.execute(trimmed.slice(1), ctx, state);
      // /settings 切换后重建注册表，后续 /help 的 description 跟随新 locale。
      if (result.localeChanged) commands = createCommands();
      if (result.clearScreen) {
        console.clear();
      }
      if (result.exit) {
        // 简单模式没有 Ink live frame：直接按原措辞打印一次 goodbye。
        console.log(GOODBYE_TEXT);
      } else if (result.output) {
        console.log(result.output);
      } else if (result.view) {
        // 非 TTY 没有 Ink：用稳定的纯文本 fallback（命令忘记写 output 也不静默）。
        console.log(renderViewAsText(result.view.view));
      }
      if (result.history?.length) {
        console.log(result.history.join('\n'));
      }
      if (result.resumeRun) {
        const abort = new AbortController();
        const outcome = await executeResume(result.resumeRun, abort);
        if (outcome.status === 'cancelled') {
          console.log(t('common.cancelled'));
        } else if (outcome.status === 'failed') {
          console.error(formatClassifiedError(classifyError(outcome.error)));
        }
      }
      if (!result.handled) {
        const name = trimmed.split(/\s+/)[0] ?? trimmed;
        console.log(t('repl.unknownCommand', { name }));
      }
      continue;
    }

    // 处理普通消息
    try {
      const branch = await getCurrentGitBranch();
      // `@path` 引用展开（C10）：与 TTY 路径同源，告警走 console
      const { messages, warnings } = collectFileReferences(trimmed);
      for (const warning of warnings) {
        console.log(warning);
      }
      const response = await ctx.runtime.run(trimmed, state.currentSessionId, { branch, messages });
      console.log(response);
    } catch (error) {
      console.error(formatClassifiedError(classifyError(error)));
    }
  }

  ctx.onExit();
}
