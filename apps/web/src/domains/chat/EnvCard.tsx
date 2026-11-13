/**
 * 「环境信息」卡：模型上下文里所有「模型需要知道的改变」的**唯一**渲染点。
 *
 * 用户裁定（0.52）：只有这一类卡 —— 身份 / 工具 / 模型 / 字段 / 重启 / 上下文快照都是它的
 * scope，标题就叫「环境信息」，scope 只决定卡头标签。数据有两条来源，渲染只有这一处：
 * - `vessel:notice` 消息（`env-notice.ts` 解析出的行）；
 * - `prompt.system_context` 事件（`envCardOfPromptContext` 装配的行 + 全量快照原文块）。
 *
 * 与「来自 agent X」卡（`AgentMessageCard`）是同一张卡（`StreamCard`），同一套样式与
 * 同一套展开机制 —— 用户裁决：上下文卡复用 agent 卡的样式，别再给环境信息单独换肤。
 * 对齐的具体口径：
 * - 卡头 title 槽 = 「环境信息」字样，**主题色**（`text-accent`）：用户 0.52 裁定，这张卡的身份
 *   字样才该被着色；
 * - 卡头 scope 槽（配置 / 身份 / 工具 / 上下文 …）= **白色 / 正文色**（`text-ink`），不再用 accent：
 *   一句话里「是什么卡」用强调色、「哪一类」用正文色，两者抢同一抹颜色会看不出主次；
 * - 卡头 meta 槽 = 折叠条数（「N 条」，与失败卡的 run id 同一个位置）；调用方可覆盖
 *   （`meta`：增量视图的「N 项变更」）；
 * - summary 单行 ellipsis（`.event-block-preview`）= 一眼要看的事实。调用方可用 `facts`
 *   直接给这行（`模型 · N 条消息 · N 个工具 · 1.2k tokens` 这种），此时**展开体里不再重复**
 *   这些事实 —— 展开体是证据（原文块 / hash / 窗口上限），不是把摘要再抄一遍；
 *   缺省仍是首行原文，与 agent 卡同一截断规则；
 * - 展开体 = **全部**行的原文（含首行）+ 未生效标记 + 超出上限的省略提示 + 原文块
 *   （`blocks`：全量快照，不渲染 markdown —— 原文就是事实）；
 *   时间（与 agent 卡的来源地址 / 时间同位置）在展开体首行的 mono 小字里，`footnote`
 *   同一行补 hash 之类的事实；
 * - 单行 / 多行同一套交互：有展开体就可展开（chevron + 点击整行 + `<details>` 原生可访问），
 *   单行也不例外 —— 单行的展开体就是那一行的完整原文。理由：summary 是 ellipsis 单行，
 *   长首行的全文只能靠展开读到（以前多行卡的首行永远读不全）；「单行不显示 chevron」
 *   等于把同一张卡分成两种交互，正是要收敛掉的那种分叉；空展开区则是 chevron 指向空气。
 *
 * scope 与行切分仍归 `env-notice.ts`（解析 / 折叠规则不动），这里只做展示。
 */
import type { ReactNode } from 'react';
import { formatClock } from '../../format';
import { t } from '../../i18n';
import type { EnvNoticeBlock, EnvNoticeCard } from './env-notice';
import { StreamCard } from './StreamCard';

export function EnvCard({
  env,
  ts,
  defaultOpen = false,
  entering,
  meta,
  footnote,
  facts,
  blocks,
}: {
  /** `env-notice.ts` 解析 / 折叠后的卡片数据。 */
  env: EnvNoticeCard;
  /** 这条上下文消息的时间（Unix ms）；缺省不显示，与 agent 卡同一处理。 */
  ts?: number;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；手动开合优先。 */
  defaultOpen?: boolean;
  /** 本帧才追加进来的项：入场只播一次（与其它卡同一判定）。 */
  entering?: boolean;
  /** 卡头 meta 槽的覆盖文案（缺省 = 折叠条数「N 条」）。 */
  meta?: ReactNode;
  /** 展开区首行（时间之后）的补充事实：hash / 上一份 hash / 窗口上限。 */
  footnote?: ReactNode;
  /**
   * 折叠态那一行要给的事实（`模型 · N 条消息 · N 个工具 · 1.2k tokens`）。
   *
   * 传了它，`summary` 就由它拼成，**调用方应同时把这些事实从 `env.lines` 里拿掉** ——
   * 展开体是证据，不是把摘要抄第二遍（用户 0.52 裁定：一眼要看的事实放缩略卡，
   * 展开里只留原文块 / hash / 窗口上限）。
   */
  facts?: readonly string[];
  /** 展开区的原文块（0.52，additive：`prompt.system_context` 的全量快照）。 */
  blocks?: readonly EnvNoticeBlock[];
}) {
  const clock = formatClock(ts);
  return (
    <StreamCard
      className="env-notice-card w-full min-w-0 max-w-full"
      ariaLabel={t('chat.env.aria')}
      defaultOpen={defaultOpen}
      {...(entering !== undefined ? { entering } : {})}
      title={
        <>
          {/* 用户裁定（0.52）：这类卡叫「环境信息」，scope 只是卡头标签 —— 以前卡头只有
              scope，于是「上下文卡」「文件卡」看起来像几种卡，正是要收敛掉的分叉。 */}
          <span className="shrink-0 font-mono text-2xs tracking-wider text-accent">
            {t('chat.env.title')}
          </span>
          {/* scope 只是「哪一类」，用正文色；强调色留给上一格的「环境信息」。 */}
          <span className="max-w-56 truncate font-mono text-2xs tracking-wider text-ink">
            {t(`chat.env.scope.${env.scope}`)}
          </span>
          {/* 未生效是同一标签里的 danger 文案（在截断 span 之外，永远不被省略）。 */}
          {!env.ok && (
            <span className="font-mono text-2xs text-danger">{t('chat.env.notApplied')}</span>
          )}
        </>
      }
      meta={meta ?? (env.count > 1 ? t('chat.env.count', { count: env.count }) : undefined)}
      summary={facts && facts.length > 0 ? facts.join(' · ') : env.lines[0]?.text}
    >
      {clock !== '' && (
        // 与 agent 卡同一个位置：展开体首行，等宽 / 淡色 / 可选中。
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 font-mono text-2xs text-faint">
          <time className="shrink-0 tabular-nums" dateTime={new Date(ts ?? 0).toISOString()}>
            {clock}
          </time>
          {footnote}
        </div>
      )}
      <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
        {env.lines.map((line) => (
          // 行身份由 env-notice.ts 在构建 / 折叠时按卡内序号重编（同一张卡内唯一）。
          <li
            className="min-w-0 break-words whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink"
            key={line.id}
          >
            {!line.ok && <span className="mr-1.5 text-danger">{t('chat.env.notApplied')}</span>}
            {line.text}
          </li>
        ))}
        {env.droppedLines !== undefined && (
          <li className="min-w-0 text-2xs text-faint">
            {t('chat.env.moreLines', { count: env.droppedLines })}
          </li>
        )}
      </ul>
      {/* 原文块：全量快照（不渲染 markdown —— 原文就是事实），自带最大高度与滚动。 */}
      {(blocks ?? env.blocks)?.map((block) => (
        <div className="min-w-0" key={block.labelKey}>
          <div className="event-raw-label">{t(block.labelKey as never)}</div>
          <pre className="run-error-body">{block.text}</pre>
        </div>
      ))}
    </StreamCard>
  );
}
