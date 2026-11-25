// biome-ignore-all lint/suspicious/noArrayIndexKey: diff 行没有稳定 id，顺序即语义
import { formatAddress } from '@vessel-agent/agent/address-display';
import { useEffect, useState } from 'react';
import { formatDuration, formatTimestamp } from '../../format';
import type { ProjectionSummary } from '../../gateway/types';
import { t } from '../../i18n';
import { useAddressStyle } from '../../state/address-style';
import { formatErrorMeta } from '../../state/error-visibility';
import type { Verbosity } from '../../state/visibility';
import { agentDisplayName } from './agent-labels';
import { useAgentNames } from './agent-name-context';
import { useNodeNamesContext } from './node-name-context';
import { PayloadSection } from './payload-section';
import { projectedOriginalText, showsOutputSection } from './projection';
import { ProjectionBadge, ProjectionPanes } from './projection-card';
import { StreamCard } from './StreamCard';
import {
  agentRouteOf,
  DEFAULT_SUMMARY_LENGTH,
  type DiffLine,
  editDiffOf,
  parseAgentAddress,
  resolvedTargetOf,
  type ToolCardView,
  toolSummary,
  valueText,
} from './tool-cards';
import { useToolDescription } from './tool-catalog';

const STATUS_GLYPH: Record<ToolCardView['status'], string> = {
  running: '●',
  done: '✓',
  error: '✗',
};

const STATUS_LABEL: Record<ToolCardView['status'], string> = {
  running: 'chat.tool.status.running',
  done: 'chat.tool.status.done',
  error: 'chat.tool.status.error',
};

const STATUS_TONE: Record<ToolCardView['status'], string> = {
  running: 'tone-info',
  done: 'tone-ok',
  error: 'tone-danger',
};

