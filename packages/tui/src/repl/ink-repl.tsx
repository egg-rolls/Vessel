/**
 * Ink REPL 主组件
 * @module @vessel/tui
 *
 * 用 Ink 框架替换 readline，实现 React 组件式终端 UI。
 * 保持 startRepl(ctx) 函数签名不变，壳不感知替换。
 */

import type { SessionInfo } from '@vessel/core';
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReplState } from '../commands/commands.js';
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
import type { AskUserAnswer, AskUserPromptEvent } from '../renderer/ask-user.js';
import type { ReplContext } from '../repl-context.js';
import { getCurrentGitBranch } from '../utils/git.js';

interface InkReplProps {
  ctx: ReplContext;
}

/**
 * Ink REPL 主组件
 */
function InkRepl({ ctx }: InkReplProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<ReplState>({
    currentSessionId: ctx.currentSessionId,
    pendingResume: false,
    showResumePicker: false,
    running: true,
  });
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [resumeSessions, setResumeSessions] = useState<SessionInfo[]>([]);
  const [confirmQuestion, setConfirmQuestion] = useState<string | null>(null);
  const [confirmResolve, setConfirmResolve] = useState<((value: string) => void) | null>(null);
  const [clearSignal, setClearSignal] = useState(0); // /clear 命令信号
  const [inputCaretKey, setInputCaretKey] = useState(0); // 递增以强制 TextInput remount（光标复位到末尾）
  const [askUserOverlay, setAskUserOverlay] = useState<AskUserPromptEvent | null>(null);

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
  const commandFilter = input.startsWith('/') ? (input.slice(1).split(/\s+/)[0] ?? '') : '';
  const filteredCommands = useMemo(
    () => filterCommands(allCommands, commandFilter),
    [allCommands, commandFilter],
  );
  // 补全只在命令名阶段（/ 开头、尚未输入空格、非精确匹配）显示：
  // - 一旦输入空格进入参数输入即隐藏，避免 Tab/Enter 把已输入参数覆盖成命令名
  // - 精确匹配某命令名时隐藏补全框，改由 argHint 显示参数提示
  const isExactCommand = input.startsWith('/') && allCommands.some((cmd) => cmd.name === input);
  const showAutocomplete =
    input.startsWith('/') &&
    !input.includes(' ') &&
    !isExactCommand &&
    filteredCommands.length > 0 &&
    !askUserOverlay;

  // 参数占位提示：当输入精确匹配某命令名时，显示灰色参数提示（如 " [number|id]"）
  const argHint = useMemo(() => {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;
    const matched = allCommands.find((cmd) => cmd.name === trimmed);
    if (!matched?.usage) return null;
    const hint = matched.usage.slice(matched.name.length);
    return hint || null;
  }, [input, allCommands]);

  // 过滤词变化时重置选择索引
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when filteredCommands reference changes
  useEffect(() => {
    setAutocompleteIndex(0);
  }, [filteredCommands]);

  // 同步 currentSessionId 到 ctx（壳 / SSE bridge 等读 ctx.currentSessionId）
  useEffect(() => {
    ctx.currentSessionId = state.currentSessionId;
  }, [state.currentSessionId, ctx]);

  // 注入权限确认器的 promptFn
  useEffect(() => {
    if (ctx.permissionChecker) {
      ctx.permissionChecker.promptFn = (question: string) => {
        return new Promise<string>((resolve) => {
          setConfirmQuestion(question);
          setConfirmResolve(() => resolve);
        });
      };
    }
  }, [ctx.permissionChecker]);

  // 注入 ask-user bridge 的 onPrompt 回调
  useEffect(() => {
    if (ctx.askUserBridge) {
      ctx.askUserBridge.onPrompt = (event: AskUserPromptEvent) => {
        setAskUserOverlay(event);
      };
    }
  }, [ctx.askUserBridge]);

  // 当 showResumePicker 变为 true 时加载会话列表
  useEffect(() => {
    if (state.showResumePicker) {
      ctx.session.listRich().then((list) => {
        setResumeSessions(list);
      });
    }
  }, [state.showResumePicker, ctx.session]);

  // 处理输入（TextInput 的 onSubmit —— Enter 的唯一入口）
  // 注意：Ink 的 useInput 子组件先于父组件触发，且无法 stopPropagation，
  // 所以 Enter 的"补全 vs 执行"决策必须在此处（onSubmit）做，不能在 useInput 里做。
  const handleSubmit = useCallback(
    async (value: string) => {
      // 补全 case：输入是未完成的命令名 -> 补全到当前选中命令，不执行。
      // 用户再按一次 Enter 才执行。（决策逻辑见 decideCommandEnter，已单测覆盖）
      const decision = decideCommandEnter(value, allCommands, filteredCommands, autocompleteIndex);
      if (decision.action === 'complete') {
        setInput(decision.commandName);
        setInputCaretKey((prev) => prev + 1);
        return; // 仅补全，不执行
      }

      if (!value.trim()) return;

      setHistory((prev) => [...prev, `> ${value}`]);
      setInput('');

      // 处理 /resume pending one-shot（simple 模式 fallback；Ink 模式由 picker 接管）
      if (state.pendingResume && !state.showResumePicker) {
        const num = Number.parseInt(value, 10);
        if (!Number.isNaN(num)) {
          setState((prev) => ({ ...prev, pendingResume: false }));
          // Resolve the session by number and resume
          const sessions = await ctx.session.listRich();
          const target = sessions[num - 1];
          if (target) {
            const msg = await doResume(ctx, state, target.session_id);
            setState((prev) => ({ ...prev, currentSessionId: target.session_id }));
            setHistory((prev) => [...prev, msg]);
          }
          return;
        }
      }

      // 处理命令
      if (value.startsWith('/')) {
        const result = await commands.execute(value, ctx, state);
        if (result.handled) {
          // 特殊处理 /clear 命令 - 清空历史记录和流式输出
          if (value.trim() === '/clear' || value.trim().startsWith('/clear ')) {
            setHistory([]);
            setClearSignal((prev) => prev + 1); // 触发 StreamOutput 清空
          } else if (result.output) {
            // 如果命令有输出，添加到历史记录
            const output = result.output;
            setHistory((prev) => [...prev, output]);
          }
          // 命令可能直接改了 state（showResumePicker/currentSessionId/running），
          // flush 到 React 触发重渲染（不可变更新）
          setState((prev) => ({ ...prev }));
          return;
        }

        // 未知命令：显示提示，不发 AI
        const [cmdName = value] = value.trim().split(/\s+/);
        setHistory((prev) => [
          ...prev,
          `Unknown command: ${cmdName}. Type /help for available commands.`,
        ]);
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
        setHistory((prev) => [...prev, `Error: ${errorMsg}`]);
      }
    },
    [ctx, state, commands, allCommands, filteredCommands, autocompleteIndex],
  );

  // 键盘输入处理（Tab/↑↓/Esc 在补全可见时拦截）
  // Enter 不在此处理：Ink 子组件 useInput 先于父组件、且无法 stopPropagation，
  // 故 Enter 统一交给 TextInput.onSubmit -> handleSubmit 决策（补全 or 执行）。
  useInput((inputChar, key) => {
    // ask-user 弹窗显示时，键盘交给 AskUserDialog 自己的 useInput
    if (askUserOverlay) return;

    if (showAutocomplete) {
      if (key.tab) {
        const selected = filteredCommands[autocompleteIndex];
        if (selected) {
          setInput(selected.name);
          setInputCaretKey((prev) => prev + 1);
        }
        setAutocompleteIndex(0);
        return;
      }
      if (key.upArrow) {
        setAutocompleteIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setAutocompleteIndex((prev) => Math.min(filteredCommands.length - 1, prev + 1));
        return;
      }
      if (key.escape) {
        setInput('');
        setAutocompleteIndex(0);
        return;
      }
      // Enter 不拦截：落到 TextInput.onSubmit -> handleSubmit
    }

    // 如果有其他独占交互组件显示，不处理其余输入
    if (state.showResumePicker || confirmQuestion) {
      return;
    }

    if (key.ctrl && inputChar === 'c') {
      exit();
      return;
    }

    if (key.ctrl && inputChar === 'l') {
      setHistory([]);
      return;
    }
  });

  // 确认对话框回调
  const handleConfirm = useCallback(
    (answer: string) => {
      setConfirmQuestion(null);
      if (confirmResolve) {
        confirmResolve(answer);
        setConfirmResolve(null);
      }
    },
    [confirmResolve],
  );

  // ask-user 对话框回调
  const handleAskUserSubmit = useCallback(
    (answers: AskUserAnswer[]) => {
      if (askUserOverlay) {
        ctx.askUserBridge?.respond(askUserOverlay.id, answers);
        setAskUserOverlay(null);
      }
    },
    [askUserOverlay, ctx.askUserBridge],
  );

  const handleAskUserCancel = useCallback(() => {
    if (askUserOverlay) {
      ctx.askUserBridge?.cancel(askUserOverlay.id);
      setAskUserOverlay(null);
    }
  }, [askUserOverlay, ctx.askUserBridge]);

  // StreamOutput 完成回调：将 AI 响应归档到 history
  const handleStreamComplete = useCallback((responseText: string) => {
    setHistory((prev) => [...prev, responseText]);
  }, []);

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
        {history.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: REPL history is append-only, items are never reordered
          <Text key={i}>{line}</Text>
        ))}
        <StreamOutput
          events={ctx.events}
          clearSignal={clearSignal}
          onComplete={handleStreamComplete}
        />
      </Box>

      {/* 底部固定区域：overlays + 输入框 + 补全框 */}
      {state.showResumePicker && (
        <SessionTable
          sessions={resumeSessions}
          currentSessionId={state.currentSessionId}
          onSelect={async (id) => {
            setState((prev) => ({ ...prev, showResumePicker: false, pendingResume: false }));
            setInput('');
            const msg = await doResume(ctx, state, id);
            setState((prev) => ({ ...prev, currentSessionId: id }));
            setHistory((prev) => [...prev, msg]);
          }}
          onClose={() => {
            setState((prev) => ({ ...prev, showResumePicker: false, pendingResume: false }));
          }}
        />
      )}

      {/* 确认对话框 */}
      {confirmQuestion && <ConfirmDialog question={confirmQuestion} onConfirm={handleConfirm} />}

      {/* ask-user 问答弹窗 */}
      {askUserOverlay && (
        <AskUserDialog
          questions={askUserOverlay.questions}
          onSubmit={handleAskUserSubmit}
          onCancel={handleAskUserCancel}
        />
      )}

      {/* 输入框 - 只在没有独占交互组件时显示 */}
      {!state.showResumePicker && !confirmQuestion && !askUserOverlay && (
        <Box>
          <Text color="cyan">vessel&gt; </Text>
          <TextInput
            key={inputCaretKey}
            value={input}
            onChange={setInput}
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
          selectedIndex={autocompleteIndex}
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
