/**
 * @vessel/file-ops - 文件操作工具插件
 * @module @vessel/file-ops
 *
 * 提供文件读写、搜索、列目录等基本文件操作工具
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Plugin, PluginHost, ToolDefinition } from '@vessel/core';

/** 文件操作配置 */
export interface FileOpsConfig {
  /** 允许操作的根目录（默认当前目录） */
  allowedPaths?: string[];
  /** 禁止操作的路径 */
  deniedPaths?: string[];
  /** 最大文件大小（字节） */
  maxFileSize?: number;
}

/** 默认配置 */
const DEFAULT_CONFIG: FileOpsConfig = {
  allowedPaths: ['.'],
  deniedPaths: ['node_modules', '.git', 'dist'],
  maxFileSize: 10 * 1024 * 1024, // 10MB
};

/**
 * 检查路径是否允许访问
 */
function isPathAllowed(filePath: string, config: FileOpsConfig): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');

  // 检查禁止路径
  for (const denied of config.deniedPaths ?? []) {
    if (normalizedPath.includes(denied)) {
      return false;
    }
  }

  return true;
}

/**
 * 创建文件操作工具
 */
function createFileTools(config: FileOpsConfig = {}): ToolDefinition[] {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: 'Read the contents of a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        encoding: { type: 'string', description: 'File encoding (default: utf-8)' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const { path, encoding = 'utf-8' } = args as { path: string; encoding?: string };

      if (!isPathAllowed(path, mergedConfig)) {
        return `Error: Access denied to path: ${path}`;
      }

      try {
        const content = await readFile(path, { encoding: encoding as BufferEncoding });
        return content;
      } catch (error) {
        return `Error reading file: ${error}`;
      }
    },
  };

  const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: 'Write content to a file (creates parent directories if needed)',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write' },
        encoding: { type: 'string', description: 'File encoding (default: utf-8)' },
      },
      required: ['path', 'content'],
    },
    handler: async (args) => {
      const {
        path,
        content,
        encoding = 'utf-8',
      } = args as {
        path: string;
        content: string;
        encoding?: string;
      };

      if (!isPathAllowed(path, mergedConfig)) {
        return `Error: Access denied to path: ${path}`;
      }

      try {
        // 创建父目录
        const dir = dirname(path);
        await mkdir(dir, { recursive: true });

        await writeFile(path, content, { encoding: encoding as BufferEncoding });
        return `File written successfully: ${path}`;
      } catch (error) {
        return `Error writing file: ${error}`;
      }
    },
  };

  const listDirTool: ToolDefinition = {
    name: 'list_directory',
    description: 'List files and directories in a path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to list (default: current directory)' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
        pattern: { type: 'string', description: 'File pattern to match (e.g., "*.ts")' },
      },
    },
    handler: async (args) => {
      const {
        path = '.',
        recursive = false,
        pattern,
      } = args as {
        path?: string;
        recursive?: boolean;
        pattern?: string;
      };

      if (!isPathAllowed(path, mergedConfig)) {
        return `Error: Access denied to path: ${path}`;
      }

      try {
        const entries = await readdir(path, { withFileTypes: true });
        const results: string[] = [];

        for (const entry of entries) {
          const fullPath = join(path, entry.name);

          if (!isPathAllowed(fullPath, mergedConfig)) {
            continue;
          }

          if (entry.isDirectory()) {
            results.push(`📁 ${entry.name}/`);

            if (recursive) {
              const subEntries = await listDirTool.handler(
                {
                  path: fullPath,
                  recursive: true,
                  pattern,
                },
                { run_id: '', messages: [] },
              );
              if (typeof subEntries === 'string') {
                const lines = subEntries.split('\n').filter((l) => l.trim());
                for (const line of lines) {
                  results.push(`  ${line}`);
                }
              }
            }
          } else {
            if (pattern) {
              const regex = new RegExp(pattern.replace(/\*/g, '.*'));
              if (!regex.test(entry.name)) {
                continue;
              }
            }

            const stats = await stat(fullPath);
            const size = formatSize(stats.size);
            results.push(`📄 ${entry.name} (${size})`);
          }
        }

        return results.join('\n') || 'Empty directory';
      } catch (error) {
        return `Error listing directory: ${error}`;
      }
    },
  };

  const fileExistsTool: ToolDefinition = {
    name: 'file_exists',
    description: 'Check if a file or directory exists',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to check' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const { path } = args as { path: string };

      try {
        const stats = await stat(path);
        return `Path exists: ${path} (${stats.isDirectory() ? 'directory' : 'file'})`;
      } catch {
        return `Path does not exist: ${path}`;
      }
    },
  };

  const createDirTool: ToolDefinition = {
    name: 'create_directory',
    description: 'Create a directory (and parent directories if needed)',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to create' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const { path } = args as { path: string };

      if (!isPathAllowed(path, mergedConfig)) {
        return `Error: Access denied to path: ${path}`;
      }

      try {
        await mkdir(path, { recursive: true });
        return `Directory created: ${path}`;
      } catch (error) {
        return `Error creating directory: ${error}`;
      }
    },
  };

  return [readFileTool, writeFileTool, listDirTool, fileExistsTool, createDirTool];
}

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * File Ops 插件
 */
export const fileOpsPlugin: Plugin = {
  name: 'file-ops',
  version: '0.1.0',
  description: 'File operations tools (read, write, list, etc.)',
  install(host: PluginHost, config?: unknown) {
    const fileConfig = config as FileOpsConfig;
    const tools = createFileTools(fileConfig);

    for (const tool of tools) {
      host.registerTool(tool);
    }
  },
};

export default fileOpsPlugin;
