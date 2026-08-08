/**
 * 自动生成——由 scripts/discover-plugins.ts 扫描 plugins 目录（分类/插件）生成。
 * 请勿手改；重新生成请运行 `bun run scripts/discover-plugins.ts`。
 */
import type { Plugin } from '../packages/core/src/index';

import pluginmcpClient from '../plugins/integration/mcp-client/src/index';
import pluginmemoryAuto from '../plugins/memory/auto/src/index';
import pluginmemoryProject from '../plugins/memory/project/src/index';
import pluginhookLogging from '../plugins/observability/hook-logging/src/index';
import pluginproviderAnthropic from '../plugins/provider/anthropic/src/index';
import pluginproviderOpenai from '../plugins/provider/openai/src/index';
import pluginguardrailPii from '../plugins/security/guardrail-pii/src/index';
import pluginredactSecrets from '../plugins/security/redact-secrets/src/index';
import plugintoolPolicy from '../plugins/security/tool-policy/src/index';
import pluginfileOps from '../plugins/tools/file-ops/src/index';
import pluginmetaTools from '../plugins/tools/meta-tools/src/index';
import pluginskillsLoader from '../plugins/tools/skills-loader/src/index';

/** 插件描述（来自 package.json 元数据 + 目录分类） */
export interface PluginDescriptor {
  name: string;
  category: string;
  version: string;
  description?: string;
}

/** 扫描出的插件元数据 */
export const PLUGIN_DESCRIPTORS: PluginDescriptor[] = [
  { name: 'file-ops', category: 'tools', version: '0.1.0' },
  { name: 'guardrail-pii', category: 'security', version: '0.1.0' },
  { name: 'hook-logging', category: 'observability', version: '0.1.0' },
  { name: 'mcp-client', category: 'integration', version: '0.1.0' },
  { name: 'memory-auto', category: 'memory', version: '0.1.0' },
  { name: 'memory-project', category: 'memory', version: '0.1.0' },
  { name: 'meta-tools', category: 'tools', version: '0.1.0' },
  { name: 'provider-anthropic', category: 'provider', version: '0.1.0' },
  { name: 'provider-openai', category: 'provider', version: '0.1.0' },
  { name: 'redact-secrets', category: 'security', version: '0.1.0' },
  { name: 'skills-loader', category: 'tools', version: '0.1.0' },
  { name: 'tool-policy', category: 'security', version: '0.1.0' },
];

/** 插件名 → 插件默认导出（静态 import，可被 Bun 打包） */
export const PLUGIN_MODULES: Record<string, Plugin> = {
  'file-ops': pluginfileOps,
  'guardrail-pii': pluginguardrailPii,
  'hook-logging': pluginhookLogging,
  'mcp-client': pluginmcpClient,
  'memory-auto': pluginmemoryAuto,
  'memory-project': pluginmemoryProject,
  'meta-tools': pluginmetaTools,
  'provider-anthropic': pluginproviderAnthropic,
  'provider-openai': pluginproviderOpenai,
  'redact-secrets': pluginredactSecrets,
  'skills-loader': pluginskillsLoader,
  'tool-policy': plugintoolPolicy,
};
