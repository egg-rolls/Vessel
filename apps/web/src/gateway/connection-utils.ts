/** 统一的错误消息提取：非 Error 按 String 处理。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
