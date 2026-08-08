/**
 * @vessel/web-fetch - Web fetch tool plugin
 * @module @vessel/web-fetch
 *
 * Fetches URL content and extracts readable text
 */

import type { Plugin, PluginHost, ToolDefinition } from '@vessel/core';

/** Web fetch configuration */
export interface WebFetchConfig {
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Maximum content length in characters (default: 50000) */
  maxLength?: number;
  /** Custom user agent string */
  userAgent?: string;
}

/** Default configuration */
const DEFAULT_CONFIG: WebFetchConfig = {
  timeout: 10000,
  maxLength: 50000,
  userAgent: 'Vessel/0.1.0 (web-fetch tool)',
};

/**
 * Extract readable content from HTML
 */
function extractReadableContent(html: string): string {
  // Remove script and style tags
  let content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove HTML comments
  content = content.replace(/<!--[\s\S]*?-->/g, '');

  // Remove navigation, header, footer, aside elements
  content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  content = content.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  content = content.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  content = content.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  // Remove all HTML tags
  content = content.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  content = content
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Clean up whitespace
  content = content.replace(/\s+/g, ' ');
  content = content.replace(/\n\s*\n/g, '\n');

  return content.trim();
}

/**
 * Truncate content to max length
 */
function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength)}\n\n[Content truncated...]`;
}

/**
 * Fetch URL content
 */
async function fetchUrl(url: string, config: WebFetchConfig): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': config.userAgent ?? 'Vessel/0.1.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }

    // Check content type
    const contentType = response.headers.get('content-type') ?? '';
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain') &&
      !contentType.includes('application/xhtml+xml')
    ) {
      return `Error: Unsupported content type: ${contentType}`;
    }

    const html = await response.text();
    const content = extractReadableContent(html);

    return truncateContent(content, config.maxLength ?? DEFAULT_CONFIG.maxLength ?? 50000);
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return `Error: Request timeout after ${config.timeout}ms`;
      }
      return `Error fetching URL: ${error.message}`;
    }
    return 'Error: Unknown error occurred';
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Create web fetch tool
 */
function createWebFetchTool(config: WebFetchConfig = {}): ToolDefinition {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    name: 'web-fetch',
    description:
      'Fetch URL content and extract readable text. Use this to get the main content of a web page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
          format: 'uri',
        },
        max_length: {
          type: 'number',
          description: `Maximum content length in characters (default: ${mergedConfig.maxLength})`,
        },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const { url, max_length } = args as { url: string; max_length?: number };

      // Validate URL
      try {
        new URL(url);
      } catch {
        return 'Error: Invalid URL format';
      }

      const fetchConfig = {
        ...mergedConfig,
        maxLength: max_length ?? mergedConfig.maxLength,
      };

      return fetchUrl(url, fetchConfig);
    },
    default: true,
  };
}

/**
 * Create Web Fetch Plugin
 */
export function createWebFetchPlugin(config?: WebFetchConfig): Plugin {
  return {
    name: 'web-fetch',
    version: '0.1.0',
    description: 'Web fetch tool - fetches URL content and extracts readable text',
    install(host: PluginHost) {
      const tool = createWebFetchTool(config);
      host.registerTool(tool);
    },
  };
}

/** Default instance */
export const webFetchPlugin = createWebFetchPlugin();

export default webFetchPlugin;
