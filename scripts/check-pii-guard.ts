#!/usr/bin/env bun

/**
 * PII 守卫探针（0.52 pii-guard）：**不误伤 + 只在读侧脱敏**。
 *
 * 背景（用户裁定的 bug）：phone 正则把 13 位毫秒时间戳 `1794482135404` 当成手机号，
 * 打成 `179*******404`；而打码发生在 Output 阶段的 `replacement` 上，也就是**改写
 * 落盘正文**——append-only 的 transcript 被不可逆污染，同时是「重复渲染」的触发源。
 *
 * 五组判据：
 * - A 不误伤：13 位时间戳、17/18/19 位长数串不打码；
 * - B 真手机号照打：`13800138000` / `+8613800138000` / `tel:13912345678`；
 * - C 嵌在长数串里的手机号不打码（前后紧邻数字 ⇒ 它属于那条更长的数串）；
 * - D 落盘不变：走**真** guardrail（ToolResult 阶段，写侧唯一打码入口）后落盘，
 *   存储里仍是原文；请求/展示投影（读侧 masker）才是打码后的；
 * - E 反向：脱敏开关关闭（`maskOnRead: false` / `enabled: false`）时两条路径都不打码。
 *
 * 另外钉住三条不变量：读侧脱敏**幂等**（不会越遮越多）、**不叠字**、
 * 以及写侧返回值里**没有** replacement 造成的正文漂移。
 *
 * 用法：bun run scripts/check-pii-guard.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import assert from 'node:assert/strict';
import {
  GuardrailStage,
  MemoryEventStream,
  MemoryPluginHost,
  MemorySessionStore,
  withReadSideMask,
  type Message,
  type SessionState,
} from '@vessel-agent/core';
import { GuardrailRunner } from '@vessel-agent/core/policy';
import {
  createPiiGuardrailPlugin,
  createPiiMasker,
  detectPii,
  maskText,
  piiGuardrailPlugin,
} from '@vessel-agent/guardrail-pii';

let failures = 0;
let checks = 0;

/** 断言：相等 */
function check(name: string, actual: unknown, expected: unknown): void {
  checks += 1;
  try {
    assert.deepEqual(actual, expected);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
    if (error instanceof Error && error.message.length > 0) {
      console.error(`  ${error.message.split('\n')[0]}`);
    }
  }
}

/** 断言：文本里没有被打码的痕迹 */
function checkUntouched(name: string, input: string, output: string): void {
  checks += 1;
  if (output !== input) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(`  input:  ${JSON.stringify(input)}`);
    console.error(`  output: ${JSON.stringify(output)}（原文被改写）`);
  }
}

/** 断言：确实打码了（含星号且不等于原文） */
function checkMasked(name: string, input: string, output: string): void {
  checks += 1;
  if (output === input || !output.includes('*')) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(`  input:  ${JSON.stringify(input)}`);
    console.error(`  output: ${JSON.stringify(output)}（应当打码）`);
  }
}

// ── A. 不误伤：时间戳 / 长数串 ────────────────────────────────────────────────
const NO_MASK_SAMPLES: ReadonlyArray<string> = [
  '1794482135404', // 13 位毫秒时间戳（本 bug 的原始样本）
  '1234567890123',
  'ts=1794482135404, id=1794482135405',
  '17000000000000000', // 17 位
  '170000000000000001', // 18 位
  '1700000000000000001', // 19 位
  '{\n  \"at\": 1794482135404,\n  \"note\": \"ok\"\n}',
];

for (const sample of NO_MASK_SAMPLES) {
  check(`A detect 不打码 ${sample}`, detectPii(sample).length, 0);
  checkUntouched(`A maskText 不动 ${sample}`, sample, maskText(sample));
}

// ── B. 真手机号照打 ───────────────────────────────────────────────────────────
const MASK_SAMPLES: ReadonlyArray<string> = [
  '13800138000',
  '+8613800138000',
  'tel:13912345678',
  'call 13800138000 now',
  'phone=+86 13712345678',
];

