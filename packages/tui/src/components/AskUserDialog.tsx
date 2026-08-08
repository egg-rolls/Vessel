/**
 * AskUserDialog — Agent 多问题问答弹窗（slide 式）
 * @module @vessel/tui
 *
 * ADR-029：组件间交流全走事件流——本组件订阅 `ask.user.requested` 展示问题，
 * 用户作答后发布 `ask.user.answered`（answers 为空 = 用户取消）。
 *
 * 支持：
 * - 一次问 1-4 个问题，Tab/←→ 切换（slide）
 * - 选择题（↑↓ 选择）+ 多选（Space）+ 默认"输入你自己的答案"选项
 * - 顶部 tab 显示每个问题的已答状态（✓/○）与进度
 * - 提交前确认页（Enter 确认 / Esc 返回）
 *
 * 结构：主组件持有状态与键盘分发，纯展示部分拆为 QuestionTabs /
 * ReviewPage / ChoiceOptions 子组件。
 */

import type { EventStream } from '@vessel/core';
import { Box, type Key, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useState } from 'react';
import {
  type AskUserAnswer,
  AskUserEvent,
  type AskUserQuestion,
  type AskUserRequestedData,
} from '../renderer/ask-user.js';

export interface AskUserDialogProps {
  /** 事件流——订阅 ask.user.requested，发布 ask.user.answered */
  events: EventStream;
  /** 激活状态变化回调（父组件用它隐藏输入框、拦截按键） */
  onActiveChange?: (active: boolean) => void;
}

/** 每个选择题末尾默认追加的自定义输入选项 */
const CUSTOM_OPTION = '输入你自己的答案';

interface AnswerState {
  selected: Set<string>;
  custom: string;
}

/** 活跃请求状态 */
interface ActivePrompt extends AskUserRequestedData {
  run_id: string;
}

// ── 子组件：顶部 Tab 行 ──────────────────────────

