/**
 * 会话页成员模型切换入口（model-registry P2）。
 *
 * 切换动作 = 成员级 pin 变更（canonical `agents.update {model}`，现有 wire 字段，零新增）：
 * live body / EU 不变（前缀不变量），下一具 body / 续接 run 生效，届时由 P0-1 Step D
 * 机制在会话追加一条环境信息卡（scope=model，只一次）。前端不造「立即生效」假象，
 * 文案写明生效点。空 = 不修改（wire 拒空串 model；unpin 属另行批准的语义变更，本期不做）。
 *
 * 入口挂在 SessionHeader 标题行：会话带归属成员（`session.agent`）才显示；
 * chip「当前模型」读 `sessions.get.system_context.model`（这具 body 最后看到的模型）。
 * 打开弹窗时经 `agents.get` 读显式 pin（model-registry A+B 用户批准，只读 DTO），
 * 有 pin 则预填选择器并展示「当前固定」；读失败诚实降级（不显示 pin、不预填）。
 */
import { useRef, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { ModelPicker } from '../../components/ModelPicker';
import { useToast } from '../../components/ToastProvider';
import { Tooltip } from '../../components/Tooltip';
import { Button, Field } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { useNodes } from '../../gateway/NodeProvider';
import { t, useLocale } from '../../i18n';
import { errorMessage } from './errors';

export function MemberModelSwitch({
  agentId,
  agentName,
  currentModel,
}: {
  agentId: string;
  agentName?: string;
  /** 这具 body 最后看到的模型（system_context.model）；缺省 = 未知，不显示假值。 */
  currentModel?: string;
}) {
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
      .catch(() => {});
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
      <Tooltip label={t('chat.memberModel.tooltip')}>
        <Button
          variant="chip"
          size="small"
          disabled={!canWrite}
          aria-label={t('chat.memberModel.tooltip')}
          onClick={openModal}
        >
          {t('chat.memberModel.button')}
          {knownModel !== undefined && (
            <span className="max-w-40 truncate font-mono">· {knownModel}</span>
          )}
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
