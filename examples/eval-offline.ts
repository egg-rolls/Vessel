/**
 * Evals 离线示例（0.4）。
 *
 * 使用真实 @vessel/evals harness 与脚本化 mock provider，不访问网络、不需要 API Key。
 * 报告由 ext 的 report.ts 写入 evals.out_dir。
 * 运行：bun run examples/eval-offline.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../packages/config/src/index';
import { executeEvalSuite } from '../src/eval-wiring';
import { PluginLoader } from '../src/plugin-loader';

function yamlPath(value: string): string {
  return value.replaceAll('\\', '/');
}

async function main(): Promise<number> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-eval-demo-'));
  const suites = path.join(base, 'evals');
  const outDir = path.join(base, 'reports');
  fs.mkdirSync(suites, { recursive: true });

  fs.writeFileSync(
    path.join(suites, 'smoke.yaml'),
    [
      'name: smoke',
      'cases:',
      '  - id: basic',
      '    input: hello',
      '    mock:',
      '      responses:',
      '        - content: hello',
      '    expect:',
      '      - type: output_contains',
      '        value: hello',
      '      - type: no_error',
    ].join('\n'),
    'utf-8',
  );

  const configPath = path.join(base, 'vessel.yaml');
  fs.writeFileSync(
    configPath,
    [
      'provider:',
      '  name: openai',
      '  model: gpt-4',
      'evals:',
      '  enabled: true',
      `  dir: ${yamlPath(suites)}`,
      `  out_dir: ${yamlPath(outDir)}`,
      '  allow_network: false',
    ].join('\n'),
    'utf-8',
  );

  try {
    const { config, validation } = await loadConfig({
      configPath,
      userConfigPath: path.join(base, 'missing-user.yaml'),
    });
    if (validation.errors.length > 0) {
      for (const error of validation.errors) console.error(error.message);
      return 2;
    }

    const { report, exitCode } = await executeEvalSuite({
      config,
      target: 'smoke',
      allowNetwork: false,
      loader: new PluginLoader(),
    });

    console.log(
      `suite=${report.suite} total=${report.total} passed=${report.passed} ` +
        `failed=${report.failed} errors=${report.errors} network=${report.network}`,
    );
    const files = fs.existsSync(outDir)
      ? fs.readdirSync(outDir).filter((name) => name.endsWith('.json'))
      : [];
    for (const file of files) console.log(`report: ${path.join(outDir, file)}`);
    console.log(`workspace: ${base} (kept for inspection)`);

    return exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = await main();
