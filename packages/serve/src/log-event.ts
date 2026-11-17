/**
 * 运维事件日志的**唯一**排版口。
 *
 * 背景（用户原话）：一条 `console.warn('[vessel] <event>', {...})` 在终端里被展开成
 * 六行 JSON，连着十条就完全不能读。同一项目里 `supervisor.*` 早就是好格式：
 *
 *   event=supervisor.stall_restart node=Soulkiller pid=97456 consecutive_failures=3
 *
 * 这里把那套「一行、key=value、字段序固定」的做法做成共用实现，全仓事件日志收口到
 * {@link formatEventLine} / {@link logEvent}，不再各自拼对象。
 *
 * 四条硬约束（缺一条这个模块就没有意义）：
 * 1. **单行**：所有值压掉换行与连续空白，一行就是一条事件；
 * 2. **字段序固定**：顺序来自 {@link EVENT_FIELDS} 的事件定义，**不**跟对象字面量的书写
 *    顺序走 —— 否则同一条事件在两个站点打出来的字段序不同，人眼和 diff 都读不了；
 * 3. **不丢信息**：定义表里没写的字段照样追加输出（新字段不会因为「忘了同时改两处」而
 *    消失），只有「空 / null / undefined / false」才省略，不打 foo=undefined；计数类与
 *    字节数类的 0 也省略（0 就是「没发生」，原值仍在 JSON 逃生阀里）；
 * 4. **机器可读逃生阀**：VESSEL_LOG_JSON=1 时退回**单行** JSON（一行，不是多行），
 *    需要 jq/grep 精读或要拿全量原值时用它。
 *
 * 不在这里做的事：不加时间戳前缀、不写文件、不做级别过滤 —— 那些属于终端输出的上层
 * （`ui.*`），事件日志只负责「这条事件怎么排成一行」。
 *
 * @module @vessel-agent/serve/log-event
 */

/** 行前缀：与其余 `[vessel]` 输出同一前缀，grep 仍能捞到全部。 */
const PREFIX = '[vessel] ';

/** 长文本（`reason` / `error` / `path`）在单行里的上限，超了截断并加省略号。 */
const TEXT_MAX = 60;

/** 路径字段（`log` / `dir`）的上限：够放下 Windows 长 tmp 路径，又不至于把一行撑爆。 */
const PATH_MAX = 200;

/** `id` 类字段（`session_id` / `conn_id` / `run_id`）短形式：头 4 + … + 尾 6。 */
const ID_HEAD = 4;
const ID_TAIL = 6;
/** 短于这个长度的 id 原样输出（再截就看不出是谁了）。 */
const ID_SHORTEST = 12;

/** node id 的短形式长度（没有 node 名字时用它；用户口径：前 8 位）。 */
const NODE_ID_MAX = 8;

/** 字段的渲染方式；决定单位、精度与省略规则。 */
export type EventFieldKind =
  /** 普通文本：压成一行、超长截断、含空白时加引号 */
  | 'text'
  /** 标识符：留头 4 + … + 尾 6（完整值在 JSON 逃生阀里） */
  | 'id'
  /** node：优先用名字，没有名字才用 id 前 8 位 */
  | 'node'
  /** 毫秒时长：12082 → 12.1s、202000 → 202s */
  | 'ms'
  /** 字节数：13107200 → 12.5MB */
  | 'bytes'
  /** 字节数对（bytes_in / bytes_out）：12.5MB/6.8KB */
  | 'bytespair'
  /** 计数：非零才输出（0 就是「没发生」，JSON 里仍是原值） */
  | 'count'
  /** 数值原样（帧数、seq、code） */
  | 'value'
  /** 布尔：true 输出 true（键名即事实），false 省略 */
  | 'flag'
  /**
   * 文件路径：**不**按 60 字截断（截断了的路径没法照抄去翻日志），上限 200；
   * 含空白时加引号。只给 `log=` / `dir=` 这类「用户要照着去打开」的字段用。
   */
  | 'path'
  /** 毫秒时间戳：输出 ISO 8601（可 grep、可排序） */
  | 'time';

