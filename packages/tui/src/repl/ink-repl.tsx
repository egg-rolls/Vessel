/**
 * Ink REPL 主组件
 * @module @vessel/tui
 *
 * 用 Ink 框架替换 readline，实现 React 组件式终端 UI。
 * 保持 startRepl(ctx) 函数签名不变，壳不感知替换。
 *
 * 架构（审计后收敛）：全部 UI 状态收敛进 useReplState（useReducer），
 * 命令为纯函数（返回 output/nextState），Ink 层以不可变合并消费 nextState。
 */

import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createCommands, doResume } from '../commands/commands.js';
import { listSessions } from '../commands/sessions-command.js';
import { formatWorkflowOutcome } from '../commands/workflows-command.js';
import { AskUserDialog } from '../components/AskUserDialog.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  type CommandItem,
  decideCommandEnter,
  filterCommands,
  InlineAutocomplete,
} from '../components/InlineAutocomplete.js';
import { SessionTable } from '../components/SessionTable.js';
import { StatusBar } from '../components/StatusBar.js';
import { StreamOutput } from '../components/StreamOutput.js';
import { SubagentActivity } from '../components/SubagentActivity.js';
import { UpdateBanner } from '../components/UpdateBanner.js';
import { classifyError, formatClassifiedError } from '../error-classifier.js';
import { formatPermissionQuestion } from '../renderer/tool-confirm.js';
import type { ReplContext } from '../repl-context.js';
import { asTuiEvent } from '../types/events.js';
import { collectFileReferences } from '../utils/file-reference.js';
import { getCurrentGitBranch } from '../utils/git.js';
import { summarizeToolInput } from '../utils/tool-input-summary.js';
import { executeResume, executeTurn, executeWorkflow } from './run-turn.js';
import { loadStartupNotice } from './startup-notice.js';
import { useReplState } from './use-repl-state.js';

/** 与 core PermissionPolicy 一致的等待时限（ms） */
const PERMISSION_TIMEOUT_MS = 120_000;

/** 终端清屏：清可视区 + scrollback，并把光标移回左上 */
const CLEAR_SCREEN_SEQUENCE = '\x1b[2J\x1b[3J\x1b[H';

interface InkReplProps {
  ctx: ReplContext;
}

/**
 * Ink REPL 主组件
 */
