/**
 * Workflow 离线示例（0.4）。
 *
 * 使用 mock provider 与真实 @vessel/workflow 引擎，不访问网络、不需要 API Key。
 * 运行：bun run examples/workflow-offline.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootstrap } from '../src/bootstrap';

function yamlPath(value: string): string {
  return value.replaceAll('\\', '/');
}

async function main(): Promise<number> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-workflow-demo-'));
  const defs = path.join(base, 'workflows');
  const runs = path.join(base, 'runs');
  fs.mkdirSync(defs, { recursive: true });

  const definitionPath = path.join(defs, 'demo.yaml');
  fs.writeFileSync(
    definitionPath,
    [
      'name: demo',
      'version: 1',
      'steps:',
      '  - id: first',
      '    type: agent',
      '    agent: owner',
      '    prompt: "Say hello."',
      '  - id: second',
      '    type: agent',
      '    agent: owner',
      '    prompt: "Repeat: {{steps.first.output}}"',
      '    depends_on: [first]',
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
      'workflow:',
      '  enabled: true',
      `  dir: ${yamlPath(defs)}`,
      `  path: ${yamlPath(runs)}`,
      '  max_parallel: 1',
    ].join('\n'),
    'utf-8',
  );

  const result = await bootstrap({
    useMock: true,
    headless: true,
    configPath,
    userConfigPath: path.join(base, 'missing-user.yaml'),
  });

  try {
    if (!result.workflows) {
      console.error('workflow controls are not available.');
      return 1;
    }

    const started = await result.workflows.start(definitionPath);
    console.log(`workflow run: ${started.workflowRunId}`);

    const outcome = await started.done;
    console.log(`workflow outcome: ${outcome.status}`);

    const list = await result.workflows.listRuns();
    for (const run of list) {
      console.log(
        `  ${run.workflow_run_id} ${run.workflow_name} ${run.status} ` +
          `${run.completed_steps}/${run.step_count}`,
      );
    }

    return outcome.status === 'completed' ? 0 : 1;
  } finally {
    await result.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

process.exitCode = await main();
