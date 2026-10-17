/**
 * 工具入参摘要（权限弹窗 / 工具卡片共用）
 *
 * 纯函数：把任意 tool input 收窄成 1-4 行人类可读文本。
 * 目的不是完整展示 JSON，而是让用户在批准前**看见将要执行什么**。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\r?\n/g, ' ⏎ ');
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

/** 返回展示行；空数组表示没有可展示的入参 */
export function summarizeToolInput(toolName: string, input: unknown): string[] {
  const record = isRecord(input) ? input : {};

  switch (toolName) {
    case 'bash': {
      const command = readString(record, 'command');
      if (!command) return [];
      const cwd = readString(record, 'cwd');
      return [`$ ${truncate(command, 200)}`, ...(cwd ? [`cwd: ${cwd}`] : [])];
    }
    case 'read': {
      const path = readString(record, 'path');
      if (!path) return [];
      const offset = record.offset;
      const limit = record.limit;
      const range =
        offset !== undefined || limit !== undefined
          ? ` (offset ${String(offset ?? 0)}, limit ${String(limit ?? 'default')})`
          : '';
      return [`path: ${path}${range}`];
    }
    case 'edit': {
      const path = readString(record, 'path');
      const oldString = readString(record, 'old_string');
      if (!path) return [];
      const lines = [`path: ${path}`];
      if (oldString) lines.push(`- ${truncate(oldString, 120)}`);
      if (record.replace_all === true) lines.push('replace_all: true');
      return lines;
    }
    case 'delegate_task': {
      const task = readString(record, 'task');
      return task ? [`task: ${truncate(task, 200)}`] : [];
    }
    case 'ask_user': {
      const questions = record.questions;
      if (Array.isArray(questions)) return [`questions: ${questions.length}`];
      return [];
    }
    default: {
      if (input === undefined || input === null) return [];
      try {
        return [truncate(JSON.stringify(input), 200)];
      } catch {
        return [];
      }
    }
  }
}
