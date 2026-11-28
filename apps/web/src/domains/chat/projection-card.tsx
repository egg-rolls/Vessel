/**
 * 投影卡的两个零件（0.54）：**badge**（层级 1，常驻可见）与**双层切换**（层级 2）。
 *
 * spec = `docs/specs/projection-card-spec.md`（0.54 投影卡规格；早期 design 稿已退场）。
 *
 * 它们**不认识「工具」**，只认识 `ProjectionView`（spec §4.3）：工具卡只是第一个宿主。
 * 纯逻辑（词表 / 默认视角 / 读回抽帧 / 汇总口径）全在 `projection.ts` 里，这里只摆 DOM。
 *
 * 硬约束（踩过就是 bug）：
 * - badge 只是**纯文本 + `title`**，不是按钮、无 tabindex、不挂 `aria-live`（spec §3.2）；
 * - 切换器状态是**每张卡自己的 `useState`**：它是一次阅读姿态，不是偏好，不写 store、
 *   不持久化（跨卡记忆会让人误判「所有卡都显示的是原文」）；
 * - 未激活的面板**不 mount**（`SegmentedTabs` 只给 tablist，面板由这里按 `tab` 二选一），
 *   避免一次把两段 MB 级原文塞进 DOM；
 * - 三个数字口径互不越界：单条体量只读 wire 的 `original_bytes`，汇总只读
 *   `projection_summary`，**折叠态不出累计数**（spec §3.0）。
 */

import { Fragment, useId, useState } from 'react';
import { SegmentedTabs } from '../../components/Tabs';
import { Button } from '../../components/ui';
import type { ProjectionSummary, ProjectionView } from '../../gateway/types';
import { t } from '../../i18n';
import type { Verbosity } from '../../state/visibility';
import { PayloadSection } from './payload-section';
import {
  defaultProjectionTab,
  hasProjectionPanes,
  modelViewTextOf,
  type ProjectionTab,
  projectionBadgeOf,
  projectionMetaFieldsOf,
  readbackActionKeyOf,
  readbackOutcomeOf,
  readbackRequestOf,
  savedBytesOf,
  summaryLowerBoundCount,
  TRUNCATION_LIMIT_FALLBACK_BYTES,
  truncationLimitLabel,
} from './projection';
import { useProjectionReadback } from './projection-readback';

/** 读回这一格的临时状态：**只活在这张卡里**（不回写缓存、不进消息、不落盘）。 */
type ReadbackState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; text: string }
  | { kind: 'gone' };

/**
 * 层级 1：投影 badge（**常驻可见**，折叠态也在）。
 *
 * 位置由宿主决定（`StreamCard` 的 `meta` 槽）；文案按 mode 选（spec §3.2），
 * `passthrough` / `archive_notice` 返回 `null`（ADR-104 §8.5 明确这两个不进披露行）。
 */
export function ProjectionBadge({ view }: { view: ProjectionView }) {
  const spec = projectionBadgeOf(view);
  if (spec === null) return null;
  // 长解释走 `title`（不做弹出层）；`readback` / `gone` 追加一句「为什么默认落在模型视角」。
  const hint = [t(spec.hintKey), ...(spec.reasonKey !== undefined ? [t(spec.reasonKey)] : [])];
  return (
    <span
      className={`projection-badge${spec.danger ? ' projection-badge-danger' : ''}`}
      title={hint.join(' ')}
    >
      {t(spec.labelKey)}
    </span>
  );
}

