/**
 * 新会话 = 一个新的临时 agent（CONTRACT-0.28 §3）。
 *
 * 草稿态的首次发送必须走契约的顺序，**不能**省成一次 `runs.start`：
 * ```
 * ① agents.create{ agents: [{ name: <客户端生成的唯一名> }] }  → results[0].agent.{id, session_id}
 * ② runs.start{ agent_id }                                    → run_id + session_id
 * ```
 * 两条禁止（都是静默错误，不报错也不会有测试抓住）：
 * - **不传固定名**：`service.create` 同名 present 成员会被**复用**（`service.ts:796`），
 *   第二个「新会话」会悄悄接进第一个 agent，两段对话共用一个 body。
 * - **不只传 session_id**：未绑定的 session 会落到 `main` 上，长出第二具 body，
 *   而「一个 agent 恰好一具 live body」是 0.28 的不变量。
 *
 * 团队归属（R7 = 选项 A，已裁决）：**Web 不传任何 team 标识**，也不新增 wire 字段。
 * `agents.create` 只给 `name`，服务端按自己的 `defaultWorkspace` 解析默认 team。
 * 于是本模块的入参里根本没有 team —— 这是有意的，不是遗漏。
 *
 * 失败处理：`runs.start` 失败即 best-effort `agents.close`，不留「建了没跑过」的空 agent。
 *
 * @module web/chat/new-session
 */

import type { AgentCreateInput, AgentSummary, RunStartResult } from '../../gateway/types';

/** 新建 agent 需要的最小控制面（`GatewayClient` 结构满足；探针可注入假实现）。 */
export interface NewSessionAgentControl {
  createAgent(input: AgentCreateInput): Promise<AgentSummary>;
  closeAgent(agentId: string): Promise<AgentSummary>;
}

/** `runs.start` 的薄包装（第三参数是本次投给哪个 agent）。 */
export type SubmitRun = (
  input: string,
  sessionId?: string,
  agentId?: string,
) => Promise<RunStartResult>;

/** `MEMBER_NAME_RE`（`packages/agent/src/service.ts:133`）允许的字符集。 */
const ADDRESSABLE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** 保留 principal：不能当成员名。 */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['human', 'system']);

/**
 * 客户端生成的新会话 agent 名。
 *
 * 只需要「唯一」，不需要可读：它是临时 agent 的地址，用户看到的是会话标题。
 * `crypto.randomUUID()` 只含 hex 与 `-`，天然满足名字形状；前缀让 roster / 日志里
 * 一眼看出这是 Web 开的新会话。`random` 可注入（探针要确定性）。
 */
export function newSessionAgentName(random: () => string = () => crypto.randomUUID()): string {
  const candidate = `chat-${random().toLowerCase()}`;
  // 兜底：注入的 random 若返回非法字符 / 保留名，退回哈希，绝不把非法名字发上 wire。
  if (ADDRESSABLE_NAME.test(candidate) && !RESERVED_NAMES.has(candidate)) return candidate;
  let hash = 0;
  for (const char of candidate) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `chat-${hash.toString(16).padStart(8, '0')}`;
}

export interface StartInNewAgentResult {
  /** 新建 agent 的 id（`runs.start` 的 `agent_id`）。 */
  agentId: string;
  /** 服务端回填的 session_id（body id ≡ session id）。 */
  sessionId: string;
  run: RunStartResult;
}

/**
 * 建一个新会话 agent 并把这条消息投给它。
 *
 * 两条错误路径分开处理，不合并成一个「发送失败」：
 * - 建 agent 失败 → 什么都没留下，直接抛；
 * - 建成功、`runs.start` 失败 → **回收刚建的 agent**（best-effort）再抛原错误。
 *   回收失败只吞掉，不能盖掉 `runs.start` 的原始原因（那才是用户要看的）。
 */
export async function startInNewAgent(
  control: NewSessionAgentControl,
  submitRun: SubmitRun,
  input: string,
  name: string = newSessionAgentName(),
): Promise<StartInNewAgentResult> {
  // 契约 §3 ①：只给 name —— 不传 kind（⇒ temporary）、不传 owner、不传 team。
  const agent = await control.createAgent({ name });
  const agentId = agent.id ?? agent.agent_id;
  if (!agentId) throw new Error('agents.create returned no agent id');

  try {
    // 契约 §3 ②：带 agent_id。session_id 故意不传 —— 由服务端在 agent 下建 body，
    // 回填的就是这具 body 的 session。传一个客户端编的 session 会绑不上 agent。
    const run = await submitRun(input, undefined, agentId);
    if (!run.session_id) throw new Error('runs.start returned no session_id');
    return { agentId, sessionId: run.session_id, run };
  } catch (error) {
    // best-effort：回收失败不覆盖原始错误。
    try {
      await control.closeAgent(agentId);
    } catch {
      // 空 agent 留在 roster 里由服务端 TTL 回收（`role: temporary` 可回收，契约 §4.1）。
    }
    throw error;
  }
}
