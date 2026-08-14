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
import { useCallback, useEffect, useMemo } from 'react';
import { createCommands, doResume } from '../commands/commands.js';
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
import type { ReplContext } from '../repl-context.js';
import { asTuiEvent } from '../types/events.js';
import { getCurrentGitBranch } from '../utils/git.js';
import { useReplState } from './use-repl-state.js';

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

  // 订阅权限确认请求（ADR-029：工具自带 checkPermission 或 runtime 'ask' 分支都发此事件）
  useEffect(() => {
    const unsubscribe = ctx.events.subscribe((rawEvent) => {
      const event = asTuiEvent(rawEvent);
      if (event.type !== 'tool.permission.request') return;
      dispatch({
        type: 'setPermissionOverlay',
        overlay: {
          requestId: event.data.requestId,
          run_id: event.run_id,
          toolName: event.data.tool,
        },
      });
    });
    return unsubscribe;
  }, [ctx.events, dispatch]);

  // 当 showResumePicker 变为 true 时加载会话列表
  useEffect(() => {
    if (state.showResumePicker) {
      ctx.session.listRich().then((list) => {
        dispatch({ type: 'setResumeSessions', sessions: list });
      });
    }
  }, [state.showResumePicker, ctx.session, dispatch]);

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

      dispatch({ type: 'appendHistory', line: `> ${value}` });
      dispatch({ type: 'setInput', input: '' });

      // 处理命令。命令是纯函数：execute 应用 nextState 到传入的 working 副本，
      // Ink 层再用 result.nextState 做不可变合并（不直接改 React state 对象）。
      if (value.startsWith('/')) {
        const result = await commands.execute(value, ctx, { ...state }, { print: false });
        if (result.handled) {
          // 特殊处理 /clear - 清空历史记录和流式输出（由命令的 clearScreen 标记驱动）
          if (result.clearScreen) {
            dispatch({ type: 'clearHistory' });
            dispatch({ type: 'bumpClearSignal' }); // 触发 StreamOutput 清空
          } else if (result.output) {
            // 如果命令有输出，添加到历史记录
            dispatch({ type: 'appendHistory', line: result.output });
          }
          if (result.nextState) {
            dispatch({ type: 'patchRepl', patch: result.nextState });
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
      // run 完成后通过 onComplete 回调将响应归档到 history
      try {
        const branch = await getCurrentGitBranch();
        await ctx.runtime.run(value, state.currentSessionId, { branch });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        dispatch({ type: 'appendHistory', line: `Error: ${errorMsg}` });
      }
    },
    [ctx, state, commands, allCommands, filteredCommands, ui.autocompleteIndex, dispatch],
  );

  // 键盘输入处理（Tab/↑↓/Esc 在补全可见时拦截）
  // Enter 不在此处理：Ink 子组件 useInput 先于父组件、且无法 stopPropagation，
  // 故 Enter 统一交给 TextInput.onSubmit -> handleSubmit 决策（补全 or 执行）。
  useInput((inputChar, key) => {
    // ask-user / 权限弹窗显示时，键盘交给弹窗组件自己的 useInput
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

    if (key.ctrl && inputChar === 'c') {
      exit();
      return;
    }

    if (key.ctrl && inputChar === 'l') {
      dispatch({ type: 'clearHistory' });
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

  // ask-user 弹窗激活状态回调（子组件汇报；稳定引用避免无谓 effect 重跑）
  const handleAskUserActive = useCallback(
    (active: boolean) => {
      dispatch({ type: 'setAskUserActive', active });
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
      {/* 状态栏（固定顶部） */}
      <StatusBar provider={ctx.provider} session={state.currentSessionId} plugins={ctx.plugins} />

      {/* 滚动区域：历史 + 流式输出，flexGrow 撑满剩余空间 */}
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
          question={`Allow tool "${ui.permissionOverlay.toolName}" to run?`}
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
  const { classifyError } = await import('../error-classifier.js');

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
        await consumePendingResume(trimmed, ctx, state);
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
      if (!result.handled) {
        const name = trimmed.split(/\s+/)[0] ?? trimmed;
        console.log(`Unknown command: ${name}. Type /help for available commands.`);
      }
      continue;
    }

    // 处理普通消息
    try {
      const branch = await getCurrentGitBranch();
      const response = await ctx.runtime.run(trimmed, state.currentSessionId, { branch });
      console.log(response);
    } catch (error) {
      const c = classifyError(error);
      if (c.hint) {
        console.error(`✗ [${c.category}] ${c.message}\n  ${c.hint}`);
      } else {
        console.error(`✗ [${c.category}] ${c.message}`);
      }
    }
  }

  ctx.onExit();
}