for (const sample of MASK_SAMPLES) {
  const masked = maskText(sample);
  checkMasked(`B 打码 ${sample}`, sample, masked);
  // 打码必须幂等：再遮一次结果不变（请求层每次请求都会重新投影）
  check(`B 幂等 ${sample}`, maskText(masked), masked);
}

// 精确形状：11 位大陆号保留后 4 位
check('B 形状 13800138000', maskText('13800138000'), '*******8000');
check('B 形状带国家码', maskText('+8613800138000'), '+*********8000');

// ── C. 嵌在长数串里的手机号不打码 ─────────────────────────────────────────────
const EMBEDDED_SAMPLES: ReadonlyArray<string> = [
  '9913800138000', // 前面紧邻数字 ⇒ 13 位串，不是手机号
  '1380013800099', // 后面紧邻数字 ⇒ 13 位串
  '9791380013800077', // 中间夹着一条 16 位串
];
for (const sample of EMBEDDED_SAMPLES) {
  check(`C 不打码 ${sample}`, detectPii(sample).length, 0);
  checkUntouched(`C maskText 不动 ${sample}`, sample, maskText(sample));
}
// 已知取舍（宁可漏遮不误伤）：不跨分隔符拼接成手机号。
// `1380-0138000` 被切成 `1380` 和 `0138000` 两条串，都不足 11 位 ⇒ 不打码。
// 理由是同一个：任何「跨缺口凑 11 位」的规则都能在长数串 / 时间戳上凑出错位掩码，
// 而误伤是写坏数据的（0.52 之前的 bug）。要支持带分隔符的号码，应显式加一条
// 独立规则并配边界断言，不能靠正则窗口去猜。
checkUntouched('C 不跨分隔符拼接', '1380-0138000', maskText('1380-0138000'));

// ── D. 落盘不变：写侧零改写，读侧才打码 ───────────────────────────────────────
const PHONE = '13912345678';
const RAW_TOOL_RESULT = `{"ok":true,"owner":{"phone":"${PHONE}"},"at":1794482135404}`;

const host = new MemoryPluginHost();
// 插件自注册：guardrail（只检测）+ 读侧 masker（唯一打码位置）
piiGuardrailPlugin.install(host);
check('D 插件登记了 guardrail', host.getGuardrails().length > 0, true);
check('D 插件登记了读侧 masker', (host.getReadSideMaskers?.() ?? []).length, 1);

const events = new MemoryEventStream();
const runner = new GuardrailRunner(host, events);

// 写侧：tool 结果落盘前会经过 ToolResult 阶段的 guardrail
const toolResultOutcome = await runner.apply(RAW_TOOL_RESULT, GuardrailStage.ToolResult, 'run-1', 'sess-1');
check('D 写侧不拦截', toolResultOutcome.allowed, true);
checkUntouched('D 写侧不改写 tool 结果', RAW_TOOL_RESULT, String(toolResultOutcome.replacement));

// 写侧：assistant 正文（Output 阶段）同样不许被改写
// 这条正文同时含手机号和 13 位时间戳：以前两者都会被改（时间戳是被咬错的）
const TS = 1794482135404;
const assistantText = `已记录 ${PHONE}，时间 ${TS}。`;
const outputOutcome = await runner.apply(assistantText, GuardrailStage.Output, 'run-1', 'sess-1');
check('D 写侧 Output 不拦截', outputOutcome.allowed, true);
checkUntouched('D 写侧不改写 assistant 正文', assistantText, String(outputOutcome.replacement));
check('D 时间戳原样保留', String(outputOutcome.replacement).includes(String(TS)), true);

// 写侧返回值本身不许带 replacement：这是「打码搬去读侧」的硬断言
const piiGuardrail = host.getGuardrails()[0];
check('D host 里拿到了 guardrail', piiGuardrail !== undefined, true);
const verdict = await piiGuardrail!.check(RAW_TOOL_RESULT, {} as never);
check('D check() 不带 replacement', 'replacement' in verdict, false);
check('D 仍然在检测（report-only）', String(verdict.reason).includes('pii_detected'), true);

