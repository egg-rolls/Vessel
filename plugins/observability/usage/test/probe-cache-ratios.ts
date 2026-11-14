/**
 * Usage plugin cache-ratio probe.
 *
 * Audits the "提示词缓存" numbers: which provider fields form the numerator and
 * the denominator, how multiple runs get aggregated, and what is shown when a
 * provider does not report cache fields at all (缺省 ≠ 0).
 *
 * Cases:
 *   a. Anthropic 语义：prompt = input + cache_read + cache_creation，命中率不得 >100%
 *   b. OpenAI 式 prompt_tokens 已含 cached_tokens，只补 cache_read；无写字段
 *   c. 字段缺省（provider 不报缓存）⇒ 不可用，绝不能显示 0%
 *   d. cache_creation 不进命中率分子，单列为 prefix health；prompt=0 不除零
 *   e. 多 run 按 token 加权，不按 run 平均；不报缓存的 run 不进分母
 *
 * Run:  bun run plugins/observability/usage/test/probe-cache-ratios.ts
 * Real: bun run plugins/observability/usage/test/probe-cache-ratios.ts --real <dataDir>
 *
 * Not wired into any gate.
 */

import { summarizeRuns } from '../src/aggregate.js';
import { type RunSummary, readUsageIndex } from '../src/store.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const T0 = 1_700_000_000_000;

/** Minimal RunSummary: only the fields runRatios/summarizeRuns actually read. */
function run(over: Partial<RunSummary> & { run_id: string }): RunSummary {
  return {
    model: 'probe-model',
    ts_start: T0,
    ts_end: T0,
    requests: 1,
    prompt_tokens: 0,
    completion_tokens: 0,
    unpriced_requests: 0,
    status: 'ok',
    ...over,
  } as RunSummary;
}

function close(a: number | undefined, b: number | undefined): boolean {
  return a !== undefined && b !== undefined && Math.abs(a - b) < 1e-12;
}

