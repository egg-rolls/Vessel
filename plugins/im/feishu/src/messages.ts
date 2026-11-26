/**
 * 飞书渠道三态反馈文案（P1-A4，D4=a+ii）：busy / 超时 / 错误。
 *
 * 语言随节点 i18n 口径（zh-CN / en），由装配层注入 locale（FeishuPluginOptions.locale），
 * 插件不读 src/i18n、不新增用户语言配置。缺省 zh-CN（与节点 fallback 一致）。
 * busy 文案说明排队上限（{limit} 由渠道以 FEISHU_QUEUE_LIMIT 插值）。
 */

export type FeishuLocale = 'zh-CN' | 'en';

export interface FeishuReplyTexts {
  busy: string;
  timeout: string;
  error: string;
}

const TEXTS: Record<FeishuLocale, FeishuReplyTexts> = {
  'zh-CN': {
    busy: '上一条还在处理，排队已满（上限 {limit}），请稍后再发。',
    timeout: '处理超时了，请稍后重试。',
    error: '处理出错了，请稍后重试。',
  },
  en: {
    busy: 'Still handling the previous message; the queue is full (limit {limit}). Please try again later.',
    timeout: 'The request timed out. Please try again later.',
    error: 'The request failed. Please try again later.',
  },
};

/** 取指定 locale 的三态文案；非法/缺省回退 zh-CN；busy 插值排队上限。 */
export function feishuReplyTexts(
  locale: FeishuLocale | undefined,
  queueLimit: number,
): FeishuReplyTexts {
  const texts = TEXTS[locale ?? 'zh-CN'] ?? TEXTS['zh-CN'];
  return {
    busy: texts.busy.replace('{limit}', String(queueLimit)),
    timeout: texts.timeout,
    error: texts.error,
  };
}