/** 一个输出字段的定义：从 payload 的哪些键取值、怎么渲染。 */
interface FieldSpec {
  /** 输出里的键名 */
  readonly key: string;
  /** 渲染方式；省略 = `text` */
  readonly kind?: EventFieldKind;
  /**
   * payload 里的来源键（按顺序取第一个有值的）。
   * 两个来源且 `kind` 为 `bytespair` 时按下标配对输出。
   */
  readonly from?: readonly string[];
}

/**
 * 每个事件的字段顺序。
 *
 * 只写「这条事件长什么样」；payload 里多出来的键会按定义表之后**追加**输出，
 * 所以这里少写一个字段不会造成信息丢失，只会让那个字段排到末尾。
 */
const EVENT_FIELDS: Record<string, readonly FieldSpec[]> = {
  /**
   * WS 连接关闭。**两个来源共用这个名字**：平台代理（`platform/proxy-ws.ts`）与
   * node 侧（`gateway.ts`）都打 gateway.ws.closed，字段名略有差异，所以定义表按
   * 「谁有值就取谁」写：who 兼容 close_by，code 兼容 close_code。
   */
  'gateway.ws.closed': [
    { key: 'via' },
    { key: 'conn', from: ['conn_id'], kind: 'id' },
    { key: 'node', from: ['node_name', 'node_id'], kind: 'node' },
    { key: 'who', from: ['who', 'close_by'] },
    { key: 'code', from: ['code', 'close_code'], kind: 'value' },
    { key: 'reason', from: ['reason', 'close_reason'], kind: 'text' },
    { key: 'session', from: ['session_id'], kind: 'id' },
    { key: 'run', from: ['run_id'], kind: 'id' },
    { key: 'dur', from: ['duration_ms'], kind: 'ms' },
    // 帧：代理侧是 frames_in/frames_out，node 侧只有 frames_sent。
    { key: 'in', from: ['frames_in'], kind: 'value' },
    { key: 'out', from: ['frames_out', 'frames_sent'], kind: 'value' },
    { key: 'bytes', from: ['bytes_in', 'bytes_out'], kind: 'bytespair' },
    { key: 'bytes_sent', from: ['bytes_sent'], kind: 'bytes' },
    { key: 'buffered', from: ['buffered_bytes'], kind: 'bytes' },
    { key: 'epoch', from: ['timeline_epoch'], kind: 'flag' },
    { key: 'epochs', from: ['epochs'], kind: 'count' },
    { key: 'bp', from: ['backpressure_pauses'], kind: 'count' },
    { key: 'bp_drops', from: ['backpressure_drops'], kind: 'count' },
    { key: 'hb', from: ['heartbeat_misses'], kind: 'count' },
    { key: 'last_seq', from: ['last_seq_sent'], kind: 'value' },
    { key: 'upstream', from: ['upstream_open'], kind: 'flag' },
  ],
  /** 平台代理：node 在超时内没有回响应头（回 504）。 */
  'gateway.proxy.node_timeout': [
    { key: 'node', from: ['node_name', 'node_id'], kind: 'node' },
    { key: 'path' },
    { key: 'timeout', from: ['timeout_ms'], kind: 'ms' },
    { key: 'suppressed', kind: 'count' },
  ],
  /** 平台代理：连不上 node 的注册表地址（回 502）。 */
  'gateway.proxy.node_unreachable': [
    { key: 'node', from: ['node_name', 'node_id'], kind: 'node' },
    { key: 'path' },
    // 0.57：**这次用的预算是多少**必须看得见。`/health` 走 1.5s、其它 RPC 走 30s；
    // 少了这个字段，读者无法判断「等 30s 才报连不上」到底是配置还是代码。
    { key: 'timeout', from: ['timeout_ms'], kind: 'ms' },
    { key: 'suppressed', kind: 'count' },
  ],
  /** 平台代理：转发过程中内部错误。 */
  'gateway.proxy.failed': [
    { key: 'node', from: ['node_name', 'node_id'], kind: 'node' },
    { key: 'path' },
    { key: 'error', kind: 'text' },
    { key: 'suppressed', kind: 'count' },
  ],
  /** 平台代理：RPC 方法不在白名单（HTTP 与 WS 两条路都走这条）。 */
  'gateway.proxy.rpc_denied': [
    { key: 'node', from: ['node_name', 'node_id'], kind: 'node' },
    { key: 'method' },
    { key: 'via' },
    { key: 'code' },
    { key: 'suppressed', kind: 'count' },
  ],
  /** RPC 结果没通过 schema 校验（只记 method/path，绝不打印结果正文）。 */
  'rpc.result_invalid': [{ key: 'method' }, { key: 'path' }],
  /** 客户端自报时间线缺口（只记录，不改事实源）。 */
  'timeline.gap_reported': [
    { key: 'session', from: ['session_id'], kind: 'id' },
    { key: 'expected', kind: 'value' },
    { key: 'received', kind: 'value' },
    { key: 'start', from: ['start_seq'], kind: 'value' },
    { key: 'end', from: ['end_seq'], kind: 'value' },
    { key: 'after', from: ['after_timeline_seq'], kind: 'value' },
    { key: 'check', kind: 'value' },
    { key: 'at', kind: 'time' },
  ],
  /** 尾随时间线：建 epoch 期间按住的记录撞上硬上界。 */
  'gateway.timeline_tail.hold_overflow': [
    { key: 'session', from: ['session_id'], kind: 'id' },
    { key: 'seq', kind: 'value' },
    { key: 'held', kind: 'count' },
  ],
  /** 尾随时间线：窗口攒满被提前冲刷（不丢事件，只是窗口变短）。 */
  'gateway.timeline_tail.cut_short': [
    { key: 'batch', kind: 'value' },
    { key: 'windows', kind: 'count' },
    { key: 'records', kind: 'count' },
    { key: 'max_batch', kind: 'count' },
    { key: 'windows_cut_short', kind: 'count' },
    { key: 'windows_without_targets', kind: 'count' },
    { key: 'send_failures', kind: 'count' },
    { key: 'hold_overflows', kind: 'count' },
  ],
  /** 尾随时间线：扇出抛错（记录已落盘，客户端按游标续拉即可）。 */
  'gateway.timeline_tail.flush': [
    { key: 'batch', kind: 'value' },
    { key: 'error', kind: 'text' },
  ],
  /** 取消已经生效，但 RunRecord 没写进去（best-effort，不回 500）。 */
  'runs.cancel.save_failed': [
    { key: 'run', from: ['run_id'], kind: 'id' },
    { key: 'error', from: ['error', 'message'], kind: 'text' },
  ],
  /** 答案已落定，但续跑前的 checkpoint 没读出来（只记录，答案不回滚）。 */
  'ask.respond.checkpoint_load_failed': [
    { key: 'run', from: ['run_id'], kind: 'id' },
    { key: 'error', from: ['error', 'message'], kind: 'text' },
  ],
  /** 答案已落定，但挂起的 run 没续跑起来（fail-closed，不重试）。 */
  'ask.respond.resume_failed': [
    { key: 'run', from: ['run_id'], kind: 'id' },
    { key: 'error', from: ['error', 'message'], kind: 'text' },
  ],
  /** 答案已落定，但投放给 agent 失败（同上：只记录，不冒泡到 RPC）。 */
  'ask.answer.delivery_failed': [
    { key: 'request', from: ['request_id'], kind: 'id' },
    { key: 'error', from: ['error', 'message'], kind: 'text' },
  ],
  /**
   * Web 控制台产物构建：**唯一**的构建事实来源（0.60）。
   *
   * 规律：`start` / 可选 `progress` / 终态（`done` | `fail` | `interrupted`）——
   * 一次构建最多 4 行（终态的失败尾部另算，它是证据不是事件）。字段序在这里定死，
   * 启动横幅、`/build.json`、`gateway status` 都从这里派生，不再各写一套文案。
   */
  'web.build.start': [
    { key: 'reason' },
    { key: 'target' },
    // 0.61：谁叫起来的构建（startup / probe / timer）—— 三条入口共用同一套判据与
    // 同一个互斥，不标来源就查不出是哪条在反复触发。
    { key: 'check' },
    { key: 'pid', kind: 'value' },
    { key: 'log', kind: 'path' },
  ],
  'web.build.progress': [
    { key: 'elapsed', kind: 'ms' },
    { key: 'rss', kind: 'bytes' },
  ],
  'web.build.done': [
    { key: 'dur', kind: 'ms' },
    { key: 'assets', kind: 'count' },
    { key: 'bytes', kind: 'bytes' },
  ],
  'web.build.fail': [
    { key: 'exit', kind: 'value' },
    { key: 'dur', kind: 'ms' },
    { key: 'error', kind: 'text' },
    { key: 'log', kind: 'path' },
  ],
  'web.build.interrupted': [
    { key: 'signal' },
    { key: 'elapsed', kind: 'ms' },
    { key: 'log', kind: 'path' },
  ],
  /** 上次启动被硬杀留下的构建临时目录（下次启动清掉，只报一次总数）。 */
  'web.build.stale_artifact': [
    { key: 'cleaned', kind: 'count' },
    { key: 'dir', kind: 'path' },
  ],
  /** `gateway status` 里「构建正在跑」那一行（读同一份内存态，不是另写文案）。 */
  'web.build.running': [
    { key: 'elapsed', kind: 'ms' },
    { key: 'pid', kind: 'value' },
    { key: 'log', kind: 'path' },
  ],
  /** `gateway status` 里「上次构建的终态」那一行。 */
  'web.build.last': [
    { key: 'phase' },
    { key: 'exit', kind: 'value' },
    { key: 'signal' },
    { key: 'dur', kind: 'ms' },
    { key: 'at', kind: 'time' },
    { key: 'log', kind: 'path' },
  ],
  /**
   * 0.60：闸门内诊断类事件 —— 以前是各文件手拼 `[vessel] xxx: detail` 的 console 行，
   * 同样的信息在这里排一次，全仓一种口径（结构化的 `path` / `error` 也就不用再靠人眼切）。
   */
  'gateway.replay.budget_truncated': [
    { key: 'tail', from: ['tail_bytes'], kind: 'bytes' },
    { key: 'tail_lower_bound', kind: 'flag' },
    { key: 'budget', from: ['budget_bytes'], kind: 'bytes' },
    { key: 'kept', from: ['kept_events'], kind: 'count' },
    { key: 'kept_bytes', kind: 'bytes' },
    { key: 'hint' },
  ],
  'gateway.events.global_replay_denied': [
    { key: 'since', kind: 'value' },
    { key: 'candidates', kind: 'count' },
    { key: 'hint' },
  ],
  'gateway.stop.failed': [{ key: 'action' }, { key: 'error', kind: 'text' }],
  /** 写 trace 失败（只 warn，不回写 trace，避免递归）。 */
  'trace.write.failed': [{ key: 'reason' }, { key: 'error', kind: 'text' }],
  /** Hub 没起来（启动阶段与收尾阶段同一件事、同一套字段）。 */
  'hub.start_failed': [{ key: 'code' }, { key: 'error', kind: 'text' }],
  'gateway.tenant_hub.failed': [{ key: 'action' }, { key: 'error', kind: 'text' }],
  'interactions.registry.reload_failed': [
    { key: 'request', from: ['request_id'], kind: 'id' },
    { key: 'error', kind: 'text' },
  ],
  'interactions.store.quarantined': [
    { key: 'path', kind: 'path' },
    { key: 'reason' },
    { key: 'to', kind: 'path' },
  ],
  'interactions.store.quarantine_failed': [
    { key: 'path', kind: 'path' },
    { key: 'reason' },
    { key: 'error', kind: 'text' },
  ],
  'interactions.store.skipped': [
    { key: 'path', kind: 'path' },
    { key: 'tenant' },
    { key: 'reason' },
  ],
  'interactions.store.persist_failed': [
    { key: 'path', kind: 'path' },
    { key: 'error', kind: 'text' },
  ],
  'interactions.store.load_failed': [
    { key: 'path', kind: 'path' },
    { key: 'error', kind: 'text' },
  ],
  /** 存活看门狗（0.58 起是手拼的 `event=...` 行，0.60 收口到本表）。 */
  'supervisor.stall_restart': [
    { key: 'node', from: ['node_name', 'node_id'], kind: 'node' },
    { key: 'pid', kind: 'value' },
    { key: 'consecutive_failures', kind: 'count' },
    { key: 'last_ok_ms', kind: 'value' },
    { key: 'stalled_for_ms', kind: 'ms' },
    { key: 'probe_timeout_ms', kind: 'ms' },
    { key: 'attempt_in_hour' },
    { key: 'backoff_ms', kind: 'ms' },
    { key: 'action' },
  ],
  'supervisor.stall_restart_failed': [
    { key: 'node', from: ['node_name', 'node_id'], kind: 'node' },
    { key: 'pid', kind: 'value' },
    { key: 'consecutive_failures', kind: 'count' },
    { key: 'probe_timeout_ms', kind: 'ms' },
    { key: 'error', kind: 'text' },
  ],
  'supervisor.stall_restart_gave_up': [
    { key: 'node', from: ['node_name', 'node_id'], kind: 'node' },
    { key: 'pid', kind: 'value' },
    { key: 'restarts_last_hour', kind: 'count' },
    { key: 'max_restarts_per_hour', kind: 'value' },
    { key: 'last_ok_ms', kind: 'value' },
    { key: 'stalled_for_ms', kind: 'ms' },
    { key: 'reason', kind: 'text' },
  ],
  'supervisor.stall_recovered': [
    { key: 'node', from: ['node_name', 'node_id'], kind: 'node' },
    { key: 'pid', kind: 'value' },
    { key: 'consecutive_ok', kind: 'count' },
  ],
};

