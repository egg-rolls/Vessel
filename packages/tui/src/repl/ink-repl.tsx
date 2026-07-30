/**
 * Ink REPL 主组件
 * @module @vessel/tui
 *
 * 用 Ink 框架替换 readline，实现 React 组件式终端 UI。
 * 保持 startRepl(ctx) 函数签名不变，壳不感知替换。
 */

import { Box, Text, render, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useState } from 'react';
import type { ReplState } from '../commands/commands.js';
import { createCommands } from '../commands/commands.js';
import { CommandMenu } from '../components/CommandMenu.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { SessionTable } from '../components/SessionTable.js';
import { StatusBar } from '../components/StatusBar.js';
import { StreamOutput } from '../components/StreamOutput.js';
import type { ReplContext } from '../repl-context.js';

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
    running: true,
  });
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [showSessionTable, setShowSessionTable] = useState(false);
  const [confirmQuestion, setConfirmQuestion] = useState<string | null>(null);
  const [confirmResolve, setConfirmResolve] = useState<((value: string) => void) | null>(null);

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

  // 处理输入
  const handleSubmit = useCallback(
    async (value: string) => {
      if (!value.trim()) return;

      setHistory((prev) => [...prev, `> ${value}`]);
      setInput('');

      // 处理 /resume pending one-shot
      if (state.pendingResume) {
        const num = Number.parseInt(value, 10);
        if (!Number.isNaN(num)) {
          // consumePendingResume 逻辑
          setState((prev) => ({ ...prev, pendingResume: false }));
          return;
        }
      }

      // 处理命令
      if (value.startsWith('/')) {
        const result = await commands.execute(value, ctx, state);
        if (result.handled) {
          // 特殊处理 /clear 命令 - 清空历史记录
          if (value.trim() === '/clear' || value.trim().startsWith('/clear ')) {
            setHistory([]);
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
      try {
        setHistory((prev) => [...prev, 'Thinking...']);
        const output = await ctx.runtime.run(value, state.currentSessionId);
        setHistory((prev) => [...prev.slice(0, -1), output]);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        setHistory((prev) => [...prev.slice(0, -1), `Error: ${errorMsg}`]);
      }
    },
    [ctx, state, commands],
  );

  // 键盘输入处理 - 只在没有其他交互组件时生效
  useInput((inputChar, key) => {
    // 如果有其他交互组件显示，不处理输入
    if (showCommandMenu || showSessionTable || confirmQuestion) {
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
        <Text key={`line-${line.substring(0, 20)}-${i}`}>{line}</Text>
      ))}

      {/* 流式输出 */}
      <StreamOutput events={ctx.events} />

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

      {/* 会话表格 */}
      {showSessionTable && (
        <SessionTable
          session={ctx.session}
          onSelect={(id) => {
            setShowSessionTable(false);
            setState((prev) => ({ ...prev, currentSessionId: id }));
          }}
          onClose={() => setShowSessionTable(false)}
        />
      )}

      {/* 确认对话框 */}
      {confirmQuestion && <ConfirmDialog question={confirmQuestion} onConfirm={handleConfirm} />}

      {/* 输入框 - 只在没有其他交互组件时显示 */}
      {!showCommandMenu && !showSessionTable && !confirmQuestion && (
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
 */
export async function startInkRepl(ctx: ReplContext): Promise<void> {
  const { waitUntilExit } = render(<InkRepl ctx={ctx} />);
  await waitUntilExit();
}
