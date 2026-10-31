/** 聊天域错误展示：统一取 `Error.message`，非 Error 原样字符串化。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