function QuestionTabs({
  questions,
  currentIndex,
  isReview,
  isAnswered,
}: {
  questions: AskUserQuestion[];
  currentIndex: number;
  isReview: boolean;
  isAnswered: (i: number) => boolean;
}) {
  return (
    <Box marginBottom={1}>
      {questions.map((q, i) => {
        const isCurrent = i === currentIndex && !isReview;
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
  );
}

// ── 子组件：确认页 ───────────────────────────────

function ReviewPage({
  questions,
  resolveAnswer,
  isAnswered,
  unansweredCount,
  notice,
}: {
  questions: AskUserQuestion[];
  resolveAnswer: (i: number) => string;
  isAnswered: (i: number) => boolean;
  unansweredCount: number;
  notice: string;
}) {
  return (
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
  );
}

// ── 子组件：选择题选项（含自定义输入行）────────────

function ChoiceOptions({
  options,
  selected,
  custom,
  multiSelect,
  selectIndex,
  customFocus,
  onCustomChange,
  onCustomSubmit,
}: {
  options: string[];
  selected: Set<string>;
  custom: string;
  multiSelect: boolean;
  selectIndex: number;
  customFocus: boolean;
  onCustomChange: (v: string) => void;
  onCustomSubmit: (v: string) => void;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {options.map((opt, i) => {
        const focused = i === selectIndex;
        const isSelected = selected.has(opt);
        const isCustom = opt === CUSTOM_OPTION;
        const prefix = multiSelect ? (isSelected ? '[✓]' : '[ ]') : focused ? '▶' : ' ';

        // 自定义输入项：聚焦时该行本身就是输入框（placeholder 暗灰提示）
        if (isCustom && customFocus) {
          return (
            <Box key={opt} flexDirection="row">
              <Text
                backgroundColor={focused ? 'cyan' : undefined}
                color={focused ? 'black' : isSelected ? 'green' : undefined}
                bold={focused || isSelected}
              >
                {` ${prefix}`}
              </Text>
              <TextInput
                placeholder="输入你自己的答案"
                value={custom}
                onChange={onCustomChange}
                onSubmit={onCustomSubmit}
              />
            </Box>
          );
        }

        // 自定义输入项：已填内容时在同一行展示答案
        if (isCustom && custom.trim()) {
          return (
            <Text key={opt} color="green" bold>
              {` ${prefix} 你的答案: ${custom.trim()}`}
            </Text>
          );
        }

        return (
          <Text
            key={opt}
            backgroundColor={focused ? 'cyan' : undefined}
            color={focused ? 'black' : isSelected ? 'green' : undefined}
            bold={focused || isSelected}
          >
            {` ${prefix} ${opt}`}
          </Text>
        );
      })}
    </Box>
  );
}

// ── 主组件 ───────────────────────────────────────

export function AskUserDialog({ events, onActiveChange }: AskUserDialogProps) {
  const [prompt, setPrompt] = useState<ActivePrompt | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [view, setView] = useState<'question' | 'review'>('question');
  const [selectIndex, setSelectIndex] = useState(0);
  const [customFocus, setCustomFocus] = useState(false);
  const [notice, setNotice] = useState('');
  const [answers, setAnswers] = useState<AnswerState[]>([]);

  // 订阅 ask.user.requested：收到即展示问题（事件流取代回调注入，ADR-029）
  useEffect(() => {
    const unsubscribe = events.subscribe((event) => {
      if (event.type !== AskUserEvent.Requested) return;
      const data = event.data as unknown as AskUserRequestedData;
      setPrompt({ ...data, run_id: event.run_id });
      setCurrentIndex(0);
      setView('question');
      setSelectIndex(0);
      setCustomFocus(false);
      setNotice('');
      setAnswers(data.questions.map(() => ({ selected: new Set<string>(), custom: '' })));
    });
    return unsubscribe;
  }, [events]);

  // 通知父组件激活状态（隐藏输入框、拦截按键）
  useEffect(() => {
    onActiveChange?.(prompt !== null);
  }, [prompt, onActiveChange]);

  const questions = prompt?.questions ?? [];
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

  /** 发布 ask.user.answered（answers 为空 = 取消，工具 handler 返回错误） */
  const publishAnswers = useCallback(
    (promptRef: ActivePrompt, payload: AskUserAnswer[]) => {
      events.publish({
        type: AskUserEvent.Answered,
        run_id: promptRef.run_id,
        data: { requestId: promptRef.requestId, answers: payload },
        ts: Date.now(),
      });
      setPrompt(null);
    },
    [events],
  );

  const submit = useCallback(() => {
    if (!prompt) return;
    publishAnswers(
      prompt,
      questions.map((q, i) => ({
        header: q.header,
        question: q.question,
        answer: resolveAnswer(i),
      })),
    );
  }, [prompt, questions, resolveAnswer, publishAnswers]);

  const cancel = useCallback(() => {
    if (prompt) publishAnswers(prompt, []);
  }, [prompt, publishAnswers]);

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
        if (selectIndex === customIndex) {
          setCustomFocus(false);
          // 未输入内容则清除自定义选中残留，避免视觉上误标已答
          if (!answers[currentIndex]?.custom.trim()) handleSelect(currentIndex, CUSTOM_OPTION);
        }
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
    [displayOptions, selectIndex, currentIndex, answers, questions, handleSelect, commitAndAdvance],
  );

  // ── 键盘：问题页（导航 + 分派）──────────────────
  const handleQuestionKey = useCallback(
    (inputChar: string, key: Key) => {
      if (key.escape) {
        if (customFocus) setCustomFocus(false);
        else cancel();
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
      // 前往确认页：仅选项导航模式（文本输入时字母 'r' 会落入输入框，不能当快捷键）
      if (!inTextInput && ((key.ctrl && inputChar === 's') || inputChar === 'r')) {
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
    [customFocus, cancel, gotoNext, gotoPrev, inTextInput, handleChoiceKey],
  );

  // 仅在活跃时接管键盘（isActive：prompt 非空才注册）
  useInput(
    (inputChar, key) => {
      if (view === 'review') {
        handleReviewKey(key);
        return;
      }
      handleQuestionKey(inputChar, key);
    },
    { isActive: prompt !== null },
  );

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

  if (!prompt) return null;
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

      <QuestionTabs
        questions={questions}
        currentIndex={currentIndex}
        isReview={view === 'review'}
        isAnswered={isAnswered}
      />

      {view === 'review' ? (
        <ReviewPage
          questions={questions}
          resolveAnswer={resolveAnswer}
          isAnswered={isAnswered}
          unansweredCount={unansweredCount}
          notice={notice}
        />
      ) : (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text>{question.question}</Text>
          </Box>

          {/* 选择题 */}
          {isChoice && displayOptions ? (
            <ChoiceOptions
              options={displayOptions}
              selected={currentAnswer.selected}
              custom={currentAnswer.custom}
              multiSelect={question.multi_select ?? false}
              selectIndex={selectIndex}
              customFocus={customFocus}
              onCustomChange={(v) => updateAnswer(currentIndex, (p) => ({ ...p, custom: v }))}
              onCustomSubmit={handleCustomSubmit}
            />
          ) : (
            /* 开放式输入 */
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