/** 元信息一行（`工具名 / 原文体量 / 发生 seq`）：原文不在消息里时至少让人知道是哪一条。 */
function ProjectionMeta({ view, toolName }: { view: ProjectionView; toolName: string }) {
  return (
    <dl className="projection-meta font-mono tabular-nums">
      {projectionMetaFieldsOf(view, toolName).map((field) => {
        // `null` = 服务端不知道（显示「未知」，绝不显示 0）；字节数带单位，其余原样。
        const value =
          field.value === null
            ? t('chat.projection.meta.unknown')
            : field.unit === 'bytes'
              ? t('chat.projection.bytes', { bytes: field.value })
              : field.value;
        return (
          <Fragment key={field.labelKey}>
            <dt>{t(field.labelKey)}</dt>
            <dd>{value}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

/**
 * 层级 2：双层切换（原文视角 | 模型视角）+ 读回。
 *
 * 默认 tab 见 `defaultProjectionTab`（用户裁定 A）：原文在正文里就是原文视角，
 * `readback` / `gone` 自动落模型视角（否则默认给人一个空面板）。
 */
export function ProjectionPanes({
  view,
  toolName,
  original,
  verbosity,
  defaultOpen,
  summary,
  truncatedLimitBytes,
}: {
  view: ProjectionView;
  /** 工具名（只用于元信息行；投影本身不认识工具）。 */
  toolName: string;
  /** 消息正文里的原文（`inline` / `inline_truncated` 才有；其余情况 `undefined`）。 */
  original: string | undefined;
  verbosity: Verbosity;
  defaultOpen: boolean;
  /** 整会话汇总（展开体里的累计数；缺省 = 没有汇总可显示）。 */
  summary?: ProjectionSummary;
  /**
   * 截断上限（wire `message.truncated.content.limit`）。
   *
   * 缺省 = wire 没告诉 ⇒ 用 `TRUNCATION_LIMIT_FALLBACK_BYTES` 兜底（末路，不是默认值）：
   * 「已截到前 N」是要用户当事实读的数字，优先永远取 wire。
   */
  truncatedLimitBytes?: number;
}) {
  const [tab, setTab] = useState<ProjectionTab>(() => defaultProjectionTab(view));
  const [readback, setReadback] = useState<ReadbackState>({ kind: 'idle' });
  const loader = useProjectionReadback();
  const panelId = useId();

  if (!hasProjectionPanes(view)) return null;

  const request = readbackRequestOf(view);
  const loaded = readback.kind === 'loaded' ? readback.text : undefined;
  // 「已截到前 N」：N 优先取 wire 的 `truncated.content.limit`，常量只是兜底。
  const limitLabel = truncationLimitLabel(truncatedLimitBytes ?? TRUNCATION_LIMIT_FALLBACK_BYTES);
  // 原文面板里能拿到的东西，按优先级：本次读回 > 消息正文（inline / inline_truncated）。
  const inlineOriginal = original !== undefined && original.length > 0 ? original : undefined;
  const shownOriginal = loaded ?? inlineOriginal;
  const goneCopy =
    readback.kind === 'gone'
      ? t('chat.projection.gone')
      : view.original_available === 'gone'
        ? t('chat.projection.gone')
        : undefined;

  const load = () => {
    if (request === undefined || loader === undefined) {
      // 读不到就是读不到：与「读回为空」同一条降级文案（不弹错误框、不显示 stack）。
      setReadback({ kind: 'gone' });
      return;
    }
    setReadback({ kind: 'loading' });
    void loader(request).then((text) => {
      const outcome = readbackOutcomeOf(text);
      setReadback(
        outcome.kind === 'text' ? { kind: 'loaded', text: outcome.text } : { kind: 'gone' },
      );
    });
  };

  const readbackButton = () => {
    if (request === undefined || goneCopy !== undefined) return null;
    // 文案按状态区分：截断态取回「被截掉的尾巴」，占位态取回「占位之前的原文」。
    const labelKey = readbackActionKeyOf(view);
    if (labelKey === undefined) return null;
    return (
      <Button
        variant="link"
        className="projection-action"
        disabled={readback.kind === 'loading'}
        onClick={load}
      >
        {t(labelKey)}
      </Button>
    );
  };

  const originalPanel = () => {
    if (shownOriginal !== undefined) {
      return (
        <>
          <PayloadSection
            label={t('chat.projection.original')}
            value={shownOriginal}
            // 读回来的那一次展开：用户刚点了「读回」，给他直接看到内容。
            defaultOpen={defaultOpen || loaded !== undefined}
            copyLabel={t('chat.projection.copyOriginal')}
            verbosity={verbosity}
          />
          {view.original_available === 'inline_truncated' && loaded === undefined && (
            // 截断是**事实**，不是错误：一行 warn。
            // 上限取 wire 的 `truncated.content.limit`（`truncationLimitLabel`），拿不到才兜底；
            // 原文体量只读 wire 的 `original_bytes`（不从正文数）。
            <p className="projection-warn">
              {view.original_bytes === null
                ? t('chat.projection.truncatedWarnUnknown', { limit: limitLabel })
                : t('chat.projection.truncatedWarn', {
                    limit: limitLabel,
                    bytes: view.original_bytes,
                  })}
            </p>
          )}
          {readback.kind === 'gone' && (
            // 读回失败 / 为空：**明确降级**（这里已经显示了裁断前的那一段，
            // 但「完整原文」确实回不来了）。不弹错误框、不显示 stack。
            <p className="projection-gone">{t('chat.projection.gone')}</p>
          )}
          {readbackButton()}
        </>
      );
    }
    if (goneCopy !== undefined) {
      // `gone`：无按钮（没有可读的东西），也不弹错误框。
      return (
        <>
          <p className="projection-gone">{goneCopy}</p>
          <ProjectionMeta view={view} toolName={toolName} />
        </>
      );
    }
    return (
      <>
        <p className="projection-missing">{t('chat.projection.notInMessage')}</p>
        <ProjectionMeta view={view} toolName={toolName} />
        {request === undefined ? (
          // `file` / `handle` 的读回动作还没接线：说清「读不了」，不假装能读、不猜来源。
          <p className="projection-note">{t('chat.projection.readbackUnsupported')}</p>
        ) : (
          readbackButton()
        )}
      </>
    );
  };

  return (
    <section className="projection-panes">
      <SegmentedTabs
        label={t('chat.projection.tabsLabel')}
        tabs={[
          { id: 'original', label: t('chat.projection.tab.original') },
          { id: 'model', label: t('chat.projection.tab.model') },
        ]}
        value={tab}
        onChange={setTab}
        panelId={panelId}
        // 卡内的切换器不要默认上边距（卡体自己给间距）。
        className="mt-0"
      />
      <div
        className="projection-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${panelId}-tab-${tab}`}
      >
        {tab === 'original' ? (
          originalPanel()
        ) : (
          // 模型视角：**逐字**（`modelViewTextOf` 就是 wire 上的 `placeholder_text`）。
          // 面板默认折叠（spec §3.3）：占位只有一行，折叠态的预览已经把它整段显示出来了，
          // 展开只是姿势问题 —— 真正要看的「和原文的差别」在切换 tab 那一刻就成立。
          <PayloadSection
            label={t('chat.projection.modelView')}
            value={modelViewTextOf(view)}
            defaultOpen={false}
            copyLabel={t('chat.projection.copyModel')}
            verbosity={verbosity}
          />
        )}
      </div>
      {summary !== undefined && <ProjectionSummaryLine summary={summary} />}
    </section>
  );
}

/**
 * 会话累计（spec §3.0）：**只出现在展开体里**，卡片头（折叠态）只讲「这一条被投影了」。
 *
 * 数字口径三条：
 * - `total` 是整会话口径（`projection_summary.total`），不是当前窗口；
 * - 「省了多少」从**净值** clamp 到 ≥0（服务端不 clamp，负数真的存在）；
 * - `unknown_original_count > 0` 时它只是**下界**，必须写明有几条体量未知。
 */
function ProjectionSummaryLine({ summary }: { summary: ProjectionSummary }) {
  const lowerBound = summaryLowerBoundCount(summary);
  return (
    <p className="projection-summary font-mono tabular-nums">
      {t('chat.projection.summary.total', {
        total: summary.total,
        saved: savedBytesOf(summary),
      })}
      {lowerBound > 0 && ` ${t('chat.projection.summary.lowerBound', { count: lowerBound })}`}
    </p>
  );
}
