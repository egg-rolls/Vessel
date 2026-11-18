/**
 * model-registry 插件：连通性测试（契约 §3.4）。
 *
 * **产品功能，用户触发**（UI「测试」按钮 / 显式 RPC test）；绝不在启动 / 保存 / 定时路径
 * 自动触发，实施切片的 AI 也不调用它。第 2 级发真实请求（1 token 级成本）。
 *
 * 两级：
 * 1. openai 系协议且未指定 model：GET {baseUrl}/models（Bearer，setup-wizard fetchModels 先例）
 *    → ok + 模型列表（UI 可辅助导入 models）。
 * 2. anthropic 协议（无 /models 端点）或指定 model：最小 chat（max_tokens=1，单条 ping；
 *    anthropic 用 x-api-key + anthropic-version）。
 *
 * 单次尝试、**不走 withRetry**、15s 超时；error 经 redactor（不含 key / 完整请求头）。
 * 只接受已保存 vendor（凭证解析在 index.ts；明文 key 不出现在 test 参数）。
 */

import { createDefaultTraceRedactor } from '@vessel-agent/core';

export interface ConnectivityResult {
  ok: boolean;
  latencyMs: number;
  models?: string[];
  error?: { code: string; message: string };
}

/**
 * 协议工厂默认 baseUrl：openai 系五名与 plugins/provider/openai 的 PROVIDERS 表同值，
 * anthropic 与 core AnthropicProvider 默认同值。vendor.baseUrl 缺省时兜底；
 * 自定义 provider 插件协议不在此表（wire 未知）→ unsupported_protocol。
 */
const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1',
  ollama: 'http://localhost:11434/v1',
  // Cohere 的 OpenAI 兼容端点在 /compatibility/v1（同 openai 插件注释）
  cohere: 'https://api.cohere.ai/compatibility/v1',
  anthropic: 'https://api.anthropic.com',
};

export function defaultBaseUrlFor(protocol: string): string | undefined {
  return Object.hasOwn(DEFAULT_BASE_URLS, protocol) ? DEFAULT_BASE_URLS[protocol] : undefined;
}

const TIMEOUT_MS = 15_000;
const redactor = createDefaultTraceRedactor();

/** error message 经默认 redactor（sk- / Bearer / JWT / AWS 模式 → ***）。 */
function redactMessage(message: string): string {
  // 合成事件只作 redactor 包装，绝不发布（同 cleared-tool-result 先例）。
  const event = redactor.redact({
    type: 'redactor.wrap',
    run_id: '',
    ts: 0,
    data: { message },
  });
  const value = (event.data as Record<string, unknown>).message;
  return typeof value === 'string' ? value : '***';
}

/** 去掉尾斜杠，避免拼出 `//models` / `//chat/completions`。 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function testConnectivity(options: {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
}): Promise<ConnectivityResult> {
  const { protocol, apiKey, model } = options;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);
  const fail = (code: string, message: string): ConnectivityResult => ({
    ok: false,
    latencyMs: elapsed(),
    error: { code, message: redactMessage(message) },
  });

  try {
    const useChat = protocol === 'anthropic' || model !== undefined;
    if (!useChat) {
      // 第 1 级：GET /models（openai 系；Bearer）。
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return fail('http_error', `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
      const models = Array.isArray(payload.data)
        ? payload.data
            .map((entry) => entry?.id)
            .filter((id): id is string => typeof id === 'string')
        : [];
      return { ok: true, latencyMs: elapsed(), models };
    }

    // 第 2 级：最小 chat（max_tokens=1，单条 ping）。
    if (model === undefined || model === '') {
      return fail('no_model', 'chat connectivity test requires a model');
    }
    const anthropic = protocol === 'anthropic';
    const url = anthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (anthropic) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return fail('http_error', `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    // 成功即连通；丢弃响应体释放连接，不解析内容。
    await res.body?.cancel().catch(() => {});
    return { ok: true, latencyMs: elapsed() };
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return fail('timeout', `request timed out after ${TIMEOUT_MS}ms`);
    }
    return fail('network_error', error instanceof Error ? error.message : String(error));
  }
}
