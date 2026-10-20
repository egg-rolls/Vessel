import { afterAll, describe, expect, it } from 'bun:test';
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

/** 自动应答权限请求为 allow 的上下文（bash 的 requestPermission 需要应答） */
function makeAllowContext(): ToolContext {
  const events = new MemoryEventStream();
  const context: ToolContext = { run_id: 'perm-run', messages: [], events };
  events.subscribe((event) => {
    if (event.type !== 'tool.permission.request') return;
    const data = event.data;
    if (typeof data === 'object' && data !== null) {
      events.publish({
        type: 'tool.permission.response',
        run_id: event.run_id,
        data: { requestId: (data as Record<string, unknown>).requestId, decision: 'allow' },
        ts: Date.now(),
      });
    }
  });
  return context;
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

  it('bash cwd 越界 ask、根内 allow', async () => {
    const allowed = path.join(workDir, 'bash-root');
    mkdirSync(allowed, { recursive: true });
    const outside = path.join(workDir, 'bash-outside');
    mkdirSync(outside, { recursive: true });
    const tool = configuredTool('bash', { allowedRoots: [allowed] });

    expect(await tool.checkPermission?.({ command: 'pwd', cwd: outside }, makeContext())).toBe(
      'ask',
    );
    expect(await tool.checkPermission?.({ command: 'pwd', cwd: allowed }, makeAllowContext())).toBe(
      'allow',
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