function InkRepl({ ctx }: InkReplProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [ui, dispatch] = useReplState(ctx);
  const state = ui.repl;

  /** 权限弹窗超时计时器（与 core 的 120s 对齐） */
  const permissionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 运行中重复提交提示的节流时间戳 */
  const lastBusyNoticeRef = useRef(0);

  const commands = useMemo(() => createCommands(), []);

  // 预计算的命令列表（用于内联补全）
  const allCommands = useMemo<CommandItem[]>(() => {
    return commands.list().map((entry) => ({
      name: `/${entry.name}`,
      description: entry.description,
      usage: entry.usage,
    }));
  }, [commands]);

  // 从当前输入中提取命令过滤词（"/" 之后、第一个空格之前的命令名部分）
  const commandFilter = ui.input.startsWith('/') ? (ui.input.slice(1).split(/\s+/)[0] ?? '') : '';
  const filteredCommands = useMemo(
    () => filterCommands(allCommands, commandFilter),
    [allCommands, commandFilter],
  );
  // 补全只在命令名阶段（/ 开头、尚未输入空格、非精确匹配）显示：
  // - 一旦输入空格进入参数输入即隐藏，避免 Tab/Enter 把已输入参数覆盖成命令名
  // - 精确匹配某命令名时隐藏补全框，改由 argHint 显示参数提示
  const isExactCommand =
    ui.input.startsWith('/') && allCommands.some((cmd) => cmd.name === ui.input);
  const showAutocomplete =
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

  // 启动横幅（0.3）：仅在配置了 MCP server 或存在 interrupted run 时追加一行。
  // 查询失败静默，不阻塞启动。
  useEffect(() => {
    let disposed = false;
    void loadStartupNotice(ctx).then((line) => {
      if (!disposed && line) dispatch({ type: 'appendHistory', line });
    });
    return () => {
      disposed = true;
    };
  }, [ctx, dispatch]);

  // 权限确认请求（ADR-029）：展示弹窗 + 120s 超时兜底 + run 结束/工具失败清理。
  // core 的 waitFor 超时后只发 tool.call.failed，不会发 response；不清理会留下永久弹窗。
  useEffect(() => {
    const unsubscribe = ctx.events.subscribe((rawEvent) => {
      const event = asTuiEvent(rawEvent);
      switch (event.type) {
        case 'tool.permission.request': {
          if (permissionTimerRef.current) clearTimeout(permissionTimerRef.current);
          const expiresAt = Date.now() + PERMISSION_TIMEOUT_MS;
          permissionTimerRef.current = setTimeout(() => {
            permissionTimerRef.current = null;
            dispatch({ type: 'clearPermissionForRequest', requestId: event.data.requestId });
            dispatch({
              type: 'appendHistory',
              line: '⚠ Permission request timed out (120s); tool call was cancelled.',
            });
          }, PERMISSION_TIMEOUT_MS);
          dispatch({
            type: 'setPermissionOverlay',
            overlay: {
              requestId: event.data.requestId,
              run_id: event.run_id,
              toolName: event.data.tool,
              input: event.data.input,
              expiresAt,
            },
          });
          break;
        }
        case 'tool.call.failed':
          dispatch({
            type: 'clearPermissionForTool',
            runId: event.run_id,
            toolName: event.data.tool_name,
          });
          break;
        case 'run.completed':
        case 'run.failed':
          dispatch({ type: 'clearPermissionForRun', runId: event.run_id });
          break;
        default:
          break;
      }
    });
    return () => {
      if (permissionTimerRef.current) clearTimeout(permissionTimerRef.current);
      permissionTimerRef.current = null;
      unsubscribe();
    };
  }, [ctx.events, dispatch]);

  // 当 showResumePicker 变为 true 时加载会话列表
  useEffect(() => {
    if (state.showResumePicker) {
      listSessions(ctx).then((list) => {
        dispatch({ type: 'setResumeSessions', sessions: list });
      });
    }
  }, [state.showResumePicker, ctx, dispatch]);

  // 处理输入（TextInput 的 onSubmit —— Enter 的唯一入口）
  // 注意：Ink 的 useInput 子组件先于父组件触发，且无法 stopPropagation，
  // 所以 Enter 的"补全 vs 执行"决策必须在此处（onSubmit）做，不能在 useInput 里做。
  const handleSubmit = useCallback(
    async (value: string) => {
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

      // 运行中禁止第二次提交：AgentRuntime.run 会重置 stats 并共享 context，
      // 并发 run 会互相污染。只放行 /exit（它本来就要结束进程）。
      const isExitCommand = value.trim() === '/exit';
      if (ui.run.phase !== 'idle' && !isExitCommand) {
        const now = Date.now();
        if (now - lastBusyNoticeRef.current > 1500) {
          lastBusyNoticeRef.current = now;
          dispatch({
            type: 'appendHistory',
            line: '⏳ A run is in progress; press Esc to cancel before sending again.',
          });
        }
        return;
      }

      dispatch({ type: 'appendHistory', line: `> ${value}` });
      dispatch({ type: 'setInput', input: '' });

      // 处理命令。命令是纯函数：execute 应用 nextState 到传入的 working 副本，
      // Ink 层再用 result.nextState 做不可变合并（不直接改 React state 对象）。
      if (value.startsWith('/')) {
        const result = await commands.execute(value, ctx, { ...state });
        if (result.handled) {
          // 特殊处理 /clear - 清终端（含 scrollback）+ 历史记录 + 流式输出
          if (result.clearScreen) {
            stdout.write(CLEAR_SCREEN_SEQUENCE);
            dispatch({ type: 'clearHistory' });
            dispatch({ type: 'bumpClearSignal' }); // 触发 StreamOutput 清空
          } else if (result.output) {
            // 如果命令有输出，添加到历史记录
            dispatch({ type: 'appendHistory', line: result.output });
          }
          if (result.nextState) {
            dispatch({ type: 'patchRepl', patch: result.nextState });
          }
          // /runs resume：复用既有运行态（runStart/runEnd），Esc / Ctrl+C 走同一取消路径。
          if (result.resumeRun) {
            const handle = result.resumeRun;
            const abort = new AbortController();
            dispatch({ type: 'runStart', abort });
            const outcome = await executeResume(handle, abort);
            if (outcome.status === 'cancelled') {
              dispatch({ type: 'appendHistory', line: '⏹ Cancelled.' });
            } else if (outcome.status === 'failed') {
              dispatch({
                type: 'appendHistory',
                line: formatClassifiedError(classifyError(outcome.error)),
              });
            }
            dispatch({ type: 'runEnd' });
          }
          // /workflows run|resume：阻塞等待 done；Esc / Ctrl+C 走同一 abort -> cancel(id)。
          if (result.workflowRun) {
            const abort = new AbortController();
            dispatch({ type: 'runStart', abort });
            const outcome = await executeWorkflow(result.workflowRun, abort);
            dispatch({
              type: 'appendHistory',
              line: formatWorkflowOutcome(result.workflowRun.workflowRunId, outcome),
            });
            dispatch({ type: 'runEnd' });
          }
          return;
        }

        // 未知命令：显示提示，不发 AI
        const [cmdName = value] = value.trim().split(/\s+/);
        dispatch({
          type: 'appendHistory',
          line: `Unknown command: ${cmdName}. Type /help for available commands.`,
        });
        return;
      }

      // 处理普通消息 - 调用 runtime.run
      // StreamOutput 组件通过事件流显示 token-by-token 输出，
      // run 完成后通过 onComplete 回调将响应归档到 history。
      // signal 来自本轮 AbortController：Esc / 运行中 Ctrl+C 会中断它。
      const abort = new AbortController();
      dispatch({ type: 'runStart', abort });
      try {
        const branch = await getCurrentGitBranch();
        // `@path` 引用展开（C10）：扫到的文件读为注入消息，用户原文不变
        const { messages, warnings, references } = collectFileReferences(value);
        for (const warning of warnings) {
          dispatch({ type: 'appendHistory', line: warning });
        }
        for (const ref of references) {
          dispatch({
            type: 'appendHistory',
            line: `📎 @${ref.path} (${ref.bytes} bytes${ref.truncated ? ', truncated' : ''})`,
          });
        }
        const outcome = await executeTurn({
          abort,
          run: (signal) =>
            ctx.runtime.run(value, state.currentSessionId, { branch, messages, signal }),
        });
        if (outcome.status === 'cancelled') {
          dispatch({ type: 'appendHistory', line: '⏹ Cancelled.' });
        } else if (outcome.status === 'failed') {
          dispatch({
            type: 'appendHistory',
            line: formatClassifiedError(classifyError(outcome.error)),
          });
        }
      } catch (error) {
        // 只可能是 run 之前的准备工作（git 分支、文件扫描）失败
        dispatch({
          type: 'appendHistory',
          line: formatClassifiedError(classifyError(error)),
        });
      } finally {
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
      stdout,
      dispatch,
    ],
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
   *   再 abort；否则 waitFor 会让 run 卡到 120s 超时才结束。
   */
  const cancelOrExit = useCallback(() => {
    // idle -> 退出；cancelling 时再次 Ctrl+C -> 强制退出（工具可能还在跑）
    if (ui.run.phase === 'idle' || ui.run.phase === 'cancelling') {
      exit();
      return;
    }
    if (ui.permissionOverlay) {
      ctx.events.publish({
        type: 'tool.permission.response',
        run_id: ui.permissionOverlay.run_id,
        data: { requestId: ui.permissionOverlay.requestId, decision: 'deny' },
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
  }, [ui, ctx.events, dispatch, exit, cancelRun]);

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
      stdout.write(CLEAR_SCREEN_SEQUENCE);
      // TextInput 不忽略 Ctrl+L，会先把 'l' 插进输入；用当前值覆盖并重置光标
      dispatch({ type: 'setInput', input: ui.input });
      dispatch({ type: 'bumpCaret' });
      dispatch({ type: 'clearHistory' });
      dispatch({ type: 'bumpClearSignal' });
      return;
    }

    // ask-user / 权限弹窗显示时，其余键盘交给弹窗组件自己的 useInput
    if (ui.askUserActive || ui.permissionOverlay) return;

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
      const always = answer === 'always';
      ctx.events.publish({
        type: 'tool.permission.response',
        run_id: overlay.run_id,
        data: {
          requestId: overlay.requestId,
          decision: answer === 'y' || always ? 'allow' : 'deny',
          // "always" → 记住批准（runtime 维护 approvedTools，后续同工具免确认）
          remember: always,
        },
        ts: Date.now(),
      });
      dispatch({ type: 'setPermissionOverlay', overlay: null });
    },
    [ui.permissionOverlay, ctx.events, dispatch],
  );

  // ask-user 弹窗激活状态回调（子组件汇报 requestId/runId，供 Ctrl+C 主动解除 waitFor）
  const handleAskUserActive = useCallback(
    (active: boolean, requestId?: string, runId?: string) => {
      dispatch({ type: 'setAskUserActive', active, requestId, runId });
    },
    [dispatch],
  );

  // StreamOutput 完成回调：将 AI 响应归档到 history
  const handleStreamComplete = useCallback(
    (responseText: string) => {
      dispatch({ type: 'appendHistory', line: responseText });
    },
    [dispatch],
  );

  // 退出处理
  useEffect(() => {
    if (!state.running) {
      ctx.onExit();
      exit();
    }
  }, [state.running, ctx, exit]);

  return (
    <Box flexDirection="column" height={stdout.rows}>
      {/* 状态栏（固定顶部） + 更新提示（asm 发布 update.available 时出现） */}
      <StatusBar
        provider={ctx.provider}
        session={state.currentSessionId}
        plugins={ctx.plugins}
        {...(ctx.tenant ? { tenant: ctx.tenant.tenant_id } : {})}
      />
      <UpdateBanner events={ctx.events} />

      {/* 滚动区域：历史 + 流式输出 + 子 agent 活动，flexGrow 撑满剩余空间 */}
      <Box flexDirection="column" flexGrow={1}>
        {ui.history.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: REPL history is append-only, items are never reordered
          <Text key={i}>{line}</Text>
        ))}
        <StreamOutput
          events={ctx.events}
          clearSignal={ui.clearSignal}
          onComplete={handleStreamComplete}
        />
        <SubagentActivity events={ctx.events} />
      </Box>

      {/* 底部固定区域：overlays + 输入框 + 补全框 */}
      {state.showResumePicker && (
        <SessionTable
          sessions={ui.resumeSessions}
          currentSessionId={state.currentSessionId}
          onSelect={async (id) => {
            dispatch({
              type: 'patchRepl',
              patch: { showResumePicker: false, pendingResume: false },
            });
            dispatch({ type: 'setInput', input: '' });
            const { message, nextState } = await doResume(ctx, id);
            dispatch({ type: 'patchRepl', patch: nextState });
            dispatch({ type: 'appendHistory', line: message });
          }}
          onClose={() => {
            dispatch({
              type: 'patchRepl',
              patch: { showResumePicker: false, pendingResume: false },
            });
          }}
        />
      )}

      {/* 权限确认对话框（ADR-029：订阅 tool.permission.request，发布 response） */}
      {ui.permissionOverlay && (
        <ConfirmDialog
          question={formatPermissionQuestion(
            ui.permissionOverlay.toolName,
            ctx.mcp?.toolSource(ui.permissionOverlay.toolName) ?? null,
          )}
          details={summarizeToolInput(ui.permissionOverlay.toolName, ui.permissionOverlay.input)}
          defaultChoice="n"
          expiresAt={ui.permissionOverlay.expiresAt}
          onConfirm={handlePermission}
        />
      )}

      {/* ask-user 问答弹窗（自身订阅 ask.user.requested / 发布 answered） */}
      <AskUserDialog events={ctx.events} onActiveChange={handleAskUserActive} />

      {/* 输入框 - 只在没有独占交互组件时显示 */}
      {!state.showResumePicker && !ui.permissionOverlay && !ui.askUserActive && (
        <Box>
          <Text color="cyan">vessel&gt; </Text>
          <TextInput
            key={ui.inputCaretKey}
            value={ui.input}
            onChange={(value) => dispatch({ type: 'setInput', input: value })}
            onSubmit={handleSubmit}
          />
          {argHint && <Text color="gray">{argHint}</Text>}
        </Box>
      )}

      {/* 运行态提示：输入框保持可用（可先打字），但 Enter 不会并发提交 */}
      {ui.run.phase !== 'idle' &&
        !state.showResumePicker &&
        !ui.permissionOverlay &&
        !ui.askUserActive && (
          <Text color="yellow">
            {ui.run.phase === 'cancelling' ? '⏳ cancelling…' : '⏳ running… Esc to cancel'}
          </Text>
        )}

      {/* 内联命令补全（输入框下方） */}
      {showAutocomplete && (
        <InlineAutocomplete
          commands={allCommands}
          filter={commandFilter}
          selectedIndex={ui.autocompleteIndex}
        />
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
  // 非 TTY 环境（如管道输入）使用简单的行模式
  if (!process.stdin.isTTY) {
    await runSimpleMode(ctx);
    return;
  }

  // TTY 环境使用完整的 Ink UI
  const { waitUntilExit } = render(<InkRepl ctx={ctx} />);
  await waitUntilExit();
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

  const commands = createCommands();
  const state = {
    currentSessionId: ctx.currentSessionId,
    pendingResume: false,
    showResumePicker: false,
    running: true,
  };

  console.log(`Vessel  ·  ${ctx.provider.name} | ${ctx.provider.model}`);
  console.log(`session: ${state.currentSessionId}`);
  console.log('Type your message, or /help for commands.\n');

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
        const resumeResult = await consumePendingResume(trimmed, ctx, state);
        if (resumeResult.output) {
          console.log(resumeResult.output);
        }
        continue;
      }
      state.pendingResume = false;
    }

    // 处理命令
    if (trimmed.startsWith('/')) {
      const result = await commands.execute(trimmed.slice(1), ctx, state);
      if (result.clearScreen) {
        console.clear();
      }
      if (result.output) {
        console.log(result.output);
      }
      if (result.resumeRun) {
        const abort = new AbortController();
        const outcome = await executeResume(result.resumeRun, abort);
        if (outcome.status === 'cancelled') {
          console.log('⏹ Cancelled.');
        } else if (outcome.status === 'failed') {
          console.error(formatClassifiedError(classifyError(outcome.error)));
        }
      }
      if (result.workflowRun) {
        const abort = new AbortController();
        const outcome = await executeWorkflow(result.workflowRun, abort);
        console.log(formatWorkflowOutcome(result.workflowRun.workflowRunId, outcome));
      }
      if (!result.handled) {
        const name = trimmed.split(/\s+/)[0] ?? trimmed;
        console.log(`Unknown command: ${name}. Type /help for available commands.`);
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
