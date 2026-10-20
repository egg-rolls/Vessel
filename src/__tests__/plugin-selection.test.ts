import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginDescriptor, PluginLoader, PluginSource } from '../plugin-loader';
import { PluginLoader as RealPluginLoader } from '../plugin-loader';
import {
  externalPluginsDisabled,
  formatExternalPluginWarning,
  resolvePluginNames,
  resolvePluginSelection,
} from '../plugin-selection';

/** 只用到 list() 的结构化假 loader（顺序即 list() 顺序） */
function fakeLoader(available: string[], externalNames: string[] = []): PluginLoader {
  const external = new Set(externalNames);
  const descriptors: PluginDescriptor[] = available.map((name) => ({
    name,
    category: 'tools',
    version: '0.0.0',
    entry: `/fake/${name}.ts`,
    source: external.has(name) ? 'project' : 'repo',
  }));
  return { list: () => descriptors } as unknown as PluginLoader;
}

describe('resolvePluginNames', () => {
  it('默认集排除 hook-logging 与工厂式插件', () => {
    const loader = fakeLoader(['basic-tools', 'team', 'delegate-task', 'tool-policy']);
    expect(resolvePluginNames(loader, undefined, false)).toEqual(['basic-tools', 'tool-policy']);
  });

  it('VESSEL_DEBUG 时加入 hook-logging', () => {
    const loader = fakeLoader(['basic-tools', 'tool-policy']);
    expect(resolvePluginNames(loader, undefined, true)).toEqual([
      'basic-tools',
      'tool-policy',
      'hook-logging',
    ]);
  });

  it('显式 plugins 列表会过滤掉工厂式插件（由 bootstrap 专用配置构造）', () => {
    const loader = fakeLoader([]);
    expect(
      resolvePluginNames(
        loader,
        [{ name: 'basic-tools' }, { name: 'team' }, { name: 'delegate-task' }],
        false,
      ),
    ).toEqual(['basic-tools']);
  });

  it('空数组表示不加载任何插件，不回退默认集', () => {
    const loader = fakeLoader(['basic-tools', 'tool-policy']);
    expect(resolvePluginNames(loader, [], false)).toEqual([]);
  });

  it('全 enabled:false 不回退为全部插件', () => {
    const loader = fakeLoader(['basic-tools', 'tool-policy']);
    expect(
      resolvePluginNames(
        loader,
        [
          { name: 'basic-tools', enabled: false },
          { name: 'tool-policy', enabled: false },
        ],
        false,
      ),
    ).toEqual([]);
  });

  it('声明式条目在默认集上追加插件', () => {
    const loader = fakeLoader(['basic-tools', 'tool-policy']);
    expect(resolvePluginNames(loader, undefined, false, [{ name: 'guardrail-pii' }])).toEqual([
      'basic-tools',
      'tool-policy',
      'guardrail-pii',
    ]);
  });

  it('显式 plugins 项优先于声明式 enabled:false', () => {
    const loader = fakeLoader([]);
    expect(
      resolvePluginNames(loader, [{ name: 'tool-policy', enabled: true }], false, [
        { name: 'tool-policy', enabled: false },
      ]),
    ).toEqual(['tool-policy']);
  });

  it('显式 enabled:false 不被声明式条目重新启用', () => {
    const loader = fakeLoader([]);
    expect(
      resolvePluginNames(loader, [{ name: 'tool-policy', enabled: false }], false, [
        { name: 'tool-policy' },
      ]),
    ).toEqual([]);
  });

  it('空 plugins 数组不回退默认集，但声明式条目仍可 opt-in', () => {
    const loader = fakeLoader(['basic-tools', 'tool-policy']);
    expect(resolvePluginNames(loader, [], false, [{ name: 'tool-policy' }])).toEqual([
      'tool-policy',
    ]);
  });
});