function DiffSection({ lines, path }: { lines: DiffLine[]; path?: string }) {
  if (lines.length === 0) return null;
  return (
    <section className="tool-section">
      <div className="tool-section-head">
        <span className="tool-section-label">
          {t('chat.tool.diff')}
          {path ? ` · ${path}` : ''}
        </span>
      </div>
      <pre className="tool-section-body whitespace-pre wrap-normal">
        {lines.map((line, index) => (
          <span
            key={index}
            className={`block ${
              line.kind === 'add'
                ? 'text-success'
                : line.kind === 'remove'
                  ? 'text-danger'
                  : 'text-faint'
            }`}
          >
            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
            {line.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </section>
  );
}

/** 运行中每秒刷新一次「已跑时长」；非运行态不挂定时器（结束时用事件给的总耗时）。 */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // 挂载 / 转运行态时先对齐一次，避免沿用上一次渲染的旧时间。
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** 工具卡：Codex 式单行 header；点击打开详情弹窗（描述 + 输入，其余分区折叠）。 */
export function ToolCard({
  card,
  verbosity = 'normal',
  defaultOpen = false,
  entering = false,
  projectionSummary,
}: {
  card: ToolCardView;
  verbosity?: Verbosity;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；用户手动开合优先。 */
  defaultOpen?: boolean;
  /** 本卡是事件流里新追加的一项：入场只播一次（判据在调用方，见 StreamCard）。 */
  entering?: boolean;
  /**
   * 整会话投影汇总（`SessionDetail.projection_summary`）。
   *
   * 只进**展开体**（spec §3.0：折叠态只讲本轮变化量，累计数放展开后），
   * 且只在卡片自己带 `projection` 时渲染；缺省 = 没有汇总可显示。
   */
  projectionSummary?: ProjectionSummary;
}) {
  const description = useToolDescription(card.name);
  // 摘要里的内部 id 换成人能认的名字（名字表由 ChatView 注入，没有就退短 id）。
  const agentNames = useAgentNames();
  const summary = toolSummary(card.name, card.args, DEFAULT_SUMMARY_LENGTH, agentNames);
  const diff = card.name === 'edit' ? editDiffOf(card.args) : null;
  const errorText = card.error !== undefined ? valueText(card.error) : '';
  const meta = formatErrorMeta(card.errorMeta);
  const projection = card.projection;

  // 完整路由（additive，问题2）：卡头摘要保持短（名字优先），舰队归属放副行 + 展开体。
  // 只有入参是完整地址 `<principal>@<node>:<team>` 时才有 route —— 旧消息的纯名字 /
  // 本地 id 解析不出，渲染逐字不变。node 名查不到退原始 id（不猜）。
  const nodeNames = useNodeNamesContext();
  const route = card.name === 'agent' ? agentRouteOf(card.args) : undefined;
  const resolvedTo = card.name === 'agent' ? resolvedTargetOf(card.result) : undefined;
  const resolvedRoute = resolvedTo !== undefined ? parseAgentAddress(resolvedTo) : undefined;
  // q-addr-display：node 段按 ui.addressStyle 渲染（name 档查名 → 短 id 兜底；
  // compact 恒短 id；full 原样）。统一走 formatAddress，不再各自拼名字表。
  const addressStyle = useAddressStyle();
  const nodeLabelOf = (node: string): string =>
    formatAddress(
      { node },
      addressStyle,
      nodeNames !== undefined ? { node: nodeNames } : undefined,
    );

  // 卡片头（StreamCard 的 meta 槽）只放**运行耗时**，运行中 / 已结束同一个口径：
  // 运行中 = 现在 - startedAt（每秒刷新），已结束 = 事件给的总耗时。
  // 没有耗时数据时宁可不显示，也不回退到绝对时间（用户要的是「跑了多久」）。
  const now = useNowTicker(card.status === 'running');
  const durationMs =
    card.durationMs ?? (card.status === 'running' ? Math.max(0, now - card.startedAt) : undefined);

  return (
    <StreamCard
      className="tool-card"
      defaultOpen={defaultOpen}
      entering={entering}
      title={
        <>
          <span
            className={`tool-card-glyph ${STATUS_TONE[card.status]}`}
            role="img"
            aria-label={t(STATUS_LABEL[card.status])}
          >
            {STATUS_GLYPH[card.status]}
          </span>
          <span className="font-mono text-sm text-ink">{card.name}</span>
        </>
      }
      meta={
        // 只显示耗时（不是绝对时间）+ 投影 badge（层级 1）。两者都没有就整块省略。
        // badge 在这里（`<summary>` 的 `meta` 槽）→ **折叠态也看得见**；它是纯文本 span，
        // 没有 tabindex / 点击，不破坏「summary 里不得放可点元素」的约束。
        durationMs === undefined && projection === undefined ? undefined : (
          <>
            {durationMs !== undefined && (
              <span className="tabular-nums">{formatDuration(durationMs)}</span>
            )}
            {projection !== undefined && (
              <>
                {durationMs !== undefined && <span aria-hidden="true"> · </span>}
                <ProjectionBadge view={projection} />
              </>
            )}
          </>
        )
      }
      summary={summary.length > 0 ? summary : undefined}
      actions={
        <>
          {/* 路由副行（折叠态也看得见）：目标舰队 = 节点展示名 + team；悬停看原始地址。
              没有完整地址（旧卡 / 纯名字 / 本地 id）时整行不渲染，逐字不变。 */}
          {route !== undefined && (
            <p
              className="m-0 break-all px-2.5 pb-1 font-mono text-2xs leading-snug text-faint"
              title={route.raw}
            >
              {`→ ${nodeLabelOf(route.node)} : ${route.team}`}
            </p>
          )}
          {/* 失败不能静默：折叠时也保留错误摘要（完整内容在展开体）。 */}
          {card.status === 'error' && errorText ? (
            <p className="m-0 line-clamp-3 whitespace-pre-wrap break-words px-2.5 pb-2 font-mono text-xs text-danger">
              {errorText}
            </p>
          ) : undefined}
        </>
      }
    >
      {projection !== undefined && (
        // 卡体首段（只有 projection 存在时出现）：原文视角 | 模型视角 + 读回。
        // 原文面板的输入是**消息正文**（`inline` / `inline_truncated` 时它就是原文）；
        // 取值走 `projectedOriginalText`：它逐字等于原「输出」分区的正文（门禁钉这条等式），
        // `readback` / `gone` 时返回 undefined，面板自己说「原文不在这里」。
        <ProjectionPanes
          view={projection}
          toolName={card.name}
          original={projectedOriginalText(projection, card.result)}
          verbosity={verbosity}
          defaultOpen={defaultOpen}
          {...(card.truncatedLimitBytes !== undefined
            ? { truncatedLimitBytes: card.truncatedLimitBytes }
            : {})}
          {...(projectionSummary !== undefined ? { summary: projectionSummary } : {})}
        />
      )}
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-wide text-faint">
          {t('chat.tool.description')}
        </span>
        <p className="m-0 text-md leading-relaxed text-muted">
          {description ?? t('chat.tool.descriptionUnavailable')}
        </p>
      </div>

      {/* 完整路由（展开体）：原始地址逐字 + 人话分解（节点名 · team · 发送对象名）。
          与副行同一份解析，不重新拼装地址；node 名查不到退原始 id。 */}
      {route !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs uppercase tracking-wide text-faint">
            {t('chat.tool.route')}
          </span>
          <p className="m-0 break-all font-mono text-xs text-muted">{route.raw}</p>
          <p className="m-0 text-xs text-faint">
            {`${nodeLabelOf(route.node)} · ${route.team} · ${
              agentDisplayName(route.principal, agentNames) ?? route.principal
            }`}
          </p>
        </div>
      )}
      {/* 服务端实际投递给谁（result.resolved_to）：本地 id 过名字表；完整地址再补舰队段。 */}
      {resolvedTo !== undefined && (
        <p className="m-0 break-all font-mono text-xs text-faint">
          {t('chat.tool.resolvedTo', {
            target:
              resolvedRoute !== undefined
                ? (agentDisplayName(resolvedRoute.principal, agentNames) ?? resolvedRoute.principal)
                : (agentDisplayName(resolvedTo, agentNames) ?? resolvedTo),
          })}
          {resolvedRoute !== undefined &&
            ` · ${nodeLabelOf(resolvedRoute.node)} : ${resolvedRoute.team}`}
        </p>
      )}

      <PayloadSection
        label={t('chat.tool.input')}
        value={card.args}
        defaultOpen
        verbosity={verbosity}
      />
      {/* 输出分区：**有投影时交给上面的双层面板**，这里不再重复一份。
          两个理由：① `inline` 时两处文本逐字相同，同一张卡显示两遍像 bug；
          ② `readback` 时消息正文已经是占位符 —— 把它当成「输出」摆一遍，等于在
          「原文不在消息里」的旁边展示 `[cleared …]`。投影卡自己负责这两层。

          「接管」不等于「丢失」：面板里的原文逐字等于这里本来会显示的那份
          （`projectedOriginalText`，门禁按「原样输出 / 空白不丢 / exit code 还在」钉住）。 */}
      {showsOutputSection(projection) && (
        <PayloadSection label={t('chat.tool.output')} value={card.result} verbosity={verbosity} />
      )}
      {diff && <DiffSection lines={diff.lines} path={diff.path} />}
      <PayloadSection
        label={t('chat.tool.error')}
        value={errorText || undefined}
        defaultOpen={card.status === 'error'}
        tone="error"
        verbosity={verbosity}
      />
      {meta && (
        <p className="error-meta font-mono tabular-nums">
          {meta}
          {card.errorMeta?.retryable === true ? ` · ${t('chat.tool.retryable')}` : ''}
        </p>
      )}
      {card.errorMeta?.httpStatus !== undefined && (
        <p className="error-meta font-mono tabular-nums">HTTP {card.errorMeta.httpStatus}</p>
      )}
      {card.truncated && <p className="text-xs text-warn">{t('chat.tool.truncated')}</p>}
      {verbosity === 'debug' && (
        <section className="tool-section">
          <div className="tool-section-label">{t('chat.tool.meta')}</div>
          <dl className="tool-meta-list font-mono tabular-nums">
            {card.callId && (
              <>
                <dt>call</dt>
                <dd>{card.callId}</dd>
              </>
            )}
            <dt>status</dt>
            <dd>{card.status}</dd>
            <dt>started</dt>
            <dd>{formatTimestamp(card.startedAt)}</dd>
            {card.durationMs !== undefined && (
              <>
                <dt>duration</dt>
                <dd>{formatDuration(card.durationMs)}</dd>
              </>
            )}
          </dl>
        </section>
      )}
    </StreamCard>
  );
}
