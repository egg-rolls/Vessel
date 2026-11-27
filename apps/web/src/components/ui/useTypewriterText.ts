/**
 * 流式打字机 reveal（流式平滑化 A，用户裁定参考豆包 Doubao 的 typewriter 设计）。
 *
 * ## 设计（参考豆包 / 业界平滑吐字算法）
 *
 * 网络 chunk 的到达节奏不均匀（TCP 分包合并一次涌入几十字、模型停顿又几百毫秒），
 * 直接渲染就是「忽快忽慢、一块一块」。豆包式做法把**数据到达**与**屏幕渲染**解耦：
 *
 * - 缓冲：上游提交的前缀（event-store 50ms 合批后的最新文本）是目标，已显示长度是
 *   游标，差值即积压（backlog）—— 前缀字符串本身就是队列，不需要显式字符数组；
 * - rAF 泵：每帧按自适应速率释放若干字符（不是逐 delta setState —— 上游 50ms 一
 *   flush，逐 delta 必抖；这里是渲染侧自己的节拍，与到达节拍无关）；
 * - 自适应速率：speed = clamp(backlog / 追赶时长, 下限, 上限)。积压少慢慢吐（保持
 *   活态感），积压多平滑提速（~0.5s 追平，不落后于实际流速）；巨量积压（换会话 /
 *   回放撞上的整段历史）直接对齐，不做回放动画。
 *
 * ## 契约（motion.css ③ 的修订，用户已授权 A 参考豆包破例）
 *
 * 原契约「严禁按 delta / 定时器逐块逐字 setState 播动画」修订为：**禁止逐 delta /
 * 定时器驱动**，允许 rAF 缓冲 reveal（本 hook）。配套成本约束：正文侧必须增量解析
 * （只重解析尾块，前缀块引用复用 + memo），见 Markdown.tsx；思考卡纯文本无 parse
 * 成本，直接消费本 hook。
 *
 * ## 边界
 *
 * - 非流式（历史 / 落盘 / 取消终态）渲染期直通返回全文，一帧陈旧文本都不给
 *   （与 useStreamingText 同语义）；流结束那一帧立即对齐，不留尾巴动画；
 * - 文本只增不改是常态；上游换文（缩短 / 前缀变化）直接对齐，不播「倒带」；
 * - prefers-reduced-motion：直通（JS 行为分支，与 MessageBar 滚动同做法；CSS 四层
 *   防线管不到 JS 驱动的 reveal，必须在这里显式分支）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** 追赶时长：积压按「~0.5s 追平」换算速率（豆包式动态调速的简化版）。 */
const CATCHUP_SECONDS = 0.5;
/** 速率下限（字符/秒）：细水长流时保持逐字活态，不至于一顿一顿。 */
const MIN_CHARS_PER_SECOND = 30;
/** 速率上限（字符/秒）：大积压平滑提速但不变成消防水管，保住「逐字」观感。 */
const MAX_CHARS_PER_SECOND = 1200;
/** 巨量积压阈值：超过就直接对齐（换会话 mid-stream / 历史回放不播入场）。 */
const SNAP_BACKLOG_CHARS = 4000;
/** 单帧 dt 上限：标签页切走再回来，rAF 间隔可能几秒，不能一次吐几千字。 */
const MAX_FRAME_DELTA_MS = 100;

/** reduced-motion 查询（模块级缓存 MediaQueryList，读 .matches 是活值）。 */
let reducedMotionQuery: MediaQueryList | undefined;
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  reducedMotionQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)');
  return reducedMotionQuery.matches;
}

/**
 * 返回「这一帧该显示的文本前缀」。流式期 rAF 匀速吐字追赶上游；非流式 /
 * reduced-motion 直通全文。挂载初值 = 挂载时的全文（mid-stream 挂上不从头回放）。
 */
export function useTypewriterText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const shownRef = useRef(text);
  const targetRef = useRef(text);
  const rafRef = useRef<number | undefined>(undefined);
  const lastFrameRef = useRef(0);
  /** 速率 × 时间的亚字符累积：每帧 floor 释放，余数留到下一帧（匀速不丢速）。 */
  const carryRef = useRef(0);

  const reduced = prefersReducedMotion();
  const passThrough = !streaming || reduced;

  /** rAF 泵：只读 ref（target / shown / carry / 帧时），闭包恒稳 ⇒ deps []。 */
  const pump = useCallback((now: number): void => {
    const target = targetRef.current;
    const current = shownRef.current;
    const backlog = target.length - current.length;
    if (backlog <= 0) {
      rafRef.current = undefined;
      return;
    }
    if (backlog > SNAP_BACKLOG_CHARS) {
      shownRef.current = target;
      carryRef.current = 0;
      setShown(target);
      rafRef.current = undefined;
      return;
    }
    const deltaMs = Math.min(Math.max(now - lastFrameRef.current, 0), MAX_FRAME_DELTA_MS);
    lastFrameRef.current = now;
    const speed = Math.min(
      MAX_CHARS_PER_SECOND,
      Math.max(MIN_CHARS_PER_SECOND, backlog / CATCHUP_SECONDS),
    );
    carryRef.current += (speed * deltaMs) / 1000;
    const count = Math.floor(carryRef.current);
    if (count > 0) {
      carryRef.current -= count;
      const next = target.slice(0, current.length + Math.min(count, backlog));
      shownRef.current = next;
      setShown(next);
    }
    rafRef.current = requestAnimationFrame(pump);
  }, []);

  useEffect(() => {
    targetRef.current = text;
    const stop = () => {
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = undefined;
      }
    };
    if (passThrough) {
      stop();
      carryRef.current = 0;
      if (shownRef.current !== text) {
        shownRef.current = text;
        setShown(text);
      }
      return;
    }
    // 上游换文（缩短 / 前缀变化）：直接对齐，不播倒带。
    if (text.length < shownRef.current.length || !text.startsWith(shownRef.current)) {
      shownRef.current = text;
      carryRef.current = 0;
      setShown(text);
    }
    if (shownRef.current.length < text.length && rafRef.current === undefined) {
      lastFrameRef.current = performance.now();
      rafRef.current = requestAnimationFrame(pump);
    }
  }, [text, passThrough, pump]);

  useEffect(
    () => () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return passThrough ? text : shown;
}
