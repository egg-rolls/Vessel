/**
 * Web Search Tool Plugin
 * @module @vessel/plugin-web-search
 */

import type { Plugin, PluginHost, ToolContext, ToolDefinition } from '@vessel/core';

/** Tavily API 响应类型 */
interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilySearchResult[];
  answer?: string;
  query: string;
}

/** Web Search 工具输入类型 */
interface WebSearchInput {
  query: string;
  max_results?: number;
}

/** Web Search 工具配置 */
interface WebSearchConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultMaxResults?: number;
}

/**
 * 获取 Tavily API Key
 * 优先级：环境变量 > 配置
 */
function getApiKey(config?: WebSearchConfig): string | undefined {
  return config?.apiKey || process.env.VESSEL_WEB_SEARCH_API_KEY || process.env.TAVILY_API_KEY;
}

/**
 * 调用 Tavily 搜索 API
 */
async function tavilySearch(
  query: string,
  apiKey: string,
  maxResults: number = 5,
  baseUrl?: string,
): Promise<TavilyResponse> {
  const url = baseUrl || 'https://api.tavily.com/search';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tavily API error: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<TavilyResponse>;
}

/**
 * 格式化搜索结果
 */
function formatResults(response: TavilyResponse): string {
  const parts: string[] = [];

  if (response.answer) {
    parts.push(`## Answer\n${response.answer}\n`);
  }

  if (response.results && response.results.length > 0) {
    parts.push('## Search Results\n');
    response.results.forEach((result, index) => {
      parts.push(`### ${index + 1}. ${result.title}`);
      parts.push(`URL: ${result.url}`);
      parts.push(`${result.content}\n`);
    });
  } else {
    parts.push('No results found.');
  }

  return parts.join('\n');
}

/**
 * 创建 Web Search 工具定义
 */
function createWebSearchTool(config?: WebSearchConfig): ToolDefinition {
  const apiKey = getApiKey(config);

  return {
    name: 'web-search',
    description:
      'Search the web for information using Tavily search API. Returns relevant search results with URLs.',
    default: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find information about',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
          minimum: 1,
          maximum: 20,
        },
      },
      required: ['query'],
    },
    timeout: 30000,
    handler: async (args: unknown, _ctx: ToolContext): Promise<string> => {
      const input = args as WebSearchInput;

      if (!apiKey) {
        return 'Error: No API key configured. Set VESSEL_WEB_SEARCH_API_KEY or TAVILY_API_KEY environment variable, or configure api_key in vessel.yaml.';
      }

      if (!input.query || input.query.trim().length === 0) {
        return 'Error: Query cannot be empty.';
      }

      const maxResults = input.max_results || config?.defaultMaxResults || 5;

      try {
        const response = await tavilySearch(input.query, apiKey, maxResults, config?.baseUrl);
        return formatResults(response);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return `Error performing web search: ${errorMessage}`;
      }
    },
  };
}

/**
 * Web Search 插件
 */
export function createWebSearchPlugin(config?: WebSearchConfig): Plugin {
  return {
    name: '@vessel/plugin-web-search',
    version: '0.1.0',
    description: 'Web search tool using Tavily API',
    install(host: PluginHost): void {
      const tool = createWebSearchTool(config);
      host.registerTool(tool);
    },
  };
}

export type { WebSearchConfig, WebSearchInput };
