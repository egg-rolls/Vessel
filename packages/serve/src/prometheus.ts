/**
 * 轻量 Prometheus 指标注册表 + exposition 渲染（日志/指标分离）。
 *
 * 为什么要有：资源统计（rss/heap/uptime/代理并发…）是**统计指标**，不是**时间事件**。
 * 把它们每 60s 塞进事件日志只会刷噪音、淹没有用的时点事件与错误。业界通用做法是
 * metrics/logs 分离：指标进 registry，由外部 Prometheus/Grafana 经标准 `/metrics`
 * 端点 **pull**（scrape 时求值），事件日志只留有意义的时点事件 + 错误直报。
 *
 * 本模块只实现 Prometheus text exposition format 所需的 gauge/counter 子集：
 * `# HELP` / `# TYPE` 头 + `name{labels} value` 样本行。不引入第三方依赖，不做
 * 监控可视化（那留给外部 Prometheus/Grafana）。pull 模型 ⇒ 无周期定时器、无日志噪音。
 *
 * 与 usage 插件的模型用量指标**共存不冲突**：各自暴露各自的端点/指标族，名字不撞。
 *
 * @module @vessel-agent/serve/prometheus
 */

/** Prometheus 指标类型（这里只用 gauge / counter 两种）。 */
export type PrometheusType = 'gauge' | 'counter';

/** 一条样本：值 + 可选标签集。 */
export interface PrometheusSample {
  value: number;
  labels?: Readonly<Record<string, string>>;
}

/** 一个指标族的定义；`collect` 在每次 scrape 时求值（pull）。 */
export interface PrometheusMetric {
  /** 指标名（须匹配 `[a-zA-Z_:][a-zA-Z0-9_:]*`）。 */
  name: string;
  type: PrometheusType;
  /** 单行帮助文本（`# HELP`）。 */
  help: string;
  /** 返回单值（无标签）或一组带标签样本。 */
  collect: () => number | readonly PrometheusSample[];
}

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** 标签值转义：反斜杠 / 双引号 / 换行（exposition format 规定）。 */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Readonly<Record<string, string>> | undefined): string {
  if (labels === undefined) return '';
  const entries = Object.entries(labels).filter(([key]) => LABEL_NAME_RE.test(key));
  if (entries.length === 0) return '';
  const inner = entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',');
  return `{${inner}}`;
}

/** 数值格式化：有限值原样；非有限值按 exposition 规范写 NaN / +Inf / -Inf。 */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

/**
 * 进程内指标注册表。`register` 登记指标族，`render` 产出 exposition 文本。
 *
 * 健壮性口径：单个指标 `collect` 抛错或名字非法 ⇒ **跳过该指标**，不让一条坏指标
 * 把整个 scrape 打爆（监控端点必须永远可响应）。这与「事件日志有错直报」不矛盾：
 * 指标采样失败是监控面的事，不该冒泡成进程错误，更不该回灌事件日志刷噪音。
 */
export class PrometheusRegistry {
  private readonly metrics: PrometheusMetric[] = [];

  register(metric: PrometheusMetric): this {
    this.metrics.push(metric);
    return this;
  }

  /** 渲染全部指标为 Prometheus text exposition format（末尾带换行）。 */
  render(): string {
    const lines: string[] = [];
    for (const metric of this.metrics) {
      if (!METRIC_NAME_RE.test(metric.name)) continue;
      let samples: readonly PrometheusSample[];
      try {
        const collected = metric.collect();
        samples = typeof collected === 'number' ? [{ value: collected }] : collected;
      } catch {
        continue;
      }
      if (samples.length === 0) continue;
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      for (const sample of samples) {
        lines.push(`${metric.name}${formatLabels(sample.labels)} ${formatValue(sample.value)}`);
      }
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}