/** 定义表里没有的事件：字段全留，只按 key 名推断种类。 */
const DEFAULT_FIELDS: readonly FieldSpec[] = [];

/** VESSEL_LOG_JSON=1：机器可读逃生阀（仍是单行）。 */
function jsonMode(): boolean {
  return (process.env.VESSEL_LOG_JSON ?? '').trim() === '1';
}

/** 值是否值得打出来：空串 / null / undefined / false 都不占位置。 */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/** 压成一行：换行、制表、连续空白一律变单个空格（单行铁律）。 */
function flatten(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** 文本：压成一行 + 截断 + 需要时加引号（含空白/等号/引号的值不加引号就没法读）。 */
function renderText(raw: string): string | null {
  const flat = flatten(raw);
  if (flat === '') return null;
  const cut = flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX)}…` : flat;
  return /[\s="]/.test(cut) ? JSON.stringify(cut) : cut;
}

/**
 * 路径：只压行、不短截（`TEXT_MAX` 会把 `/tmp/vessel-web-build/<ts>/build.log` 这类
 * 刚好能照抄的路径切掉一半），仍留 200 字硬上界防爆行。
 */
function renderPath(raw: string): string | null {
  const flat = flatten(raw);
  if (flat === '') return null;
  const cut = flat.length > PATH_MAX ? `${flat.slice(0, PATH_MAX)}…` : flat;
  return /[\s"']/.test(cut) ? JSON.stringify(cut) : cut;
}

/** 毫秒 → 500ms / 12.1s / 30s / 202s / 1.5h（.0 去掉）。 */
function renderMs(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${trimZero((ms / 1000).toFixed(1))}s`;
  if (abs < 3_600_000) return `${Math.round(ms / 1000)}s`;
  return `${trimZero((ms / 3_600_000).toFixed(1))}h`;
}

