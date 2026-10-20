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
import { resolveLocale, setLocale, t } from '../i18n/index.js';

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
async function fetchModels(
  baseUrl: string,
  apiKey: string,
  providerName: string,
): Promise<ModelEntry[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (providerName === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const data = (await res.json()) as { data?: ModelEntry[] };
  return data.data ?? [];
}

/** 从模型列表过滤出 chat 模型（无匹配则回退到全部） */
function filterChatModels(models: ModelEntry[]): ModelEntry[] {
  const chat = models.filter(
    (m) =>
      m.id.includes('gpt') ||
      m.id.includes('claude') ||
      m.id.includes('gemini') ||
      m.id.includes('command') ||
      m.id.includes('llama') ||
      m.id.includes('mistral') ||
      (!m.id.includes('embed') && !m.id.includes('moderation') && !m.id.includes('dall')),
  );
  return chat.length > 0 ? chat : models;
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
    setLocale(resolveLocale({ env: process.env }));
    this.printHeader();

    const existing = await readUserConfig();
    const reused = await this.reuseExisting(existing);
    if (reused) return reused;

    const { baseUrl, apiKey, models } = await this.collectConnection();
    const selectedModel = await this.selectModel(models);

    const providerName = inferProvider(baseUrl);
    const config: UserConfig = {
      apiKey,
      defaultProvider: providerName,
      defaultModel: selectedModel,
      providers: {
        [providerName]: { apiKey, baseUrl, model: selectedModel },
      },
    };

    return this.confirmAndSave(config, providerName, baseUrl, selectedModel, apiKey);
  }

  /** 打印向导头 */
  private printHeader(): void {
    console.log(`\n${'═'.repeat(56)}`);
    console.log(t('wizard.headerTitle'));
    console.log(t('wizard.headerSubtitle'));
    console.log(`${'═'.repeat(56)}`);
  }

  /** 打印步骤标题（emoji 分组 + 步骤号） */
  private step(emoji: string, n: number, title: string): void {
    console.log(`\n${t('wizard.step', { emoji, number: n, title })}`);
    console.log(`  ${'─'.repeat(44)}`);
  }

  /** 检查并复用已有配置；返回 null 表示继续新配置 */
  private async reuseExisting(existing: UserConfig): Promise<UserConfig | null> {
    if (!existing.apiKey) return null;

    console.log(`\n${t('wizard.existing')}`);
    console.log(`    Provider: ${existing.defaultProvider ?? '(default)'}`);
    console.log(`    API Key:  ****${existing.apiKey.slice(-4)}`);
    const reuse = await this.ask(`\n${t('wizard.reusePrompt')}`);
    if (reuse.toLowerCase() !== 'n') {
      this.rl.close();
      return existing;
    }
    return null;
  }

  /** 步骤 1-2：连接配置（BaseURL + API Key）并测试连接 */
  private async collectConnection(): Promise<{
    baseUrl: string;
    apiKey: string;
    models: ModelEntry[];
  }> {
    let baseUrl = '';
    let apiKey = '';
    let models: ModelEntry[] = [];
    let connected = false;

    while (!connected) {
      this.step('⚙️', 1, t('wizard.step.connection'));
      baseUrl = await this.ask(t('wizard.baseUrlPrompt'));
      if (!baseUrl) baseUrl = 'https://api.openai.com/v1';

      apiKey = await this.ask('  API Key  (sk-...): ');
      if (!apiKey) {
        console.log(`\n${t('wizard.apiKeyEmpty')}`);
        continue;
      }

      this.step('🔌', 2, t('wizard.step.test'));
      if (this.cfg.skipConnectivityTest) {
        connected = true;
        continue;
      }
      const probe = inferProvider(baseUrl);
      console.log(`\n${t('wizard.testing', { provider: probe })}`);

      // Anthropic 等非 OpenAI-compat provider 无 /models 端点，跳过模型列表
      if (probe !== 'openai' && probe !== 'custom') {
        console.log(t('wizard.noModelList', { provider: probe }));
        models = [];
        connected = true;
      } else {
        try {
          models = await fetchModels(baseUrl, apiKey, probe);
          models = filterChatModels(models);
          console.log(`\n${t('wizard.connected', { count: models.length })}`);
          for (let i = 0; i < Math.min(models.length, 20); i++) {
            console.log(`      ${i + 1}. ${models[i]?.id}`);
          }
          if (models.length > 20) {
            console.log(t('wizard.moreModels', { count: models.length - 20 }));
          }
          connected = true;
        } catch (err) {
          console.log(
            `\n${t('wizard.connectFailed', {
              error: err instanceof Error ? err.message : String(err),
            })}`,
          );
          console.log(t('wizard.connectRetry'));
        }
      }
    }
    return { baseUrl, apiKey, models };
  }

  /** 步骤 3：选择默认模型 */
  private async selectModel(models: ModelEntry[]): Promise<string> {
    this.step('🤖', 3, t('wizard.step.model'));
    const defaultModel = models.length > 0 ? (models[0]?.id ?? 'gpt-4') : 'gpt-4';

    if (models.length > 0) {
      const choice = await this.ask(
        `\n${t('wizard.selectModelPrompt', { max: Math.min(models.length, 20) })}`,
      );
      const idx = Number.parseInt(choice, 10) - 1;
      if (!Number.isNaN(idx) && idx >= 0 && idx < models.length) {
        return models[idx]?.id ?? defaultModel;
      }
      return defaultModel;
    }

    const input = await this.ask(`\n${t('wizard.modelNamePrompt')}`);
    return input || 'gpt-4';
  }

  /** 步骤 4：显示摘要并确认保存 */
  private async confirmAndSave(
    config: UserConfig,
    providerName: string,
    baseUrl: string,
    selectedModel: string,
    apiKey: string,
  ): Promise<UserConfig> {
    this.step('📋', 4, t('wizard.step.save'));
    console.log(`\n  Provider:  ${providerName}`);
    console.log(`  BaseURL:   ${baseUrl}`);
    console.log(`  Model:     ${selectedModel}`);
    console.log(`  API Key:   ****${apiKey.slice(-4)}`);

    const save = await this.ask(`\n${t('wizard.savePrompt')}`);
    if (save.toLowerCase() === 'n') {
      console.log(`\n${t('wizard.notSaved')}`);
      this.rl.close();
      return config;
    }

    await writeUserConfig(config);
    console.log(`\n${t('wizard.saved', { path: getUserConfigPath() })}`);
    console.log(t('wizard.editHint'));
    console.log(`${'═'.repeat(56)}\n`);

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
