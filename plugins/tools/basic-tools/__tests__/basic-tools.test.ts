import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  MemoryEventStream,
  MemoryPluginHost,
  type ToolContext,
  type ToolDefinition,
} from '@vessel-agent/core';
import { PermissionPolicy, type RuntimePermissionConfig } from '@vessel-agent/core/policy';
import basicToolsPlugin, {
  type BasicToolsConfig,
  createBasicTools,
  parseBasicToolsConfig,
} from '../src/index';

/** 临时工作目录：测试文件读写都在这里，不碰仓库 */
const workDir = mkdtempSync(path.join(tmpdir(), 'vessel-basic-tools-'));

/** 大结果落盘目录固定在临时目录，避免写用户数据目录 */
process.env.VESSEL_TOOL_OUTPUT_DIR = path.join(workDir, 'tool-output');

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

/** 按插件配置构造工具（与 install 同一条路径） */
function configuredTool(name: string, config: BasicToolsConfig): ToolDefinition {
  const tool = createBasicTools(config).find((item) => item.name === name);
  if (!tool) throw new Error(`tool not created: ${name}`);
  return tool;
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

  it('read 可进入并行批次；有副作用的 bash / edit 不并行', () => {
    expect(toolOf('read').concurrencySafe).toBe(true);
    expect(toolOf('bash').concurrencySafe).not.toBe(true);
    expect(toolOf('edit').concurrencySafe).not.toBe(true);
  });

  it('bash / edit 声明 checkPermission（危险操作），read 直接 allow', async () => {
    expect(typeof toolOf('bash').checkPermission).toBe('function');
    expect(typeof toolOf('edit').checkPermission).toBe('function');
    expect(await toolOf('read').checkPermission?.({}, makeContext())).toBe('allow');
  });

  it('bash / edit 的 checkPermission 只返回 ask，不自行发权限请求', async () => {
    for (const name of ['bash', 'edit']) {
      const events = new MemoryEventStream();
      const context: ToolContext = { run_id: 'perm-run', messages: [], events };
      const requests: unknown[] = [];
      events.subscribe((event) => {
        if (event.type === 'tool.permission.request') requests.push(event);
      });

      const decision = await toolOf(name).checkPermission?.({ probe: true }, context);
      // 统一由 core PermissionPolicy 提问；工具层不得重复发请求
      expect(decision).toBe('ask');
      expect(requests).toHaveLength(0);
    }
  });
});

