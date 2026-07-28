/**
 * 首启配置向导
 * @module @vessel/tui
 *
 * 架构：TUI 层交互逻辑。
 * - 不在 core（core 不知道"向导"）
 * - 不在 config（config 只管文件读写）
 * - start.ts 在 api_key 为空时自动调用
 * - /setup 斜杠命令可重新配置
 */

import { mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { UserConfig } from '@vessel/config';
import { getUserConfigPath } from '@vessel/config';
import { parse as fromYaml, stringify as toYaml } from 'yaml';

// ── 类型 ──────────────────────────────────────────

export interface SetupWizardConfig {
  skipConnectivityTest?: boolean;
}

interface ModelEntry {
  id: string;
  owned_by?: string;
}

// ── 工具函数 ──────────────────────────────────────

/** 获取用户配置目录 */
function userConfigDir(): string {
  return path.join(os.homedir(), '.vessel');
}

/** 读取用户配置文件 */
async function readUserConfig(): Promise<UserConfig> {
  try {
    const p = getUserConfigPath();
    if (!(await Bun.file(p).exists())) return {};
    const text = await Bun.file(p).text();
    return (fromYaml(text) ?? {}) as UserConfig;
  } catch {
    /* ignore */
  }
  return {};
}

/** 写入用户配置文件 */
async function writeUserConfig(cfg: UserConfig): Promise<void> {
  const dir = userConfigDir();
  await mkdir(dir, { recursive: true });
  await Bun.write(getUserConfigPath(), toYaml(cfg));
}

/** 测试连接：调用 /models 获取模型列表 */
async function fetchModels(baseUrl: string, apiKey: string): Promise<ModelEntry[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const data = (await res.json()) as { data?: ModelEntry[] };
  return data.data ?? [];
}

// ── 向导类 ───────────────────────────────────────

export class SetupWizard {
  private cfg: SetupWizardConfig;
  private rl: readline.Interface;

  constructor(config: SetupWizardConfig = {}) {
    this.cfg = config;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /** 运行向导，返回 UserConfig（供 start.ts 使用） */
  async run(): Promise<UserConfig> {
    console.log(`\n${'═'.repeat(54)}`);
    console.log('  🔑  Vessel — 首次配置');
    console.log('═'.repeat(54));

    // 检查已有配置
    const existing = await readUserConfig();
    if (existing.apiKey) {
      console.log('\n  已有配置:');
      console.log(`    Provider: ${existing.defaultProvider ?? '(default)'}`);
      console.log(`    API Key:  ****${existing.apiKey.slice(-4)}`);
      const reuse = await this.ask('\n  使用已有配置？(Y/n): ');
      if (reuse.toLowerCase() !== 'n') {
        this.rl.close();
        return existing;
      }
    }

    // 输入循环
    let baseUrl = '';
    let apiKey = '';
    let models: ModelEntry[] = [];
    let connected = false;

    while (!connected) {
      console.log('\n  ── 连接配置 ──\n');

      baseUrl = await this.ask('  BaseURL (例: https://api.openai.com/v1): ');
      if (!baseUrl) baseUrl = 'https://api.openai.com/v1';

      apiKey = await this.ask('  APIKey  (例: sk-proj-xxxxxxxxxxxxxxxxxxxxxxxx): ');

      if (!apiKey) {
        console.log('\n  ❌ API Key 不能为空');
        continue;
      }

      // 测试连接
      if (this.cfg.skipConnectivityTest) {
        connected = true;
        continue;
      }
      console.log('\n  ⏳ 正在测试连接...');
      try {
        models = await fetchModels(baseUrl, apiKey);
        const chatModels = models.filter(
          (m) =>
            m.id.includes('gpt') ||
            m.id.includes('claude') ||
            m.id.includes('gemini') ||
            m.id.includes('command') ||
            m.id.includes('llama') ||
            m.id.includes('mistral') ||
            (!m.id.includes('embed') && !m.id.includes('moderation') && !m.id.includes('dall')),
        );
        // 如果过滤后没有 chat 模型，回退到全部
        const displayModels = chatModels.length > 0 ? chatModels : models;

        console.log(`\n  ✅ 连接成功！获取到 ${displayModels.length} 个模型:`);
        for (let i = 0; i < Math.min(displayModels.length, 20); i++) {
          console.log(`      ${i + 1}. ${displayModels[i]?.id}`);
        }
        if (displayModels.length > 20) {
          console.log(`      ... 还有 ${displayModels.length - 20} 个`);
        }

        models = displayModels;
        connected = true;
      } catch (err) {
        console.log(`\n  ❌ 连接失败: ${err instanceof Error ? err.message : err}`);
        console.log('  请检查 BaseURL 和 APIKey 后重试。');
      }
    }

    // 选择模型
    const defaultModel = models.length > 0 ? (models[0]?.id ?? 'gpt-4') : 'gpt-4';

    let selectedModel = defaultModel;
    if (models.length > 0) {
      const choice = await this.ask(
        `\n  选择默认模型 (1-${Math.min(models.length, 20)}, 默认 1): `,
      );
      const idx = Number.parseInt(choice) - 1;
      if (!Number.isNaN(idx) && idx >= 0 && idx < models.length) {
        selectedModel = models[idx]?.id ?? defaultModel;
      }
    } else {
      selectedModel = await this.ask('\n  输入模型名称 (默认 gpt-4): ');
      if (!selectedModel) selectedModel = 'gpt-4';
    }

    // 推断 provider 名称
    const providerName = inferProvider(baseUrl);

    // 构建配置
    const config: UserConfig = {
      apiKey,
      defaultProvider: providerName,
      defaultModel: selectedModel,
      providers: {
        [providerName]: {
          apiKey,
          baseUrl,
          model: selectedModel,
        },
      },
    };

    // 显示摘要
    console.log('\n  ── 配置摘要 ──');
    console.log(`  Provider:  ${providerName}`);
    console.log(`  BaseURL:   ${baseUrl}`);
    console.log(`  Model:     ${selectedModel}`);
    console.log(`  API Key:   ****${apiKey.slice(-4)}`);

    const save = await this.ask('\n  保存配置？(Y/n): ');
    if (save.toLowerCase() === 'n') {
      console.log('\n  未保存。');
      this.rl.close();
      return config;
    }

    await writeUserConfig(config);
    console.log(`\n  ✅ 已保存到 ${getUserConfigPath()}`);
    console.log('  修改配置: /setup');
    console.log(`${'═'.repeat(54)}\n`);

    this.rl.close();
    return config;
  }

  private ask(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, (answer) => {
        resolve(answer.trim());
      });
    });
  }
}

/** 从 BaseURL 推断 provider 名称 */
function inferProvider(baseUrl: string): string {
  const u = baseUrl.toLowerCase();
  if (u.includes('openai') || u.includes('api.openai')) return 'openai';
  if (u.includes('anthropic') || u.includes('api.anthropic')) return 'anthropic';
  if (u.includes('google') || u.includes('generativelanguage')) return 'google';
  if (u.includes('mistral')) return 'mistral';
  if (u.includes('cohere')) return 'cohere';
  if (u.includes('localhost') || u.includes('127.0.0.1') || u.includes('ollama')) return 'ollama';
  return 'custom';
}

/** 便捷函数：运行向导 */
export async function runSetupWizard(cfg?: SetupWizardConfig): Promise<UserConfig> {
  const wizard = new SetupWizard(cfg);
  return wizard.run();
}