/** `12.0` → `12`（一位小数的整数部分别拖着 .0）。 */
function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/** 字节 → 512B / 6.8KB / 12.5MB / 1.2GB（一位小数，.0 去掉）。 */
function renderBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${Math.round(bytes)}B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unit: string = units[0];
  for (let index = 1; index < units.length && Math.abs(value) >= 1024; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${trimZero(value.toFixed(1))}${unit}`;
}

/** id 短形式：够短就原样，长了留头 4 + … + 尾 6（尾部才是随机/区分的那半）。 */
function renderId(text: string): string | null {
  if (text === '') return null;
  if (text.length <= ID_SHORTEST) return text;
  return `${text.slice(0, ID_HEAD)}…${text.slice(-ID_TAIL)}`;
}

/** 非字符串值的文本形式（对象/数组退 JSON，布尔转字面量）。 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 一个值 → 单行文本；null 表示这个字段该省略。 */
function renderValue(kind: EventFieldKind, value: unknown, source: string): string | null {
  switch (kind) {
    case 'text':
      return renderText(stringify(value));
    case 'path':
      return renderPath(stringify(value));
    case 'id':
      return renderId(stringify(value));
    case 'node': {
      // node_name 有值就是名字（人看得懂的那个），否则退回 id 前 8 位。
      const text = stringify(value);
      if (text === '') return null;
      if (source === 'node_name') return renderText(text);
      return text.length > NODE_ID_MAX ? text.slice(0, NODE_ID_MAX) : text;
    }
    case 'ms':
      return typeof value === 'number' ? renderMs(value) : renderText(stringify(value));
    case 'bytes': {
      // 字节数 0 同样省略（0B 就是「没进出」）；需要原值用 VESSEL_LOG_JSON=1。
      if (value === 0) return null;
      return typeof value === 'number' ? renderBytes(value) : renderText(stringify(value));
    }
    case 'count': {
      // 0 就是「没发生」：省掉，别让每行都拖着 bp=0 hb=0。
      const count = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(count) || count === 0) return null;
      return String(count);
    }
    case 'flag':
      return value === true ? 'true' : null;
    case 'time': {
      const at = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(at)) return renderText(stringify(value));
      return new Date(at).toISOString();
    }
    default:
      return renderText(stringify(value));
  }
}

/** 定义表没覆盖的键：按名字猜单位，猜不出就当文本。 */
function inferKind(key: string): EventFieldKind {
  if (key.endsWith('_ms')) return 'ms';
  if (key.endsWith('_bytes')) return 'bytes';
  if (key.endsWith('_id')) return 'id';
  if (key.endsWith('_at')) return 'time';
  return 'text';
}

/** 输出一个字段：多来源时取第一个有值的（bytespair 例外，两个前缀配对）。 */
function renderField(spec: FieldSpec, payload: Record<string, unknown>): string | null {
  const sources = spec.from ?? [spec.key];
  const kind = spec.kind ?? 'text';
  const present = sources
    .map((source) => ({ source, value: payload[source] }))
    .filter((entry) => isPresent(entry.value));
  if (present.length === 0) return null;
  if (kind === 'bytespair') {
    const parts = present
      .map((entry) => renderValue('bytes', entry.value, entry.source))
      .filter((part): part is string => part !== null);
    return parts.length === 0 ? null : `${spec.key}=${parts.join('/')}`;
  }
  const first = present[0];
  if (first === undefined) return null;
  const text = renderValue(kind, first.value, first.source);
  return text === null ? null : `${spec.key}=${text}`;
}

/**
 * 把一条事件排成**一行**。
 *
 * @param event 事件名（gateway.ws.closed 这种）；空串时取 `fields.event`
 * @param fields 事件字段；`event` 键不会重复输出
 */
export function formatEventLine(event: string, fields: Record<string, unknown>): string {
  const name = event !== '' ? event : stringify(fields.event ?? 'unknown');
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'event') continue;
    payload[key] = value;
  }
  if (jsonMode()) {
    // 单行 JSON：不换行、不缩进，管道给 jq 直接能读，grep 也不受影响。
    return `${PREFIX}${JSON.stringify({ event: name, ...payload })}`;
  }
  const parts: string[] = [];
  const used = new Set<string>();
  for (const spec of EVENT_FIELDS[name] ?? DEFAULT_FIELDS) {
    for (const source of spec.from ?? [spec.key]) used.add(source);
    const rendered = renderField(spec, payload);
    if (rendered !== null) parts.push(rendered);
  }
  // 兜底：定义表没写到的字段照样输出 —— 新字段不会因为「忘了同时改两处」而消失。
  for (const [key, value] of Object.entries(payload)) {
    if (used.has(key) || !isPresent(value)) continue;
    const text = renderValue(inferKind(key), value, key);
    if (text === null) continue;
    parts.push(`${key}=${text}`);
  }
  return parts.length === 0 ? `${PREFIX}${name}` : `${PREFIX}${name} ${parts.join(' ')}`;
}

/** 平台代理那类「fields 里自带 event」的调用点用这个。 */
export function formatEventFields(fields: Record<string, unknown>): string {
  const event = typeof fields.event === 'string' ? fields.event : '';
  return formatEventLine(event, fields);
}

/**
 * 打一条事件日志。
 *
 * 级别只影响走哪个 console 通道（warn/error），**不影响**排版 —— 同一条事件不该因为
 * 级别不同就换一套格式。
 */
export function logEvent(
  level: 'warn' | 'error' | 'info',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = formatEventLine(event, fields);
  if (level === 'error') console.error(line);
  else if (level === 'info') console.info(line);
  else console.warn(line);
}
