/**
 * 会话页成员模型切换入口（model-registry P2）。
 *
 * 切换动作 = 成员级 pin 变更（canonical `agents.update {model}`，现有 wire 字段，零新增）：
 * live body / EU 不变（前缀不变量），下一具 body / 续接 run 生效，届时由 P0-1 Step D
 * 机制在会话追加一条环境信息卡（scope=model，只一次）。前端不造「立即生效」假象，
 * 文案写明生效点。空 = 不修改（wire 拒空串 model；unpin 属另行批准的语义变更，本期不做）。
 *
 * 入口挂在会话输入框工具栏（`Composer` → `ComposerField` 扩展槽）：会话带归属成员
 * （`session.agent`）才显示；紧凑 pill 显示当前模型，读 `sessions.get.system_context.model`
 * （这具 body 最后看到的模型）。pill 窄宽（max-w-36）+ 截断，完整模型名进 Tooltip。
 * 打开弹窗时经 `agents.get` 读显式 pin（model-registry A+B 用户批准，只读 DTO），
 * 有 pin 则预填选择器并展示「当前固定」；读失败诚实降级（不显示 pin、不预填）。
 */
import { useRef, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { ModelPicker } from '../../components/ModelPicker';
import { useToast } from '../../components/ToastProvider';
import { Tooltip } from '../../components/Tooltip';
import { Button, cn, Field, Icon } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { t, useLocale } from '../../i18n';
import { composerQuietIconTone } from './composer-controls';
import { errorMessage } from './errors';

export interface MemberModelSwitchProps {
  agentId: string;
  agentName?: string;
  /** 这具 body 最后看到的模型（system_context.model）；缺省 = 未知，不显示假值。 */
  currentModel?: string;
}

/**
 * 工具栏紧凑 pill（文本控件）：与回形针 / 发送键同族 —— 同一个 --control-h 高度、
 * rounded-full、--surface-sunken 底、--line-strong 描边，色调复用次要动作 quiet 档
 * （静止 --muted、hover --ink、禁用 --faint 且形状不塌）。不是正圆所以不套
 * composerIconControlClass（那是 32px 方盒），只共享高度 / 底色 / 描边 token。
 * 宽度收窄到 max-w-36，模型名超长由内部 span 截断（ellipsis）。
 */
const memberModelPillClass = cn(
  'h-control max-w-36 flex-none gap-1 rounded-full border border-line-strong bg-sunken px-2.5 py-0 text-xs disabled:opacity-100',
  // 键盘焦点环换低调灰（用户验收③，与 thinking pill 同构）：抵掉 Button 基类的
  // 主题色 ring-accent + offset；鼠标点击本就不触发 focus-visible，无额外 border。
  'focus-visible:ring-line-strong focus-visible:ring-offset-0',
  composerQuietIconTone,
);

export function MemberModelSwitch({ agentId, agentName, currentModel }: MemberModelSwitchProps) {
  useLocale();
  const toast = useToast();
  const { client, hasToken, connectionState } = useConnection();
  const { current } = useNodes();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [pin, setPin] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 打开序号：防止上一次打开的迟到 fetch 覆盖本次状态。
  const openSeq = useRef(0);
  const name = agentName?.trim() || agentId;
  const canWrite = hasToken && connectionState === 'open';
  const knownModel = currentModel !== undefined && currentModel !== '' ? currentModel : undefined;
  // Tooltip / 无障碍名：动作说明 + 完整模型名（pill 内截断，悬浮看全名）。
  const label =
    knownModel !== undefined
      ? `${t('chat.memberModel.tooltip')} · ${knownModel}`
      : t('chat.memberModel.tooltip');

  const openModal = () => {
    const seq = ++openSeq.current;
    setValue('');
    setPin(undefined);
    setError(null);
    setOpen(true);
    // 显式 pin 只读回显（A+B）；agents.get 不可用 / 旧 gateway 无字段 → 静默降级。
    client
      .rpc<{ agent?: { model?: string } }>('agents.get', { agent_id: agentId })
      .then((result) => {
        if (seq !== openSeq.current) return;
        const model = result.agent?.model;
        if (typeof model === 'string' && model !== '') {
          setPin(model);
          setValue(model);
        }
      })
      .catch(() => {}); // benign: 切换器当前模型读探针——失败保持旧显示（submit 路径自有错误处理）。
  };

  const submit = async () => {
    if (busy || value === '' || value === pin) return;
    setBusy(true);
    setError(null);
    try {
      await client.updateAgent({ agent_id: agentId, model: value });
      toast.success(t('chat.memberModel.saved', { name }));
      setOpen(false);
      setValue('');
    } catch (caught) {
      setError(`${t('chat.memberModel.failed')}: ${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tooltip label={label}>
        <Button
          variant="plain"
          disabled={!canWrite}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={openModal}
          className={memberModelPillClass}
        >
          <span className="min-w-0 truncate font-mono">
            {knownModel ?? t('chat.memberModel.button')}
          </span>
          <Icon name="chevron" size={12} className="rotate-90 text-faint" />
        </Button>
      </Tooltip>
      {open && (
        <ModalShell
          label={t('chat.memberModel.title', { name })}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          closeOnBackdrop={!busy}
          closeLabel={t('common.close')}
          size="sm"
        >
          <h2 className="modal-title">{t('chat.memberModel.title', { name })}</h2>
          <div className="flex flex-col gap-2">
            {pin !== undefined && (
              <p className="mt-1 mb-0 text-sm text-muted">
                {t('chat.memberModel.currentPin', { model: pin })}
              </p>
            )}
            <p className="mt-1 mb-0 text-sm text-muted">
              {knownModel !== undefined
                ? t('chat.memberModel.currentBody', { model: knownModel })
                : t('chat.memberModel.currentUnknown')}
            </p>
            <Field
              label={t('agents.form.model')}
              htmlFor="member-model-picker"
              hint={t('chat.memberModel.hint')}
            >
              <ModelPicker
                id="member-model-picker"
                node={current ?? undefined}
                value={value}
                onChange={setValue}
                aria-label={t('agents.form.model')}
              />
            </Field>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <Button onClick={() => setOpen(false)} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={busy || value === '' || value === pin}
                onClick={() => void submit()}
              >
                {busy ? t('common.processing') : t('team.form.submitEdit')}
              </Button>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}
