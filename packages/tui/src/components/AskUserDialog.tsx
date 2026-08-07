/**
 * AskUserDialog — Agent 多问题问答弹窗（slide 式）
 * @module @vessel/tui
 *
 * 支持：
 * - 一次问 1-4 个问题，Tab/←→ 切换（slide）
 * - 选择题（↑↓ 选择）+ 多选（Space）+ 默认"输入你自己的答案"选项
 * - 顶部 tab 显示每个问题的已答状态（✓/○）与进度
 * - 提交前确认页（Enter 确认 / Esc 返回）
 */

import { Box, type Key, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useState } from 'react';
import type {
  AskUserAnswer,
  AskUserQuestion,
} from '../../../../plugins/tools/ask-user/src/index.js';

export interface AskUserDialogProps {
  questions: AskUserQuestion[];
  onSubmit: (answers: AskUserAnswer[]) => void;
  onCancel: () => void;
}

/** 每个选择题末尾默认追加的自定义输入选项 */
const CUSTOM_OPTION = '输入你自己的答案';

interface AnswerState {
  selected: Set<string>;
  custom: string;
}

export function AskUserDialog({ questions, onSubmit, onCancel }: AskUserDialogProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [view, setView] = useState<'question' | 'review'>('question');
  const [selectIndex, setSelectIndex] = useState(0);
  const [customFocus, setCustomFocus] = useState(false);
  const [notice, setNotice] = useState('');
  const [answers, setAnswers] = useState<AnswerState[]>(() =>
    questions.map(() => ({ selected: new Set<string>(), custom: '' })),
  );

  const total = questions.length;
  const displayOptions =
    questions[currentIndex]?.options && questions[currentIndex].options.length > 0
      ? [...(questions[currentIndex].options as string[]), CUSTOM_OPTION]
      : null;
  const isChoice = displayOptions !== null;
  const inTextInput = customFocus || !isChoice;

  const updateAnswer = useCallback((index: number, updater: (prev: AnswerState) => AnswerState) => {
    setAnswers((prev) => prev.map((s, i) => (i === index ? updater(s) : s)));
  }, []);

  const isAnswered = useCallback(
    (index: number): boolean => {
      const s = answers[index];
      const q = questions[index];
      if (!s || !q) return false;
      if (!q.options) return s.custom.trim().length > 0;
      const normalSelected = [...s.selected].filter((o) => o !== CUSTOM_OPTION);
      const customFilled = s.custom.trim().length > 0;
      return normalSelected.length > 0 || customFilled;
    },
    [answers, questions],
  );

  const resolveAnswer = useCallback(
    (index: number): string => {
      const s = answers[index];
      const q = questions[index];
      if (!s || !q) return '';
      if (!q.options) return s.custom.trim();
      const normalSelected = [...s.selected].filter((o) => o !== CUSTOM_OPTION);
      const parts = [...normalSelected];
      if (s.custom.trim()) parts.push(s.custom.trim());
      return parts.join(', ');
    },
    [answers, questions],
  );

  const unansweredCount = questions.reduce((n, _, i) => (isAnswered(i) ? n : n + 1), 0);

  const handleSelect = useCallback(
    (index: number, option: string) => {
      updateAnswer(index, (prev) => {
        const multi = questions[index]?.multi_select ?? false;
        if (option === CUSTOM_OPTION) {
          if (multi) {
            const next = new Set(prev.selected);
            if (next.has(CUSTOM_OPTION)) next.delete(CUSTOM_OPTION);
            else next.add(CUSTOM_OPTION);
            return { selected: next, custom: prev.custom };
          }
          return {
            selected: prev.selected.has(CUSTOM_OPTION) ? new Set() : new Set([CUSTOM_OPTION]),
            custom: prev.custom,
          };
        }
        if (multi) {
          const next = new Set(prev.selected);
          if (next.has(option)) next.delete(option);
          else next.add(option);
          return { selected: next, custom: prev.custom };
        }
        return { selected: new Set([option]), custom: '' };
      });
    },
    [updateAnswer, questions],
  );

  const gotoNext = useCallback(() => {
    setCurrentIndex((i) => (i + 1) % total);
    setSelectIndex(0);
    setCustomFocus(false);
  }, [total]);

  const gotoPrev = useCallback(() => {
    setCurrentIndex((i) => (i - 1 + total) % total);
    setSelectIndex(0);
    setCustomFocus(false);
  }, [total]);

  const commitAndAdvance = useCallback(() => {
    if (currentIndex < total - 1) gotoNext();
    else {
      setView('review');
      setCustomFocus(false);
      setNotice('');
    }
  }, [currentIndex, total, gotoNext]);

  const submit = useCallback(() => {
    onSubmit(
      questions.map((q, i) => ({
        header: q.header,
        question: q.question,
        answer: resolveAnswer(i),
      })),
    );
  }, [questions, resolveAnswer, onSubmit]);

  // ── 键盘：确认页 ────────────────────────────────
  const handleReviewKey = useCallback(
    (key: Key) => {
      if (key.return) {
        if (unansweredCount === 0) submit();
        else setNotice(`还有 ${unansweredCount} 个问题未回答，请按 Esc 返回补充`);
      } else if (key.escape) {
        setView('question');
        setNotice('');
      }
    },
    [unansweredCount, submit],
  );

  // ── 键盘：问题页的选择导航 ───────────────────────
  const handleChoiceKey = useCallback(
    (inputChar: string, key: Key) => {
      if (!displayOptions) return;
      const customIndex = displayOptions.length - 1;

      if (key.upArrow) {
        setSelectIndex((i) => Math.max(0, i - 1));
        // 离开自定义输入项时退出输入模式（用户可回到选项导航）
        if (selectIndex === customIndex) setCustomFocus(false);
        return;
      }
      if (key.downArrow) {
        const next = Math.min(customIndex, selectIndex + 1);
        setSelectIndex(next);
        // 高亮到"输入你自己的答案"即自动进入输入，无需再按 Enter
        if (next === customIndex) {
          handleSelect(currentIndex, CUSTOM_OPTION);
          setCustomFocus(true);
        }
        return;
      }
      if (inputChar === ' ') {
        const option = displayOptions[selectIndex];
        if (option !== undefined) {
          handleSelect(currentIndex, option);
          // 多选：Space 勾选/取消，自定义选项切换输入框开关
          if (option === CUSTOM_OPTION) setCustomFocus((f) => !f);
        }
        return;
      }
      if (key.return) {
        if (questions[currentIndex]?.multi_select) {
          // 多选：Enter 提交整个问题
          commitAndAdvance();
          return;
        }
        const option = displayOptions[selectIndex];
        if (option !== undefined) {
          if (option === CUSTOM_OPTION) {
            // 单选下高亮自定义即已聚焦，此分支为 fallback
            handleSelect(currentIndex, option);
            setCustomFocus(true);
          } else {
            handleSelect(currentIndex, option);
            commitAndAdvance();
          }
        }
      }
    },
    [displayOptions, selectIndex, currentIndex, questions, handleSelect, commitAndAdvance],
  );

  // ── 键盘：问题页（导航 + 分派）──────────────────
  const handleQuestionKey = useCallback(
    (inputChar: string, key: Key) => {
      if (key.escape) {
        if (customFocus) setCustomFocus(false);
        else onCancel();
        return;
      }
      if (key.tab && key.shift) {
        gotoPrev();
        return;
      }
      if (key.tab) {
        gotoNext();
        return;
      }
      if ((key.ctrl && inputChar === 's') || inputChar === 'r') {
        setView('review');
        setNotice('');
        return;
      }
      // 左右箭头切换问题（文本输入模式下留给 TextInput 移动光标）
      if (!inTextInput && key.leftArrow) {
        gotoPrev();
        return;
      }
      if (!inTextInput && key.rightArrow) {
        gotoNext();
        return;
      }
      // 文本输入模式下其余按键交给 TextInput
      if (inTextInput) return;
      handleChoiceKey(inputChar, key);
    },
    [customFocus, onCancel, gotoNext, gotoPrev, inTextInput, handleChoiceKey],
  );

  useInput((inputChar, key) => {
    if (view === 'review') {
      handleReviewKey(key);
      return;
    }
    handleQuestionKey(inputChar, key);
  });

  // ── 自定义输入 / 开放式输入提交 ──────────────────
  const handleCustomSubmit = useCallback(
    (value: string) => {
      updateAnswer(currentIndex, (prev) => ({ ...prev, custom: value }));
      setCustomFocus(false);
      commitAndAdvance();
    },
    [currentIndex, updateAnswer, commitAndAdvance],
  );

  const handleFreeSubmit = useCallback(
    (value: string) => {
      updateAnswer(currentIndex, (prev) => ({ ...prev, custom: value }));
      commitAndAdvance();
    },
    [currentIndex, updateAnswer, commitAndAdvance],
  );

  const question = questions[currentIndex];
  if (!question) return null;
  const currentAnswer = answers[currentIndex] ?? { selected: new Set<string>(), custom: '' };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      {/* 标题行：标题 + 进度 */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">
          ❓ Agent Question
        </Text>
        <Text color="gray">
          {currentIndex + 1} / {total}
        </Text>
      </Box>

      {/* Tab 行：每个问题的已答状态 */}
      <Box marginBottom={1}>
        {questions.map((q, i) => {
          const isCurrent = i === currentIndex && view === 'question';
          const done = isAnswered(i);
          return (
            <Text
              key={q.header}
              backgroundColor={isCurrent ? 'cyan' : undefined}
              color={done ? 'green' : isCurrent ? 'black' : 'gray'}
              bold={isCurrent}
            >
              {` ${done ? '✓' : '○'} ${q.header} `}
            </Text>
          );
        })}
      </Box>

      {/* 确认页 */}
      {view === 'review' ? (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="cyan">
              📋 Review Your Answers
            </Text>
          </Box>
          {questions.map((q, i) => {
            const done = isAnswered(i);
            return (
              <Box key={q.header}>
                <Text>
                  {i + 1}. <Text bold>{q.header}</Text>
                  {done ? `: ${resolveAnswer(i)}` : ''}
                </Text>
                {!done && <Text color="yellow"> (未回答)</Text>}
              </Box>
            );
          })}
          <Box marginTop={1}>
            {unansweredCount > 0 ? (
              <Text color="yellow">⚠ {notice || `还有 ${unansweredCount} 个问题未回答`}</Text>
            ) : (
              <Text color="gray">[Enter] 确认提交 · [Esc] 返回修改</Text>
            )}
          </Box>
        </Box>
      ) : (
        /* 问题页 */
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text>{question.question}</Text>
          </Box>

          {/* 选择题 */}
          {isChoice && displayOptions && (
            <Box flexDirection="column" marginBottom={1}>
              {displayOptions.map((opt, i) => {
                const focused = i === selectIndex;
                const selected = currentAnswer.selected.has(opt);
                const isCustom = opt === CUSTOM_OPTION;
                const prefix = question.multi_select
                  ? selected
                    ? '[✓]'
                    : '[ ]'
                  : focused
                    ? '▶'
                    : ' ';

                // 自定义输入项：聚焦时该行本身就是输入框（placeholder 暗灰提示）
                if (isCustom && customFocus) {
                  return (
                    <Box key={opt} flexDirection="row">
                      <Text
                        backgroundColor={focused ? 'cyan' : undefined}
                        color={focused ? 'black' : selected ? 'green' : undefined}
                        bold={focused || selected}
                      >
                        {` ${prefix}`}
                      </Text>
                      <TextInput
                        placeholder="输入你自己的答案"
                        value={currentAnswer.custom}
                        onChange={(v) => updateAnswer(currentIndex, (p) => ({ ...p, custom: v }))}
                        onSubmit={handleCustomSubmit}
                      />
                    </Box>
                  );
                }

                // 自定义输入项：已填内容时在同一行展示答案
                if (isCustom && currentAnswer.custom.trim()) {
                  return (
                    <Text key={opt} color="green" bold>
                      {` ${prefix} 你的答案: ${currentAnswer.custom.trim()}`}
                    </Text>
                  );
                }

                return (
                  <Text
                    key={opt}
                    backgroundColor={focused ? 'cyan' : undefined}
                    color={focused ? 'black' : selected ? 'green' : undefined}
                    bold={focused || selected}
                  >
                    {` ${prefix} ${opt}`}
                  </Text>
                );
              })}
            </Box>
          )}

          {/* 开放式输入 */}
          {!isChoice && (
            <Box>
              <Text color="cyan">{'> '}</Text>
              <TextInput
                value={currentAnswer.custom}
                onChange={(v) => updateAnswer(currentIndex, (p) => ({ ...p, custom: v }))}
                onSubmit={handleFreeSubmit}
              />
            </Box>
          )}

          {/* 底部提示 */}
          <Box marginTop={1}>
            {customFocus || !isChoice ? (
              <Text color="gray">Enter 提交 · Tab 切换问题 · Esc 取消</Text>
            ) : (
              <Text color="gray">
                {question.multi_select
                  ? 'Space 勾选/取消 · Enter 提交 · Tab/←→ 切换问题 · Esc 取消'
                  : '↑↓ 选择 · Enter 确认 · Tab/←→ 切换问题 · Esc 取消'}
              </Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