async function main(): Promise<void> {
  // -------------------------------------------------------------- (a) Anthropic
  // prompt 语义是 input + cache_read + cache_creation（inclusive）。
  // 999 read / 1 fresh / 0 write ⇒ 99.9%，永远不可能 >100%。
  {
    const s = summarizeRuns(
      [
        run({
          run_id: 'anthropic-1',
          requests: 20,
          prompt_tokens: 100_000,
          cache_read_input_tokens: 99_900,
          cache_creation_input_tokens: 0,
        }),
      ],
      T0,
    );
    check(
      'a. Anthropic: input_share = cache_read / prompt(inclusive)',
      close(s.input_share, 0.999),
      String(s.input_share),
    );
    check('a. Anthropic: 命中率不越界 (0..1)', s.input_share !== undefined && s.input_share <= 1);
    check(
      'a. Anthropic: read+write 都上报 ⇒ prefix_health 可算',
      s.prefix_health_unavailable === undefined,
      String(s.prefix_health_unavailable),
    );
  }

  // ------------------------------------------------------------ (b) OpenAI 式
  // prompt_tokens 已含 cached_tokens；适配器只补 cache_read，cache_creation 缺省。
  {
    const s = summarizeRuns(
      [
        run({
          run_id: 'openai-1',
          requests: 10,
          prompt_tokens: 2_000,
          cache_read_input_tokens: 1_500,
        }),
      ],
      T0,
    );
    check(
      'b. OpenAI 式: input_share = cached / prompt_tokens',
      close(s.input_share, 0.75),
      String(s.input_share),
    );
    check(
      'b. OpenAI 式: 未上报写 ⇒ prefix_health 不可用(write-not-reported)',
      s.prefix_health_unavailable === 'write-not-reported',
      String(s.prefix_health_unavailable),
    );
  }

  // ----------------------------------------------------- (c) 字段缺省 ⇒ 不可用
  {
    const s = summarizeRuns(
      [
        run({ run_id: 'no-cache-1', requests: 5, prompt_tokens: 5_000 }),
        run({ run_id: 'no-cache-2', requests: 5, prompt_tokens: 7_000 }),
      ],
      T0,
    );
    check(
      'c. 完全不报缓存 ⇒ input_share 不可用',
      s.input_share === undefined,
      String(s.input_share),
    );
    check(
      'c. 不可用原因是 no-cache-fields',
      s.input_share_unavailable === 'no-cache-fields',
      String(s.input_share_unavailable),
    );
    check('c. 完全不报缓存 ⇒ prefix_health 不可用', s.prefix_health === undefined);
  }

  // ------------------------------------------------------------ (d) prompt=0
  {
    const s = summarizeRuns(
      [
        run({
          run_id: 'empty-1',
          requests: 1,
          prompt_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      ],
      T0,
    );
    check(
      'd. prompt=0 ⇒ 不可用而不是 NaN',
      s.input_share === undefined && s.input_share_unavailable === 'zero-denominator',
      String(s.input_share_unavailable),
    );
    check('d. prompt=0 ⇒ prefix_health 也不可算', s.prefix_health === undefined);
    check('d. 无 NaN', !Number.isNaN(s.input_share) && !Number.isNaN(s.prefix_health));
  }

  // ------------------------------------------- (e) 多 run：token 加权 vs 平均
  {
    const s = summarizeRuns(
      [
        run({ run_id: 'big', requests: 10, prompt_tokens: 1_000, cache_read_input_tokens: 900 }),
        run({ run_id: 'cold', requests: 10, prompt_tokens: 9_000, cache_read_input_tokens: 0 }),
      ],
      T0,
    );
    // 加权：900 / 10_000 = 0.09；按 run 平均会得到 (0.9 + 0) / 2 = 0.45
    check('e. 多 run 按 token 加权', close(s.input_share, 0.09), String(s.input_share));
    check('e. 不是按 run 平均', !close(s.input_share, 0.45));
  }

  // ----------------------------------- (e2) 段起点 0 命中不被系统性放大/低估
  // compaction 后新段首请求必然 0 命中，但它只按自己的 token 进分母。
  {
    const s = summarizeRuns(
      [
        run({ run_id: 'seg-cold', requests: 1, prompt_tokens: 1_000, cache_read_input_tokens: 0 }),
        run({
          run_id: 'seg-warm',
          requests: 99,
          prompt_tokens: 100_000,
          cache_read_input_tokens: 99_000,
        }),
      ],
      T0,
    );
    check(
      'e2. 段起点 0 命中只稀释自己的 token 份额',
      close(s.input_share, 99_000 / 101_000),
      String(s.input_share),
    );
  }

  // ----------------------------- (e3) 不报缓存的 run 不进分母（本次修复点）
  // 修复前：900 / (1_000 + 9_000) = 0.09（把「未知」当 0 命中）
  // 修复后：900 / 1_000 = 0.9（分母 = 上报了缓存字段的 run）
  {
    const s = summarizeRuns(
      [
        run({
          run_id: 'reports',
          requests: 10,
          prompt_tokens: 1_000,
          cache_read_input_tokens: 900,
        }),
        run({ run_id: 'silent', requests: 10, prompt_tokens: 9_000 }),
      ],
      T0,
    );
    check('e3. 分母只含上报缓存的 run', close(s.input_share, 0.9), String(s.input_share));
    check('e3. 未被当成 0 命中稀释', !close(s.input_share, 0.09));
    check(
      'e3. totals 仍然统计所有 run 的 token',
      s.totals.prompt_tokens === 10_000,
      String(s.totals.prompt_tokens),
    );
  }

  // ----------------------- (d2) prompt 不含缓存的 provider 必须被识别出来
  {
    const s = summarizeRuns(
      [
        run({
          run_id: 'exclusive',
          requests: 10,
          prompt_tokens: 100,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 0,
        }),
      ],
      T0,
    );
    check(
      'd2. prompt 丢了缓存部分 ⇒ prompt-not-inclusive',
      s.input_share_unavailable === 'prompt-not-inclusive',
      String(s.input_share_unavailable),
    );
  }

  // -------------------------------------------------- (d3) 写量进分母会低估
  // 锁定「展示的是 read/prompt，而不是 read/(read+fresh)」，口径漂移时能发现。
  {
    const s = summarizeRuns(
      [
        run({
          run_id: 'write-heavy',
          requests: 10,
          prompt_tokens: 1_000,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 400,
        }),
      ],
      T0,
    );
    check(
      'd3. input_share 分母含 cache_creation (read/prompt)',
      close(s.input_share, 0.5),
      String(s.input_share),
    );
    check(
      'd3. prefix_health = read/(read+write)',
      close(s.prefix_health, 500 / 900),
      String(s.prefix_health),
    );
  }

  // -------------------------------------------------------------- 真实数据模式
  const realFlag = process.argv.indexOf('--real');
  if (realFlag !== -1) {
    const dataDir = process.argv[realFlag + 1];
    if (dataDir === undefined) {
      check('real. --real 需要 data 目录', false);
    } else {
      const index = await readUsageIndex(dataDir);
      if (index === undefined) {
        check(`real. 读不到 usage index: ${dataDir}`, false);
      } else {
        const pos = index.runs.filter((r) => r.requests > 0);
        const reporting = pos.filter(
          (r) =>
            r.cache_read_input_tokens !== undefined || r.cache_creation_input_tokens !== undefined,
        );
        const promptAll = pos.reduce((a, r) => a + r.prompt_tokens, 0);
        const promptReporting = reporting.reduce((a, r) => a + r.prompt_tokens, 0);
        const read = reporting.reduce((a, r) => a + (r.cache_read_input_tokens ?? 0), 0);
        const write = reporting.reduce((a, r) => a + (r.cache_creation_input_tokens ?? 0), 0);
        const s = summarizeRuns(index.runs, Date.now());
        console.log(
          `\n[real] runs=${pos.length} reporting=${reporting.length} prompt_all=${promptAll} ` +
            `prompt_reporting=${promptReporting} read=${read} write=${write}`,
        );
        console.log(
          `[real] plugin input_share=${String(s.input_share)} (${s.input_share_unavailable ?? 'ok'}) ` +
            `prefix_health=${String(s.prefix_health)} (${s.prefix_health_unavailable ?? 'ok'})`,
        );
        check(
          'real. 分母只含上报 run 的 prompt',
          close(s.input_share, promptReporting > 0 ? read / promptReporting : undefined),
          String(s.input_share),
        );
        check(
          'real. 不报写的 provider ⇒ prefix_health 不可用',
          s.prefix_health === undefined || write > 0,
        );
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