describe('resolvePluginSelection（0.7.1 插件信任边界）', () => {
  it('默认选中外部插件，并返回 external 告警数据', () => {
    const loader = fakeLoader(['basic-tools', 'evil', 'personal'], ['evil', 'personal']);
    const selection = resolvePluginSelection(loader, undefined, false, [], {});

    expect(selection.names).toEqual(['basic-tools', 'evil', 'personal']);
    expect(selection.external.map((descriptor) => descriptor.name)).toEqual(['evil', 'personal']);
    expect(selection.external.every((descriptor) => descriptor.source !== 'repo')).toBe(true);
  });

  it('VESSEL_NO_EXTERNAL_PLUGINS=1 时默认集只含仓库插件', () => {
    const loader = fakeLoader(['basic-tools', 'evil'], ['evil']);
    const selection = resolvePluginSelection(loader, undefined, false, [], {
      VESSEL_NO_EXTERNAL_PLUGINS: '1',
    });

    expect(selection.names).toEqual(['basic-tools']);
    expect(selection.external).toEqual([]);
  });

  it('VESSEL_NO_EXTERNAL_PLUGINS=true（大小写不敏感）同样生效', () => {
    const loader = fakeLoader(['basic-tools', 'evil'], ['evil']);
    expect(
      resolvePluginSelection(loader, undefined, false, [], {
        VESSEL_NO_EXTERNAL_PLUGINS: 'TRUE',
      }).names,
    ).toEqual(['basic-tools']);
    expect(externalPluginsDisabled({ VESSEL_NO_EXTERNAL_PLUGINS: '0' })).toBe(false);
  });

  it('opt-out 下显式 plugins 仍可加载外部插件（显式即信任）', () => {
    const loader = fakeLoader(['basic-tools', 'evil'], ['evil']);
    const selection = resolvePluginSelection(loader, [{ name: 'evil' }], false, [], {
      VESSEL_NO_EXTERNAL_PLUGINS: '1',
    });

    expect(selection.names).toEqual(['evil']);
    // 显式列表已由用户确认，不进入启动告警。
    expect(selection.external).toEqual([]);
  });

  it('同名优先级：repo > project > user', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-select-'));
    try {
      const repo = path.join(root, 'repo');
      const project = path.join(root, 'project');
      const user = path.join(root, 'user');
      writePlugin(path.join(repo, 'tools', 'shared'), '@vessel-agent/shared');
      writePlugin(path.join(repo, 'tools', 'repo-only'), '@vessel-agent/repo-only');
      writePlugin(path.join(project, 'shared'), 'shared');
      writePlugin(path.join(project, 'project-only'), 'project-only');
      writePlugin(path.join(user, 'shared'), 'shared');
      writePlugin(path.join(user, 'user-only'), 'user-only');

      const loader = new RealPluginLoader({
        roots: [
          { dir: repo, source: 'repo', layout: 'category' },
          { dir: project, source: 'project', layout: 'auto' },
          { dir: user, source: 'user', layout: 'auto' },
        ],
      });
      const selection = resolvePluginSelection(loader, undefined, false, [], {});

      expect(selection.names).toEqual(['project-only', 'repo-only', 'shared', 'user-only']);
      // 同名 shared 由 repo 胜出；外部列表只剩项目/用户独有的插件。
      expect(
        selection.external.map((descriptor) => `${descriptor.source}:${descriptor.name}`),
      ).toEqual(['project:project-only', 'user:user-only']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('外部插件告警', () => {
  it('列出数量、名称与来源，并提示 opt-out', () => {
    const warning = formatExternalPluginWarning([
      descriptor('evil', 'project'),
      descriptor('personal', 'user'),
      descriptor('npm-plugin', 'node_modules'),
    ]);

    expect(warning).toContain('3 external plugin(s)');
    expect(warning).toContain('project: evil');
    expect(warning).toContain('user: personal');
    expect(warning).toContain('node_modules: npm-plugin');
    expect(warning).toContain('VESSEL_NO_EXTERNAL_PLUGINS=1');
  });

  it('没有外部插件时不告警', () => {
    expect(formatExternalPluginWarning([])).toBeNull();
  });
});

describe('opt-out 集成（临时 cwd）', () => {
  it('默认 import 项目插件；VESSEL_NO_EXTERNAL_PLUGINS=1 时不 import', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-select-e2e-'));
    try {
      const marker = path.join(root, 'evil-loaded.txt');
      writePlugin(
        path.join(root, '.vessel', 'plugins', 'evil'),
        'evil',
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\n`,
      );
      fs.mkdirSync(path.join(root, 'home'), { recursive: true });
      const probe = path.join(root, 'probe.ts');
      fs.writeFileSync(probe, probeSource(), 'utf8');

      const run = async (noExternal: boolean) => {
        if (fs.existsSync(marker)) fs.unlinkSync(marker);
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          HOME: path.join(root, 'home'),
          USERPROFILE: path.join(root, 'home'),
        };
        if (noExternal) env.VESSEL_NO_EXTERNAL_PLUGINS = '1';
        const proc = Bun.spawn([process.execPath, probe], {
          cwd: root,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout: stdout.trim(), stderr, exitCode, marker: fs.existsSync(marker) };
      };

      const loaded = await run(false);
      expect(loaded.exitCode).toBe(0);
      expect(loaded.stdout).toContain('evil');
      expect(loaded.marker).toBe(true);

      const optedOut = await run(true);
      expect(optedOut.exitCode).toBe(0);
      expect(optedOut.stdout).toBe('[]');
      expect(optedOut.marker).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function descriptor(name: string, source: PluginSource): PluginDescriptor {
  return { name, category: source, version: '0.0.0', entry: `/fake/${name}.ts`, source };
}

function writePlugin(dir: string, name: string, extraEntry = ''): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.2.3', main: 'src/index.ts' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'index.ts'),
    `${extraEntry}export default { name: ${JSON.stringify(name)}, install() {} };\n`,
    'utf8',
  );
}

/** 子进程探针：按默认选择只 import 外部插件，用于验证 opt-out 不触发 import。 */
function probeSource(): string {
  const loaderUrl = pathToFileURL(path.join(import.meta.dir, '..', 'plugin-loader.ts')).href;
  const selectionUrl = pathToFileURL(path.join(import.meta.dir, '..', 'plugin-selection.ts')).href;
  return [
    `import { PluginLoader } from ${JSON.stringify(loaderUrl)};`,
    `import { resolvePluginSelection } from ${JSON.stringify(selectionUrl)};`,
    'const loader = new PluginLoader();',
    'const selection = resolvePluginSelection(loader, undefined, false, [], process.env);',
    'for (const descriptor of selection.external) { await import(descriptor.entry); }',
    'process.stdout.write(JSON.stringify(selection.external.map((d) => d.name)));',
    '',
  ].join('\n');
}