describe('core PermissionPolicy 统一提问（bash / edit）', () => {
  interface AuthorizeTrace {
    requests: unknown[];
    error: unknown;
  }

  /** 用真实 PermissionPolicy 跑一次 authorize；请求一到就按 allow 应答（可选 remember）。 */
  async function authorizeWithPolicy(
    tool: ToolDefinition,
    args: unknown,
    config?: RuntimePermissionConfig,
    remember = false,
  ): Promise<AuthorizeTrace> {
    const events = new MemoryEventStream();
    const requests: unknown[] = [];
    const policy = new PermissionPolicy(events, config);
    events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      requests.push(event);
      events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: {
          requestId: (event.data as Record<string, unknown>).requestId,
          decision: 'allow',
          ...(remember ? { remember: true } : {}),
        },
        ts: Date.now(),
      });
    });

    const ctx: ToolContext = { run_id: 'perm-run', messages: [], events };
    let error: unknown;
    try {
      await policy.authorize(tool, args, ctx);
    } catch (caught) {
      error = caught;
    }
    return { requests, error };
  }

  it('autoApprove 命中 bash 时不发 tool.permission.request', async () => {
    const { requests, error } = await authorizeWithPolicy(
      toolOf('bash'),
      { command: 'echo hi' },
      { autoApprove: ['bash'] },
    );
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('普通 bash 只发一次 tool.permission.request', async () => {
    const { requests, error } = await authorizeWithPolicy(toolOf('bash'), { command: 'echo hi' });
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('neverAutoApprove 命中 bash 时仍 ask', async () => {
    const { requests, error } = await authorizeWithPolicy(
      toolOf('bash'),
      { command: 'echo hi' },
      {
        autoApprove: ['bash'],
        neverAutoApprove: ['bash'],
      },
    );
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('敏感路径即使 autoApprove 也直接 deny，不发请求', async () => {
    const { requests, error } = await authorizeWithPolicy(
      toolOf('bash'),
      { command: 'cat ~/.ssh/id_rsa' },
      { autoApprove: ['bash'] },
    );
    expect((error as Error).message).toContain('denied by permission policy');
    expect(requests).toHaveLength(0);
  });

  it('autoApprove / 普通 / 敏感路径对 edit 同样生效', async () => {
    const args = { path: 'probe.txt', old_string: 'a', new_string: 'b' };

    const auto = await authorizeWithPolicy(toolOf('edit'), args, { autoApprove: ['edit'] });
    expect(auto.error).toBeUndefined();
    expect(auto.requests).toHaveLength(0);

    const normal = await authorizeWithPolicy(toolOf('edit'), args);
    expect(normal.error).toBeUndefined();
    expect(normal.requests).toHaveLength(1);

    const denied = await authorizeWithPolicy(
      toolOf('edit'),
      { path: path.join(homedir(), '.ssh', 'id_rsa'), old_string: 'a', new_string: 'b' },
      { autoApprove: ['edit'] },
    );
    expect((denied.error as Error).message).toContain('denied by permission policy');
    expect(denied.requests).toHaveLength(0);
  });

  it('用户选择 always（remember）后，后续同工具不再发请求', async () => {
    const events = new MemoryEventStream();
    const requests: unknown[] = [];
    const policy = new PermissionPolicy(events);
    events.subscribe((event) => {
      if (event.type !== 'tool.permission.request') return;
      requests.push(event);
      events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: {
          requestId: (event.data as Record<string, unknown>).requestId,
          decision: 'allow',
          remember: true,
        },
        ts: Date.now(),
      });
    });
    const ctx: ToolContext = { run_id: 'perm-run', messages: [], events };

    await policy.authorize(toolOf('bash'), { command: 'echo one' }, ctx);
    await policy.authorize(toolOf('bash'), { command: 'echo two' }, ctx);
    expect(requests).toHaveLength(1);
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

  it('2000 行不截断，2001 行截断并标注 1 行', async () => {
    const tool = toolOf('bash');
    const exact = await tool.handler({ command: 'seq 1 2000' }, makeContext());
    expect(exact).not.toContain('已省略');

    const over = await tool.handler({ command: 'seq 1 2001' }, makeContext());
    expect(over).toContain('已省略 1 行');
  });

  it('输出超过 2MB 时丢弃其余部分并标注', async () => {
    const tool = toolOf('bash');
    const command = `bun -e "process.stdout.write('x'.repeat(3000000))"`;
    const result = await tool.handler({ command }, makeContext());
    expect(result).toContain('输出超过 2MB');
    expect(result.length).toBeLessThan(2_200_000);
  });

  it('timeout_ms 为 0 或负数时明确报错', async () => {
    const tool = toolOf('bash');
    expect(await tool.handler({ command: 'echo x', timeout_ms: 0 }, makeContext())).toContain(
      '必须为正数',
    );
    expect(await tool.handler({ command: 'echo x', timeout_ms: -5 }, makeContext())).toContain(
      '必须为正数',
    );
  });

  it('CRLF 输出在返回文本中被归一（不残留 \\r）', async () => {
    const tool = toolOf('bash');
    const result = await tool.handler({ command: "printf 'a\\r\\nb\\r\\n'" }, makeContext());
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).not.toContain('\r');
  });

  it('运行中 abort 会杀死子进程并在 1s 内返回 cancelled', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = toolOf('bash').handler(
      { command: 'sleep 10' },
      { ...makeContext(), signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    const result = await pending;

    expect(result).toContain('cancelled');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('启动前已 abort 时不执行命令', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await toolOf('bash').handler(
      { command: 'echo should-not-run' },
      { ...makeContext(), signal: controller.signal },
    );
    expect(result).toContain('cancelled');
    expect(result).not.toContain('should-not-run');
  });

  it('超限输出落盘：返回绝对路径且文件保留完整行', async () => {
    const result = await toolOf('bash').handler(
      { command: 'seq 1 5000' },
      { ...makeContext(), session_id: 'sess-1' },
    );
    const marker = '完整输出已写入：';
    const start = result.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const pathStart = start + marker.length;
    const pathEnd = result.indexOf('（', pathStart);
    const file = result.slice(pathStart, pathEnd);

    expect(file).toContain(path.join('tool-output', 'sess-1'));
    expect(existsSync(file)).toBe(true);
    const saved = readFileSync(file, 'utf-8');
    const dataLines = saved.split('\n').filter((line) => /^\d+$/.test(line));
    expect(dataLines).toHaveLength(5000);
  });

  it('未超限输出不落盘', async () => {
    const result = await toolOf('bash').handler({ command: 'echo small' }, makeContext());
    expect(result).not.toContain('完整输出已写入');
  });
});

describe('bash 命令文本 denylist（F2）', () => {
  it('cat ~/.vessel/config.yaml 未被拒绝时命令会执行并可能读出密钥', async () => {
    const result = await toolOf('bash').handler(
      { command: 'cat ~/.vessel/config.yaml' },
      makeContext(),
    );
    expect(result).toContain('path_denied');
    expect(result).toContain('不是沙箱');
    // 拒绝发生在执行前：没有退出码行
    expect(result).not.toContain('退出码');
  });

  it('$HOME 写法的凭据路径绕过文本检查', async () => {
    const result = await toolOf('bash').handler(
      { command: 'cat $HOME/.vessel/config.yaml' },
      makeContext(),
    );
    expect(result).toContain('path_denied');
    expect(result).not.toContain('退出码');
  });

  it('绝对路径写法的凭据路径绕过文本检查', async () => {
    const absolute = path.join(homedir(), '.ssh', 'id_rsa');
    const result = await toolOf('bash').handler({ command: `echo ${absolute}` }, makeContext());
    expect(result).toContain('path_denied');
  });

  it('Windows 分隔符与大小写写法绕过文本检查', async () => {
    const tool = toolOf('bash');
    expect(await tool.checkPermission?.({ command: 'cat ~\\.SSH\\id_rsa' }, makeContext())).toBe(
      'deny',
    );
  });

  it('checkPermission 对命中命令直接 deny，执行前不进入用户确认', async () => {
    const decision = await toolOf('bash').checkPermission?.(
      { command: 'cat ~/.aws/credentials' },
      makeContext(),
    );
    expect(decision).toBe('deny');
  });

  it('普通命令被 denylist 误伤而拒绝执行', async () => {
    writeFileSync(path.join(workDir, 'README.md'), 'readme-body\n', 'utf-8');
    const result = await toolOf('bash').handler(
      { command: 'cat ./README.md', cwd: workDir },
      makeContext(),
    );
    expect(result).toContain('退出码: 0');
    expect(result).toContain('readme-body');
    expect(result).not.toContain('path_denied');
  });

  it('含 ~ 但不指向 denylist 的路径被误伤而拒绝', async () => {
    const tool = toolOf('bash');
    const notes = await tool.handler({ command: 'echo ~/notes.txt' }, makeContext());
    expect(notes).not.toContain('path_denied');
    expect(notes).toContain('退出码: 0');

    // ~/.sshd 不是 ~/.ssh：前缀相似不应命中
    const similar = await tool.handler({ command: 'echo ~/.sshd' }, makeContext());
    expect(similar).not.toContain('path_denied');
    expect(similar).toContain('退出码: 0');
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

  it('offset / limit 必须为正整数', async () => {
    const filePath = writeTemp('read-int.txt', 'a\nb\n');
    const tool = toolOf('read');
    expect(await tool.handler({ path: filePath, offset: 0 }, makeContext())).toContain(
      'offset 必须是不小于 1 的整数',
    );
    expect(await tool.handler({ path: filePath, offset: 1.5 }, makeContext())).toContain(
      'offset 必须是不小于 1 的整数',
    );
    expect(await tool.handler({ path: filePath, limit: 0 }, makeContext())).toContain(
      'limit 必须是不小于 1 的整数',
    );
    expect(await tool.handler({ path: filePath, limit: 2.5 }, makeContext())).toContain(
      'limit 必须是不小于 1 的整数',
    );
  });

  it('CRLF 文件按行归一显示', async () => {
    const filePath = writeTemp('read-crlf.txt', 'a\r\nb\r\n');
    const result = await toolOf('read').handler({ path: filePath }, makeContext());
    expect(result).toBe('1\ta\n2\tb');
  });

  it('二进制文件（含 NUL）拒绝读取', async () => {
    const filePath = path.join(workDir, 'read-binary.bin');
    writeFileSync(filePath, Buffer.from([0x61, 0x00, 0x62]));
    const result = await toolOf('read').handler({ path: filePath }, makeContext());
    expect(result).toContain('二进制文件');
  });

  it('超过 8MB 的文件拒绝整读并提示分块', async () => {
    const filePath = path.join(workDir, 'read-huge.txt');
    writeFileSync(filePath, 'x'.repeat(9 * 1024 * 1024));
    const result = await toolOf('read').handler({ path: filePath }, makeContext());
    expect(result).toContain('文件过大');
    expect(result).toContain('bash');
  });

  it('abort 后 read 返回 cancelled 而不是文件内容', async () => {
    const filePath = writeTemp('read-cancelled.txt', 'secret\n');
    const controller = new AbortController();
    controller.abort();
    const result = await toolOf('read').handler(
      { path: filePath },
      { ...makeContext(), signal: controller.signal },
    );
    expect(result).toContain('cancelled');
    expect(result).not.toContain('secret');
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

  it('CRLF 文件用 LF old_string 不匹配时给出换行提示', async () => {
    const filePath = writeTemp('edit-crlf.txt', 'a\r\nb\r\nc\r\n');
    const result = await toolOf('edit').handler(
      { path: filePath, old_string: 'b\nc', new_string: 'x' },
      makeContext(),
    );
    expect(result).toContain('未找到匹配');
    expect(result).toContain('CRLF');
    expect(readFileSync(filePath, 'utf-8')).toBe('a\r\nb\r\nc\r\n');
  });

  it('替换成功后不残留临时文件', async () => {
    const filePath = writeTemp('edit-atomic.txt', 'hello\n');
    await toolOf('edit').handler(
      { path: filePath, old_string: 'hello', new_string: 'world' },
      makeContext(),
    );
    const entries = readdirSync(workDir);
    expect(entries.some((name) => name.includes('.vessel-tmp'))).toBe(false);
    expect(readFileSync(filePath, 'utf-8')).toBe('world\n');
  });

  it('replace_all 只认布尔 true', async () => {
    const filePath = writeTemp('edit-nonbool.txt', 'dup\ndup\n');
    const result = await toolOf('edit').handler(
      { path: filePath, old_string: 'dup', new_string: 'x', replace_all: 'true' },
      makeContext(),
    );
    expect(result).toContain('不唯一');
  });

  it('重叠出现按非重叠计数（aaa 中的 aa 算 1 处）', async () => {
    const filePath = writeTemp('edit-overlap.txt', 'aaa');
    const result = await toolOf('edit').handler(
      { path: filePath, old_string: 'aa', new_string: 'x' },
      makeContext(),
    );
    expect(result).toContain('已替换 1 处');
    expect(readFileSync(filePath, 'utf-8')).toBe('xa');
  });

  it('abort 后 edit 不写文件', async () => {
    const filePath = writeTemp('edit-cancelled.txt', 'before\n');
    const controller = new AbortController();
    controller.abort();
    const result = await toolOf('edit').handler(
      { path: filePath, old_string: 'before', new_string: 'after' },
      { ...makeContext(), signal: controller.signal },
    );
    expect(result).toContain('cancelled');
    expect(readFileSync(filePath, 'utf-8')).toBe('before\n');
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

describe('路径边界（E1）', () => {
  /** 内置 denylist 里的代表路径（不要求文件真实存在） */
  const sensitivePaths = [
    path.join(homedir(), '.ssh', 'id_rsa'),
    path.join(homedir(), '.aws', 'credentials'),
    path.join(homedir(), '.gnupg', 'secring.gpg'),
    path.join(homedir(), '.vessel', 'config.yaml'),
  ];

  it('配置解析兼容 snake_case / camelCase，未知键忽略', () => {
    expect(
      parseBasicToolsConfig({ allowed_roots: ['/a'], deny_paths: ['~/.custom'], unknown: 1 }),
    ).toEqual({ allowedRoots: ['/a'], denyPaths: ['~/.custom'] });
    expect(parseBasicToolsConfig({ allowedRoots: ['/b'], denyPaths: ['/c'] })).toEqual({
      allowedRoots: ['/b'],
      denyPaths: ['/c'],
    });
    expect(parseBasicToolsConfig(null)).toEqual({});
    expect(parseBasicToolsConfig({ allowed_roots: ['/a', 42, ''], deny_paths: 'nope' })).toEqual({
      allowedRoots: ['/a'],
    });
  });

  it('install 把 plugins[].config 透传给工具', async () => {
    const allowed = path.join(workDir, 'install-root');
    mkdirSync(allowed, { recursive: true });
    const host = new MemoryPluginHost();
    await basicToolsPlugin.install(host, { config: { allowed_roots: [allowed] } });
    const read = host.getTool('read');
    expect(await read?.checkPermission?.({ path: workDir }, makeContext())).toBe('ask');
    expect(await read?.checkPermission?.({ path: allowed }, makeContext())).toBe('allow');
  });

  it('内置敏感路径的 checkPermission 返回 deny', async () => {
    for (const target of sensitivePaths) {
      expect(await toolOf('read').checkPermission?.({ path: target }, makeContext())).toBe('deny');
    }
  });

  it('read handler 防御性拒绝敏感路径（绕过 checkPermission 也不读）', async () => {
    const result = await toolOf('read').handler({ path: sensitivePaths[0] }, makeContext());
    expect(result).toContain('敏感路径拒绝列表');
    expect(result).not.toContain('\t');
  });

  it('allowed_roots 内 allow、根外 ask', async () => {
    const allowed = path.join(workDir, 'boundary-allowed');
    mkdirSync(allowed, { recursive: true });
    const inside = path.join(allowed, 'inside.txt');
    writeFileSync(inside, 'inside\n', 'utf-8');
    const outside = writeTemp('boundary-outside.txt', 'outside\n');
    const tool = configuredTool('read', { allowedRoots: [allowed] });

    expect(await tool.checkPermission?.({ path: inside }, makeContext())).toBe('allow');
    expect(await tool.checkPermission?.({ path: outside }, makeContext())).toBe('ask');
    expect(await tool.handler({ path: inside }, makeContext())).toBe('1\tinside');
  });

  it('`..` 不能逃出 allowed_roots', async () => {
    const root = path.join(workDir, 'dotdot-root');
    const nested = path.join(root, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, 'secret.txt'), 'secret\n', 'utf-8');
    const tool = configuredTool('read', { allowedRoots: [nested] });
    const escaped = path.join(nested, '..', 'secret.txt');

    expect(await tool.checkPermission?.({ path: escaped }, makeContext())).toBe('ask');
  });

  it('符号链接指向根外时不被 allowed_roots 蒙混', async () => {
    const outside = path.join(workDir, 'symlink-outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'secret\n', 'utf-8');
    const allowed = path.join(workDir, 'symlink-allowed');
    mkdirSync(allowed, { recursive: true });
    const link = path.join(allowed, 'escape');
    // Windows 目录符号链接需要特权，用 junction 表达同一语义
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const tool = configuredTool('read', { allowedRoots: [allowed] });
    expect(
      await tool.checkPermission?.({ path: path.join(link, 'secret.txt') }, makeContext()),
    ).toBe('ask');
  });

  it('自定义 deny_paths 与内置 denylist 合并，且 deny 优先于 allow', async () => {
    const secretDir = path.join(workDir, 'custom-secret');
    mkdirSync(secretDir, { recursive: true });
    const file = path.join(secretDir, 'token.txt');
    writeFileSync(file, 'token\n', 'utf-8');
    const tool = configuredTool('read', {
      allowedRoots: [workDir],
      denyPaths: [secretDir],
    });

    expect(await tool.checkPermission?.({ path: file }, makeContext())).toBe('deny');
    expect(await tool.checkPermission?.({ path: sensitivePaths[1] }, makeContext())).toBe('deny');
    expect(await tool.handler({ path: file }, makeContext())).toContain('敏感路径拒绝列表');
  });

  it('bash cwd 越界与根内都属于 ask（路径只决定 deny 与否）', async () => {
    const allowed = path.join(workDir, 'bash-root');
    mkdirSync(allowed, { recursive: true });
    const outside = path.join(workDir, 'bash-outside');
    mkdirSync(outside, { recursive: true });
    const tool = configuredTool('bash', { allowedRoots: [allowed] });

    expect(await tool.checkPermission?.({ command: 'pwd', cwd: outside }, makeContext())).toBe(
      'ask',
    );
    expect(await tool.checkPermission?.({ command: 'pwd', cwd: allowed }, makeContext())).toBe(
      'ask',
    );
  });

  it('bash cwd 命中 denylist 时直接拒绝，handler 不再执行命令', async () => {
    const secretDir = path.join(workDir, 'bash-deny');
    mkdirSync(secretDir, { recursive: true });
    const tool = configuredTool('bash', { denyPaths: [secretDir] });

    expect(await tool.checkPermission?.({ command: 'pwd', cwd: secretDir }, makeContext())).toBe(
      'deny',
    );
    const result = await tool.handler(
      { command: 'echo should-not-run', cwd: secretDir },
      makeContext(),
    );
    expect(result).toContain('敏感路径拒绝列表');
    expect(result).not.toContain('should-not-run');
  });
});

describe('默认工作目录（cwd / working_dir）', () => {
  /** 建一个临时子目录并返回绝对路径 */
  function makeDir(name: string): string {
    const dir = path.join(workDir, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('配置解析：cwd 为主名，兼容 working_dir，非法值忽略', () => {
    expect(parseBasicToolsConfig({ cwd: '/a' })).toEqual({ cwd: '/a' });
    expect(parseBasicToolsConfig({ working_dir: '~/work' })).toEqual({ cwd: '~/work' });
    expect(parseBasicToolsConfig({ cwd: '/a', working_dir: '/b' })).toEqual({ cwd: '/a' });
    expect(parseBasicToolsConfig({ cwd: '', working_dir: '/b' })).toEqual({ cwd: '/b' });
    expect(parseBasicToolsConfig({ cwd: 42 })).toEqual({});
    expect(parseBasicToolsConfig({ cwd: '   ' })).toEqual({});
  });

  it('bash 未传 cwd 时落在 baseCwd；显式 cwd 覆盖 baseCwd', async () => {
    const base = makeDir('cwd-bash-base');
    const explicit = makeDir('cwd-bash-explicit');
    const tool = configuredTool('bash', { cwd: base });

    const defaulted = await tool.handler({ command: 'pwd' }, makeContext());
    expect(defaulted).toContain(path.basename(base));

    const overridden = await tool.handler({ command: 'pwd', cwd: explicit }, makeContext());
    expect(overridden).toContain(path.basename(explicit));
    expect(overridden).not.toContain(path.basename(base));
  });

  it('未配置 cwd 时仍使用 process.cwd()（旧行为）', async () => {
    const result = await toolOf('bash').handler({ command: 'pwd' }, makeContext());
    expect(result).toContain(path.basename(process.cwd()));
  });

  it('cwd 支持 ~ 展开', async () => {
    const tool = configuredTool('bash', { cwd: '~' });
    const result = await tool.handler({ command: 'pwd' }, makeContext());
    expect(result).toContain(path.basename(homedir()));
  });

  it('working_dir 别名经插件配置端到端生效', async () => {
    const base = makeDir('cwd-alias-base');
    const host = new MemoryPluginHost();
    await basicToolsPlugin.install(host, { config: { working_dir: base } });
    const result = await host.getTool('bash')?.handler({ command: 'pwd' }, makeContext());
    expect(result).toContain(path.basename(base));
  });

  it('read 相对路径按 baseCwd 解析，绝对路径不变', async () => {
    const base = makeDir('cwd-read-base');
    writeFileSync(path.join(base, 'relative.txt'), 'from-base\n', 'utf-8');
    const absolute = writeTemp('cwd-read-absolute.txt', 'from-absolute\n');
    const tool = configuredTool('read', { cwd: base });

    expect(await tool.handler({ path: 'relative.txt' }, makeContext())).toBe('1\tfrom-base');
    expect(await tool.handler({ path: absolute }, makeContext())).toBe('1\tfrom-absolute');
    expect(await tool.checkPermission?.({ path: 'relative.txt' }, makeContext())).toBe('allow');
  });

  it('edit 相对路径按 baseCwd 解析', async () => {
    const base = makeDir('cwd-edit-base');
    writeFileSync(path.join(base, 'relative.txt'), 'before\n', 'utf-8');
    const tool = configuredTool('edit', { cwd: base });

    const result = await tool.handler(
      { path: 'relative.txt', old_string: 'before', new_string: 'after' },
      makeContext(),
    );
    expect(result).toContain('已替换 1 处');
    expect(readFileSync(path.join(base, 'relative.txt'), 'utf-8')).toBe('after\n');
  });

  it('baseCwd 命中 denylist 时 bash / read 仍拒绝', async () => {
    const secret = makeDir('cwd-denied');
    writeFileSync(path.join(secret, 'token.txt'), 'token\n', 'utf-8');

    const bash = configuredTool('bash', { cwd: secret, denyPaths: [secret] });
    expect(await bash.checkPermission?.({ command: 'pwd' }, makeContext())).toBe('deny');
    const bashResult = await bash.handler({ command: 'echo should-not-run' }, makeContext());
    expect(bashResult).toContain('敏感路径拒绝列表');
    expect(bashResult).not.toContain('should-not-run');

    const read = configuredTool('read', { cwd: secret, denyPaths: [secret] });
    expect(await read.checkPermission?.({ path: 'token.txt' }, makeContext())).toBe('deny');
    expect(await read.handler({ path: 'token.txt' }, makeContext())).toContain('敏感路径拒绝列表');
  });

  it('baseCwd 不放宽 allowed_roots：根外 ask、根内 allow', async () => {
    const allowed = makeDir('cwd-allowed');
    const outside = makeDir('cwd-outside');
    writeFileSync(path.join(outside, 'outside.txt'), 'outside\n', 'utf-8');

    const insideBash = configuredTool('bash', { cwd: allowed, allowedRoots: [allowed] });
    expect(await insideBash.checkPermission?.({ command: 'pwd' }, makeContext())).toBe('ask');

    const outsideBash = configuredTool('bash', { cwd: outside, allowedRoots: [allowed] });
    expect(await outsideBash.checkPermission?.({ command: 'pwd' }, makeContext())).toBe('ask');

    const outsideRead = configuredTool('read', { cwd: outside, allowedRoots: [allowed] });
    expect(await outsideRead.checkPermission?.({ path: 'outside.txt' }, makeContext())).toBe('ask');
  });

  it('baseCwd 不存在时 bash / read / edit 明确报错，不回退', async () => {
    const missing = path.join(workDir, 'cwd-missing');
    const explicit = makeDir('cwd-missing-explicit');
    const absolute = writeTemp('cwd-missing-absolute.txt', 'ok\n');
    const issue = '配置的默认工作目录不存在或不是目录';

    const bash = configuredTool('bash', { cwd: missing });
    expect(await bash.handler({ command: 'echo x' }, makeContext())).toContain(issue);
    // 显式 cwd 优先，不受非法 baseCwd 影响
    expect(await bash.handler({ command: 'pwd', cwd: explicit }, makeContext())).toContain(
      path.basename(explicit),
    );

    const read = configuredTool('read', { cwd: missing });
    expect(await read.handler({ path: 'nope.txt' }, makeContext())).toContain(issue);
    // 绝对路径不依赖 baseCwd，仍可读
    expect(await read.handler({ path: absolute }, makeContext())).toBe('1\tok');

    const edit = configuredTool('edit', { cwd: missing });
    expect(
      await edit.handler({ path: 'nope.txt', old_string: 'a', new_string: 'b' }, makeContext()),
    ).toContain(issue);
  });

  it('baseCwd 指向文件时按“不是目录”报错', async () => {
    const fileBase = writeTemp('cwd-base-is-file.txt', 'x\n');
    const tool = configuredTool('bash', { cwd: fileBase });
    expect(await tool.handler({ command: 'echo x' }, makeContext())).toContain('不存在或不是目录');
  });
});

describe('edit 路径边界（0.15 E8）', () => {
  it('edit 绕过边界会改写内置敏感路径或自定义 deny_paths 文件', async () => {
    const builtin = path.join(homedir(), '.ssh', 'id_rsa');
    const builtinTool = toolOf('edit');
    expect(
      await builtinTool.checkPermission?.(
        { path: builtin, old_string: 'a', new_string: 'b' },
        makeContext(),
      ),
    ).toBe('deny');
    expect(
      await builtinTool.handler({ path: builtin, old_string: 'a', new_string: 'b' }, makeContext()),
    ).toContain('敏感路径拒绝列表');

    const secretDir = path.join(workDir, 'edit-deny-dir');
    mkdirSync(secretDir, { recursive: true });
    const file = path.join(secretDir, 'token.txt');
    writeFileSync(file, 'token\n', 'utf-8');
    const tool = configuredTool('edit', { denyPaths: [secretDir] });

    expect(
      await tool.checkPermission?.(
        { path: file, old_string: 'token', new_string: 'x' },
        makeContext(),
      ),
    ).toBe('deny');
    const result = await tool.handler(
      { path: file, old_string: 'token', new_string: 'x' },
      makeContext(),
    );
    expect(result).toContain('敏感路径拒绝列表');
    expect(readFileSync(file, 'utf-8')).toBe('token\n');
  });

  it('edit 相对路径按 baseCwd 进入 allowed_roots，根外仍 ask', async () => {
    const allowed = path.join(workDir, 'edit-allowed-root');
    mkdirSync(allowed, { recursive: true });
    writeFileSync(path.join(allowed, 'inside.txt'), 'inside\n', 'utf-8');
    const outside = writeTemp('edit-outside-root.txt', 'outside\n');
    const tool = configuredTool('edit', { allowedRoots: [allowed], cwd: allowed });

    // 相对路径按 cwd 解析后落在根内：edit 仍需确认
    expect(
      await tool.checkPermission?.(
        { path: 'inside.txt', old_string: 'inside', new_string: 'x' },
        makeContext(),
      ),
    ).toBe('ask');
    // 绝对路径在根外：ask（运行时再向用户确认）
    expect(
      await tool.checkPermission?.(
        { path: outside, old_string: 'outside', new_string: 'x' },
        makeContext(),
      ),
    ).toBe('ask');
  });
});

describe('自定义 deny_paths 参与 bash 命令文本匹配（0.15 E8）', () => {
  it('命令写出自定义敏感路径的绝对路径或 $HOME 写法时未命中', async () => {
    const secretDir = path.join(workDir, 'cmd-secret-dir');
    mkdirSync(secretDir, { recursive: true });
    const tool = configuredTool('bash', { denyPaths: [secretDir] });

    expect(
      await tool.checkPermission?.(
        {
          command: `cat ${path.join(secretDir, 'token.txt')}`,
        },
        makeContext(),
      ),
    ).toBe('deny');
    const absolute = await tool.handler(
      { command: `cat ${path.join(secretDir, 'token.txt')}` },
      makeContext(),
    );
    expect(absolute).toContain('path_denied');
    expect(absolute).not.toContain('退出码');

    const homeTool = configuredTool('bash', { denyPaths: ['~/.vessel-e8-secret'] });
    expect(
      await homeTool.checkPermission?.(
        { command: 'cat $HOME/.vessel-e8-secret/key' },
        makeContext(),
      ),
    ).toBe('deny');
    expect(
      await homeTool.handler({ command: 'cat ${HOME}/.vessel-e8-secret/key' }, makeContext()),
    ).toContain('path_denied');
  });

  it('前缀相似的非敏感路径不被自定义 deny_paths 误伤', async () => {
    const homeTool = configuredTool('bash', { denyPaths: ['~/.vessel-e8-secret'] });
    const result = await homeTool.handler(
      { command: 'echo ~/.vessel-e8-secret-backup' },
      makeContext(),
    );
    expect(result).not.toContain('path_denied');
    expect(result).toContain('退出码: 0');
  });
});

describe('内置凭据 denylist 隔离（合成 HOME）', () => {
  /** 只放合成 canary，不写任何真实密钥格式 */
  const canary = 'canary=denylist-probe';
  const homeBackup = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let fakeHome = '';

  beforeAll(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), 'vessel-home-'));
    mkdirSync(path.join(fakeHome, '.vessel'), { recursive: true });
    writeFileSync(path.join(fakeHome, '.vessel', 'config.yaml'), canary, 'utf-8');
    // 内置 denylist 与命令写法在工具构造时展开 HOME，必须先换环境再建工具
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterAll(() => {
    // 无条件恢复，避免污染同文件其它用例
    if (homeBackup.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = homeBackup.HOME;
    if (homeBackup.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = homeBackup.USERPROFILE;
    if (fakeHome !== '') rmSync(fakeHome, { recursive: true, force: true });
  });

  it(`\${HOME} 写法的内置凭据路径未被拒绝时合成 config.yaml 会被读出`, async () => {
    const tool = configuredTool('bash', {});
    expect(
      await tool.checkPermission?.({ command: `cat \${HOME}/.vessel/config.yaml` }, makeContext()),
    ).toBe('deny');

    const result = await tool.handler(
      { command: `cat \${HOME}/.vessel/config.yaml` },
      makeContext(),
    );
    expect(result).toContain('path_denied');
    expect(result).not.toContain(canary);
  });

  it('符号链接指向 deny 根时 read 绕过边界读取敏感文件', async () => {
    const secretDir = path.join(workDir, 'deny-root-secret');
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(path.join(secretDir, 'token.txt'), canary, 'utf-8');
    const link = path.join(workDir, 'deny-root-link');
    // Windows 目录符号链接需要特权，用 junction 表达同一语义
    symlinkSync(secretDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    const tool = configuredTool('read', { denyPaths: [secretDir] });

    const existing = path.join(link, 'token.txt');
    expect(await tool.checkPermission?.({ path: existing }, makeContext())).toBe('deny');
    const result = await tool.handler({ path: existing }, makeContext());
    expect(result).toContain('敏感路径拒绝列表');
    expect(result).not.toContain(canary);

    // 文件不存在：必须按“最近已存在祖先”解析后仍判定 deny
    const missing = path.join(link, 'missing.txt');
    expect(await tool.checkPermission?.({ path: missing }, makeContext())).toBe('deny');
  });
});
