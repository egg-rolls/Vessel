/**
 * Ink REPL 主组件
 * @module @vessel/tui
 *
 * 用 Ink 框架替换 readline，实现 React 组件式终端 UI。
 * 保持 startRepl(ctx) 函数签名不变，壳不感知替换。
 */

import type { SessionInfo } from '@vessel/core';
import { Box, render, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useState } from 'react';
import type { ReplState } from '../commands/commands.js';
import { createCommands, doResume } from '../commands/commands.js';
import { CommandMenu } from '../components/CommandMenu.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { SessionTable } from '../components/SessionTable.js';
import { StatusBar } from '../components/StatusBar.js';
import { StreamOutput } from '../components/StreamOutput.js';
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
  const [state, setState] = useState<ReplState>({
    currentSessionId: ctx.currentSessionId,
    pendingResume: false,
    showResumePicker: false,
    running: true,
  });
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [resumeSessions, setResumeSessions] = useState<SessionInfo[]>([]);
  const [confirmQuestion, setConfirmQuestion] = useState<string | null>(null);
  const [confirmResolve, setConfirmResolve] = useState<((value: string) => void) | null>(null);
  const [clearSignal, setClearSignal] = useState(0); // /clear 命令信号

  const commands = createCommands();

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

  // 当 showResumePicker 变为 true 时加载会话列表
  useEffect(() => {
    if (state.showResumePicker) {
      ctx.session.listRich().then((list) => {
        setResumeSessions(list);
      });
    }
  }, [state.showResumePicker, ctx.session]);

  // 处理输入
  const handleSubmit = useCallback(
    async (value: string) => {
      if (!value.trim()) return;

      setHistory((prev) => [...prev, `> ${value}`]);
      setInput('');

      // 处理 /resume pending one-shot (simple mode fallback)
      if (state.pendingResume && !state.showResumePicker) {
        const num = Number.parseInt(value, 10);
        if (!Number.isNaN(num)) {
          setState((prev) => ({ ...prev, pendingResume: false }));
          // Resolve the session by number and resume
          const sessions = await ctx.session.listRich();
          const target = sessions[num - 1];
          if (target) {
            await doResume(ctx, state, target.session_id);
            setState((prev) => ({ ...prev, currentSessionId: target.session_id }));
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
          setState((prev) => ({ ...prev, pendingResume: false }));
          return;
        }
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
    [ctx, state, commands],
  );

  // 键盘输入处理 - 只在没有其他交互组件时生效
  useInput((inputChar, key) => {
    // 如果有其他交互组件显示，不处理输入
    if (showCommandMenu || state.showResumePicker || confirmQuestion) {
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

    // 当输入为空时，按 / 显示命令菜单
    if (inputChar === '/' && !input) {
      setShowCommandMenu(true);
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
    <Box flexDirection="column">
      {/* 状态栏 */}
      <StatusBar provider={ctx.provider} session={state.currentSessionId} plugins={ctx.plugins} />

      {/* 历史记录 */}
      {history.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: REPL history is append-only, items are never reordered
        <Text key={i}>{line}</Text>
      ))}

      {/* 流式输出（当前轮） */}
      <StreamOutput
        events={ctx.events}
        clearSignal={clearSignal}
        onComplete={handleStreamComplete}
      />

      {/* 命令菜单 */}
      {showCommandMenu && (
        <CommandMenu
          commands={commands}
          onSelect={(cmd) => {
            setShowCommandMenu(false);
            setInput(`${cmd} `);
          }}
          onClose={() => setShowCommandMenu(false)}
        />
      )}

      {/* 交互式会话选择器（/resume 无参时） */}
      {state.showResumePicker && (
        <SessionTable
          sessions={resumeSessions}
          currentSessionId={state.currentSessionId}
          onSelect={async (id) => {
            setState((prev) => ({ ...prev, showResumePicker: false, pendingResume: false }));
            await doResume(ctx, state, id);
            setState((prev) => ({ ...prev, currentSessionId: id }));
          }}
          onClose={() => {
            setState((prev) => ({ ...prev, showResumePicker: false, pendingResume: false }));
          }}
        />
      )}

      {/* 确认对话框 */}
      {confirmQuestion && <ConfirmDialog question={confirmQuestion} onConfirm={handleConfirm} />}

      {/* 输入框 - 只在没有其他交互组件时显示 */}
      {!showCommandMenu && !state.showResumePicker && !confirmQuestion && (
        <Box>
          <Text color="cyan">vessel&gt; </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
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
