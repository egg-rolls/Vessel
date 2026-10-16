import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  MemoryEventStream,
  MemoryPluginHost,
  type ToolContext,
  type ToolDefinition,
} from '@vessel/core';
import basicToolsPlugin, { createBasicTools } from '../src/index';

/** 临时工作目录：测试文件读写都在这里，不碰仓库 */
const workDir = mkdtempSync(path.join(tmpdir(), 'vessel-basic-tools-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 新建工具上下文（handler 单测不走 runtime，事件流不会有人应答） */
function makeContext(): ToolContext {
  return { run_id: 'test-run', messages: [], events: new MemoryEventStream() };
}

/** 从插件注册结果取工具（与 runtime 同一条路径） */
function toolOf(name: string): ToolDefinition {
  const host = new MemoryPluginHost();
  basicToolsPlugin.install(host);
  const tool = host.getTool(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

/** 在临时目录写一个文件并返回路径 */
function writeTemp(name: string, content: string): string {
  const filePath = path.join(workDir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('basic-tools 插件（注册）', () => {
  it('install 注册 bash / read / edit 三个工具，且不多不少', () => {
    const host = new MemoryPluginHost();
    basicToolsPlugin.install(host);
    expect(
      host
        .listTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['bash', 'edit', 'read']);
    expect(createBasicTools().length).toBe(3);
  });

  it('bash / edit 声明 checkPermission（危险操作），read 直接 allow', async () => {
    expect(typeof toolOf('bash').checkPermission).toBe('function');
    expect(typeof toolOf('edit').checkPermission).toBe('function');
    expect(await toolOf('read').checkPermission?.({}, makeContext())).toBe('allow');
  });

  it('bash / edit 的 checkPermission 经 requestPermission 等用户应答', async () => {
    for (const name of ['bash', 'edit']) {
      const events = new MemoryEventStream();
      const context: ToolContext = { run_id: 'perm-run', messages: [], events };
      let requestedTool: unknown;
      events.subscribe((event) => {
        if (event.type !== 'tool.permission.request') return;
        const data = event.data;
        if (typeof data === 'object' && data !== null) {
          requestedTool = (data as Record<string, unknown>).tool;
          // 模拟用户授权：应答同一个 requestId
          events.publish({
            type: 'tool.permission.response',
            run_id: event.run_id,
            data: { requestId: (data as Record<string, unknown>).requestId, decision: 'allow' },
            ts: Date.now(),
          });
        }
      });

      const decision = await toolOf(name).checkPermission?.({ probe: true }, context);
      expect(decision).toBe('allow');
      expect(requestedTool).toBe(name);
    }
  });
});

describe('bash', () => {
  it('返回 stdout 与退出码', async () => {
    const tool = toolOf('bash');
    const result = await tool.handler({ command: 'echo hello' }, makeContext());
    expect(result).toContain('退出码: 0');
    expect(result).toContain('hello');
  });

  it('非零退出码如实返回', async () => {
    const tool = toolOf('bash');
    const result = await tool.handler({ command: 'echo boom >&2; exit 3' }, makeContext());
    expect(result).toContain('退出码: 3');
    expect(result).toContain('stderr:');
    expect(result).toContain('boom');
  });

  it('超时返回错误文本而不是抛异常', async () => {
    const tool = toolOf('bash');
    const result = await tool.handler({ command: 'sleep 10', timeout_ms: 300 }, makeContext());
    expect(result).toContain('错误：命令执行超时');
    expect(result).toContain('300ms');
    expect(result).toContain('退出码:');
  });

  it('输出超过 2000 行时保留头 1000 + 尾 1000 并标注省略行数', async () => {
    const tool = toolOf('bash');
    const result = await tool.handler({ command: 'seq 1 5000' }, makeContext());
    expect(result).toContain('已省略 3000 行');

    const lines = result.split('\n');
    const markerAt = lines.findIndex((line) => line.includes('已省略'));
    expect(markerAt).toBeGreaterThan(0);
    expect(lines[markerAt - 1]).toBe('1000');
    expect(lines[markerAt + 1]).toBe('4001');
  });

  it('输出未超限时不做截断', async () => {
    const tool = toolOf('bash');
    const result = await tool.handler({ command: 'seq 1 100' }, makeContext());
    expect(result).not.toContain('已省略');
    expect(result).toContain('100');
  });

  it('cwd 生效；command 为空或 cwd 不存在时返回明确错误', async () => {
    const tool = toolOf('bash');
    // bash 报的是 MSYS 虚拟路径（/tmp/...），只比对目录名
    const inTemp = await tool.handler({ command: 'pwd', cwd: workDir }, makeContext());
    expect(inTemp).toContain(path.basename(workDir));

    expect(await tool.handler({ command: '  ' }, makeContext())).toContain('command 不能为空');
    expect(
      await tool.handler({ command: 'echo x', cwd: path.join(workDir, 'nope') }, makeContext()),
    ).toContain('cwd 不存在');
  });
});

describe('read', () => {
  it('返回带行号内容（行号从 1 开始）', async () => {
    const filePath = writeTemp('read-basic.txt', 'alpha\nbeta\ngamma\n');
    const result = await toolOf('read').handler({ path: filePath }, makeContext());
    expect(result).toBe('1\talpha\n2\tbeta\n3\tgamma');
  });

  it('offset / limit 分页，并标注截断与总行数', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join('\n');
    const filePath = writeTemp('read-page.txt', `${lines}\n`);

    const page = await toolOf('read').handler(
      { path: filePath, offset: 3, limit: 3 },
      makeContext(),
    );
    expect(page).toContain('3\tline-3');
    expect(page).toContain('4\tline-4');
    expect(page).toContain('5\tline-5');
    expect(page).not.toContain('line-6');
    expect(page).toContain('已截断，共 10 行，用 offset/limit 继续读');
    expect(page).toContain('本次已读第 3-5 行');
  });

  it('读到文件末尾时不再标注截断', async () => {
    const filePath = writeTemp('read-tail.txt', 'a\nb\nc\n');
    const result = await toolOf('read').handler(
      { path: filePath, offset: 2, limit: 100 },
      makeContext(),
    );
    expect(result).toBe('2\tb\n3\tc');
    expect(result).not.toContain('已截断');
  });

  it('文件不存在 / 指向目录 / path 为空时返回明确错误', async () => {
    const tool = toolOf('read');
    expect(await tool.handler({ path: path.join(workDir, 'nope.txt') }, makeContext())).toContain(
      '文件不存在',
    );
    expect(await tool.handler({ path: workDir }, makeContext())).toContain('是目录，不是文件');
    expect(await tool.handler({ path: '' }, makeContext())).toContain('path 不能为空');
  });

  it('offset 越界时报错而不是静默返回空', async () => {
    const filePath = writeTemp('read-short.txt', 'only-one\n');
    const result = await toolOf('read').handler({ path: filePath, offset: 99 }, makeContext());
    expect(result).toContain('超过文件总行数');
  });
});

describe('edit', () => {
  it('唯一匹配时替换成功并返回替换处数', async () => {
    const filePath = writeTemp('edit-ok.txt', 'hello world\n');
    const result = await toolOf('edit').handler(
      { path: filePath, old_string: 'world', new_string: 'vessel' },
      makeContext(),
    );
    expect(result).toContain('已替换 1 处');
    expect(readFileSync(filePath, 'utf-8')).toBe('hello vessel\n');
  });

  it('匹配 0 处时报错且不修改文件', async () => {
    const filePath = writeTemp('edit-none.txt', 'hello world\n');
    const result = await toolOf('edit').handler(
      { path: filePath, old_string: 'goodbye', new_string: 'x' },
      makeContext(),
    );
    expect(result).toContain('未找到匹配');
    expect(result).toContain('匹配 0 处');
    expect(readFileSync(filePath, 'utf-8')).toBe('hello world\n');
  });

  it('匹配多处且未开 replace_all 时报错并说明次数，且不修改文件', async () => {
    const filePath = writeTemp('edit-many.txt', 'dup\ndup\ndup\n');
    const result = await toolOf('edit').handler(
      { path: filePath, old_string: 'dup', new_string: 'x' },
      makeContext(),
    );
    expect(result).toContain('匹配到 3 处');
    expect(result).toContain('不唯一');
    expect(readFileSync(filePath, 'utf-8')).toBe('dup\ndup\ndup\n');
  });

  it('replace_all: true 才允许多处替换', async () => {
    const filePath = writeTemp('edit-all.txt', 'dup\ndup\ndup\n');
    const result = await toolOf('edit').handler(
      { path: filePath, old_string: 'dup', new_string: 'x', replace_all: true },
      makeContext(),
    );
    expect(result).toContain('已替换 3 处');
    expect(readFileSync(filePath, 'utf-8')).toBe('x\nx\nx\n');
  });

  it('new_string 里的 $& 按字面写入（不解释为替换模式）', async () => {
    const filePath = writeTemp('edit-dollar.txt', 'value\n');
    await toolOf('edit').handler(
      { path: filePath, old_string: 'value', new_string: '$&literal' },
      makeContext(),
    );
    expect(readFileSync(filePath, 'utf-8')).toBe('$&literal\n');
  });

  it('文件不存在 / old_string 为空 / path 为空时返回明确错误', async () => {
    const tool = toolOf('edit');
    expect(
      await tool.handler(
        { path: path.join(workDir, 'nope.txt'), old_string: 'a', new_string: 'b' },
        makeContext(),
      ),
    ).toContain('文件不存在');
    expect(
      await tool.handler({ path: workDir, old_string: 'a', new_string: 'b' }, makeContext()),
    ).toContain('是目录');
    expect(
      await tool.handler({ path: '', old_string: 'a', new_string: 'b' }, makeContext()),
    ).toContain('path 不能为空');
    expect(
      await tool.handler(
        { path: writeTemp('edit-empty.txt', 'x\n'), old_string: '', new_string: 'b' },
        makeContext(),
      ),
    ).toContain('old_string 不能为空');
  });
});