// 落盘：把写侧产物存进会话存储，读回来必须还是原文
const store = new MemorySessionStore();
const state: SessionState = {
  session_id: 'sess-1',
  created_at: 1,
  updated_at: 2,
  messages: [
    { role: 'user', content: '查一下我的号码' },
    { role: 'tool', content: String(toolResultOutcome.replacement), tool_call_id: 'call-1' } as Message,
    { role: 'assistant', content: String(outputOutcome.replacement) },
  ],
};
await store.save(state);
const reloaded = await store.load('sess-1');
check('D 落盘后 messages 仍在', reloaded?.messages?.length, 3);
checkUntouched('D 落盘 tool 结果是原文', RAW_TOOL_RESULT, String(reloaded?.messages?.[1]?.content));
checkUntouched('D 落盘 assistant 正文是原文', assistantText, String(reloaded?.messages?.[2]?.content));
check('D 存储里能看见原始手机号', String(reloaded?.messages?.[1]?.content).includes(PHONE), true);

// 请求构造层：读侧 masker 投影（落盘不动，投影才打码）
const forRequest = withReadSideMask(reloaded?.messages ?? [], host.getReadSideMaskers?.() ?? []);
checkMasked('D 请求投影打码', RAW_TOOL_RESULT, String(forRequest[1]?.content));
checkMasked('D 请求投影打码 assistant', assistantText, String(forRequest[2]?.content));
check('D 请求投影不泄漏原始手机号', String(forRequest[1]?.content).includes(PHONE), false);
checkUntouched('D 投影不改原数组', RAW_TOOL_RESULT, String(reloaded?.messages?.[1]?.content));

// 幂等：同一份落盘原文连续投影两次，结果一致（前缀快照因此稳定）
const secondPass = withReadSideMask(forRequest, host.getReadSideMaskers?.() ?? []);
check('D 投影幂等', secondPass.map((m) => m.content), forRequest.map((m) => m.content));

// ── E. 反向：开关关闭时两条路径都不打码 ───────────────────────────────────────
for (const [label, config] of [
  ['maskOnRead=false', { maskOnRead: false }],
  ['enabled=false', { enabled: false }],
] as const) {
  const offHost = new MemoryPluginHost();
  createPiiGuardrailPlugin(config).install(offHost);
  const offRunner = new GuardrailRunner(offHost, new MemoryEventStream());
  const outcome = await offRunner.apply(RAW_TOOL_RESULT, GuardrailStage.ToolResult, 'run-2', 'sess-2');
  checkUntouched(`E ${label} 写侧不改写`, RAW_TOOL_RESULT, String(outcome.replacement));
  const projected = withReadSideMask(
    [{ role: 'tool', content: RAW_TOOL_RESULT } as Message],
    offHost.getReadSideMaskers?.() ?? [],
  );
  checkUntouched(`E ${label} 读侧不打码`, RAW_TOOL_RESULT, String(projected[0]?.content));
}

// ── 附带：其它数字类规则的同类误伤 ───────────────────────────────────────────
// 18 位身份证：校验位 / 出生日期过关才算，随机长数串不许判
check('F 随机 18 位不是身份证', detectPii('123456789012345678').length, 0);
check('F 随机 19 位不是身份证', detectPii('1234567890123456789').length, 0);
check('F 真身份证命中', detectPii('11010519491231002X').length, 1);
check('F 真身份证类型', detectPii('11010519491231002X')[0]?.type, 'id_card');
// 银行卡：Luhn 说了算
check('F 随机 16 位不是卡号', detectPii('1234567890123456').length, 0);
check('F Luhn 通过的卡号命中', detectPii('4111111111111111')[0]?.type, 'credit_card');
// 裸 9 位数字不再被 SSN 规则咬
check('F 裸 9 位不是 SSN', detectPii('123456789').length, 0);
check('F 带分隔符 SSN 命中', detectPii('123-45-6789')[0]?.type, 'ssn');
// masker 只由插件提供一份，不重复打码
check('F masker 名唯一', createPiiMasker().name, 'pii');

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log(`\nPII 探针：${checks - failures}/${checks} 通过`);
if (failures > 0) {
  console.error(`FAIL ${failures} 项`);
  process.exit(1);
}
console.log('OK 时间戳不再被当手机号；脱敏只在读侧，落盘原文不变');

