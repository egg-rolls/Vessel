/**
 * 连接「看起来断了吗」的状态机（S1d）—— 纯逻辑，零依赖，探针可直接 import，不许碰 DOM。
 *
 * 为什么要宽限期（grace）：平台层重启会把 WS 掐断约 0.6s，node 重启 1–2.5s。只要
 * `connectionState !== 'open'` 就闪一条「已断开」，用户看到的是噪声而不是信息 ——
 * 0.6s 的重启在 UI 上应该**完全不可见**。规则：
 *   - 非 open 时长 < graceMs 又回到 open：当作没发生，全程不产生任何「断开」状态；
 *   - 越过 graceMs 仍非 open：`visible = true`（措辞由 UI 决定，这里只是轻提示闸门），
 *     重新 open 立刻清（`disconnectedAt` 也清空，下一次断线重新计时）。
 *
 * 状态机不排定时器：时间从 `now()` 注入，唤醒时刻由调用方按 `noticeAt()` 排，
 * 这样探针能用假 clock 走完整条时间线，而不用等真实 2 秒。
 *
 * 另一件事：重连判定。首次 hello 是「连上」，之后每次 hello 才是「重连」（要强制
 * hydrate、对账本地 live 状态）。判定和接线都放在这里，React 侧只负责调用。
 */
/**
 * 连接状态的字面量集合。**故意定义在这里而不是从  import**：
 *  →  依赖 DOM（ / ），
 * 零依赖探针  import 本模块时会被根 tsconfig（无 DOM lib）
 * 牵连报错。所以类型定义放在纯模块里，client 反向引用它。
 */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

/** 断开宽限期：2s 内的抖动不提示（平台层 0.6s / node 1–2.5s 的折中）。 */
export const LINK_GRACE_MS = 2000;

export type LinkPhase = 'connected' | 'grace' | 'offline';

export interface LinkSnapshot {
  /** connected：open；grace：断开但还在宽限期内；offline：已越过宽限期。 */
  phase: LinkPhase;
  /** 是否该给用户「已断开」提示 —— 只有 offline 才为 true。 */
  visible: boolean;
  /** 最近一次观察到非 open 的时刻（ms epoch，取自注入的 clock）；连上即清。 */
  disconnectedAt: number | null;
}

export interface LinkStatusMachine {
  snapshot(): LinkSnapshot;
  /** 喂一个连接状态；返回（可能未变的）快照。 */
  onConnectionState(state: ConnectionState): LinkSnapshot;
  /** 在 `noticeAt()` 之后唤醒：到点就翻成 offline，已被重新连上则保持 connected。 */
  onWake(): LinkSnapshot;
  /** 下一次需要唤醒的时刻（ms epoch）；不需要就 null（宽限期内抖动、已连上都没有）。 */
  noticeAt(): number | null;
}

export interface LinkStatusOptions {
  graceMs?: number;
  now?: () => number;
}

const CONNECTED: LinkSnapshot = { phase: 'connected', visible: false, disconnectedAt: null };

export function createLinkStatusMachine(options: LinkStatusOptions = {}): LinkStatusMachine {
  const graceMs = options.graceMs ?? LINK_GRACE_MS;
  const now = options.now ?? (() => Date.now());

  let phase: LinkPhase = 'connected';
  let disconnectedAt: number | null = null;
  let current: LinkSnapshot = CONNECTED;

  const commit = (nextPhase: LinkPhase, at: number | null): LinkSnapshot => {
    // 快照保持引用稳定：没变化就返回同一个对象，React 侧不会白重渲染。
    if (nextPhase === phase && at === disconnectedAt) return current;
    phase = nextPhase;
    disconnectedAt = at;
    current = { phase: nextPhase, visible: nextPhase === 'offline', disconnectedAt: at };
    return current;
  };

  return {
    snapshot: () => current,
    onConnectionState(state) {
      if (state === 'open') return commit('connected', null);
      // 非 open：只有「本来连着 / 没有计过时」才起新的宽限窗。
      // 重连途中的 connecting ↔ reconnecting 抖动不能重置起点，否则长断线永远到不了 offline。
      if (disconnectedAt !== null) return current;
      return commit('grace', now());
    },
    onWake() {
      if (phase !== 'grace' || disconnectedAt === null) return current;
      if (now() - disconnectedAt < graceMs) return current;
      return commit('offline', disconnectedAt);
    },
    noticeAt() {
      if (phase !== 'grace' || disconnectedAt === null) return null;
      return disconnectedAt + graceMs;
    },
  };
}

export interface ReconnectDetector {
  /** 一次连接级 hello；true 表示「重连」（首次连接是连上，不算）。 */
  onConnectionHello(): boolean;
  /** 换连接上下文（换 node / 重新握手）时复位。 */
  reset(): void;
}

export function createReconnectDetector(): ReconnectDetector {
  let seenHello = false;
  return {
    onConnectionHello() {
      if (!seenHello) {
        seenHello = true;
        return false;
      }
      return true;
    },
    reset() {
      seenHello = false;
    },
  };
}

export interface ReconnectHydrationOptions {
  detector: ReconnectDetector;
  /** 重连成功的收口动作（生产里是 recovery.onReconnected：快照 + live 状态对账）。 */
  onReconnected: () => void;
}

/**
 * hello 之后的接线（生产里 connection-handlers 的 hello 分支直接调这个）：
 * 首次连接不触发，之后每次重连成功**恰好一次**。
 *
 * 为什么抽成函数而不是在 handler 里写 `if (detector.onConnectionHello())`：
 * 这样「重连 ⇒ 强制 hydrate 一次」这条规则可由探针驱动**生产代码**断言，
 * 而不是让探针在测试里重写一遍同样的 if。
 */
export function afterConnectionHello(options: ReconnectHydrationOptions): boolean {
  if (!options.detector.onConnectionHello()) return false;
  options.onReconnected();
  return true;
}
