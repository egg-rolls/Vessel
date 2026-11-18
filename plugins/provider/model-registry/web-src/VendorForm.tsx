import { Button, Field, Input, Section, Select } from '@vessel-agent/plugin-ui';
import { type FormEvent, useRef, useState } from 'react';
import type { Translator } from './i18n';
import type { ModelEntryDto, VendorDto, VendorSetEntry } from './types';

/** promptCache 三态的表单值：auto = 缺省（不传字段）。 */
type CacheChoice = 'auto' | 'on' | 'off';

interface ModelRow {
  /** 草稿行稳定 key（编辑列表增删不重排焦点）。 */
  key: number;
  id: string;
  cache: CacheChoice;
}

type DraftRow = Omit<ModelRow, 'key'>;

function rowsOf(models: Record<string, ModelEntryDto>): DraftRow[] {
  return Object.entries(models).map(([id, entry]) => ({
    id,
    cache: entry.promptCache === undefined ? 'auto' : entry.promptCache ? 'on' : 'off',
  }));
}

/** 测试结果导入：并入现有行（保留已有 promptCache），新 id 追加为 auto。 */
function withImported(rows: DraftRow[], imported: readonly string[]): DraftRow[] {
  const known = new Set(rows.map((row) => row.id));
  const extra = imported
    .filter((id) => id.trim() !== '' && !known.has(id))
    .map((id): DraftRow => ({ id, cache: 'auto' }));
  return [...rows, ...extra];
}

export interface VendorFormProps {
  /** null = 新增；否则编辑（id 锁定，整条替换）。 */
  initial: VendorDto | null;
  /** 测试返回的模型清单（可选导入）。 */
  importModels?: readonly string[];
  busy: boolean;
  onSave: (id: string, entry: VendorSetEntry) => Promise<void>;
  onCancel: () => void;
  t: Translator;
}

/**
 * 厂商增改表单（vendor_set 整条替换）。凭证来源二选一（credential / apiKeyEnv
 * 互斥，validator 同口径）；models 至少 1 条；promptCache 三态。
 * apiKeyEnv 读回缺口：P1 list 不返回该字段，编辑时以表单为准并显式披露。
 */
export function VendorForm({ initial, importModels, busy, onSave, onCancel, t }: VendorFormProps) {
  const editing = initial !== null;
  const keyCounter = useRef(0);
  const [id, setId] = useState(initial?.id ?? '');
  const [protocol, setProtocol] = useState(initial?.protocol ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [source, setSource] = useState<'none' | 'credential' | 'env'>(
    initial?.credentialRef !== undefined ? 'credential' : 'none',
  );
  const [credentialId, setCredentialId] = useState(initial?.credentialRef ?? '');
  const [envName, setEnvName] = useState('');
  const [rows, setRows] = useState<ModelRow[]>(() => {
    const base = rowsOf(initial?.models ?? {});
    const merged = importModels !== undefined ? withImported(base, importModels) : base;
    return merged.map((row) => ({ ...row, key: keyCounter.current++ }));
  });
  const [error, setError] = useState<string | null>(null);

  function updateRow(key: number, patch: Partial<DraftRow>): void {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmedId = id.trim();
    if (trimmedId === '') {
      setError(t('vendors.form.needId'));
      return;
    }
    if (protocol.trim() === '') {
      setError(t('vendors.form.needProtocol'));
      return;
    }
    if (source === 'credential' && credentialId.trim() === '') {
      setError(t('vendors.form.needCredentialId'));
      return;
    }
    if (source === 'env' && envName.trim() === '') {
      setError(t('vendors.form.needEnvName'));
      return;
    }
    const models: Record<string, ModelEntryDto> = {};
    for (const row of rows) {
      const modelId = row.id.trim();
      if (modelId === '') continue;
      if (Object.hasOwn(models, modelId)) {
        setError(t('vendors.form.dupModel', { id: modelId }));
        return;
      }
      models[modelId] = row.cache === 'auto' ? {} : { promptCache: row.cache === 'on' };
    }
    if (Object.keys(models).length === 0) {
      setError(t('vendors.form.needModel'));
      return;
    }
    const entry: VendorSetEntry = { protocol: protocol.trim(), models };
    if (baseUrl.trim() !== '') entry.baseUrl = baseUrl.trim();
    if (source === 'credential') entry.credential = credentialId.trim();
    if (source === 'env') entry.apiKeyEnv = envName.trim();
    setError(null);
    void onSave(trimmedId, entry);
  }

  return (
    <Section
      title={editing ? t('vendors.form.editTitle', { id: initial.id }) : t('vendors.form.addTitle')}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-4 compact:grid-cols-2">
          <Field label={t('vendors.form.id')} hint={t('vendors.form.idHint')} required>
            <Input
              value={id}
              onChange={(event) => setId(event.target.value)}
              disabled={editing || busy}
              placeholder="arcostudio"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={t('vendors.form.protocol')} hint={t('vendors.form.protocolHint')} required>
            <Input
              value={protocol}
              onChange={(event) => setProtocol(event.target.value)}
              disabled={busy}
              placeholder="openai"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>
        <Field label={t('vendors.form.baseUrl')} hint={t('vendors.form.baseUrlHint')}>
          <Input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            disabled={busy}
            placeholder="https://api.example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <div className="grid gap-4 compact:grid-cols-2">
          <Field label={t('vendors.form.credentialSource')}>
            <Select
              value={source}
              onChange={(event) => setSource(event.target.value as 'none' | 'credential' | 'env')}
              disabled={busy}
            >
              <option value="none">{t('vendors.form.credentialNone')}</option>
              <option value="credential">{t('vendors.form.credentialRef')}</option>
              <option value="env">{t('vendors.form.apiKeyEnv')}</option>
            </Select>
          </Field>
          {source === 'credential' ? (
            <Field
              label={t('vendors.form.credentialId')}
              hint={t('vendors.form.credentialIdHint')}
              required
            >
              <Input
                value={credentialId}
                onChange={(event) => setCredentialId(event.target.value)}
                disabled={busy}
                placeholder="arcostudio-key"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          ) : null}
          {source === 'env' ? (
            <Field label={t('vendors.form.apiKeyEnvName')} required>
              <Input
                value={envName}
                onChange={(event) => setEnvName(event.target.value)}
                disabled={busy}
                placeholder="ANTHROPIC_API_KEY"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          ) : null}
        </div>
        {editing && initial.credentialRef === undefined ? (
          <p className="text-xs text-warn">{t('vendors.form.apiKeyEnvGap')}</p>
        ) : null}
        <Field label={t('vendors.form.models')} hint={t('vendors.form.modelsHint')} required>
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <div key={row.key} className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-52 flex-1"
                  value={row.id}
                  onChange={(event) => updateRow(row.key, { id: event.target.value })}
                  disabled={busy}
                  placeholder={t('vendors.form.modelId')}
                  aria-label={t('vendors.form.modelId')}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Select
                  className="w-40"
                  value={row.cache}
                  onChange={(event) =>
                    updateRow(row.key, { cache: event.target.value as CacheChoice })
                  }
                  disabled={busy}
                  aria-label={t('vendors.form.promptCache')}
                >
                  <option value="auto">{t('vendors.form.cacheAuto')}</option>
                  <option value="on">{t('vendors.form.cacheOn')}</option>
                  <option value="off">{t('vendors.form.cacheOff')}</option>
                </Select>
                <Button
                  size="small"
                  variant="dangerGhost"
                  disabled={busy}
                  onClick={() =>
                    setRows((current) => current.filter((item) => item.key !== row.key))
                  }
                >
                  {t('vendors.form.removeModel')}
                </Button>
              </div>
            ))}
            <div>
              <Button
                size="small"
                disabled={busy}
                onClick={() =>
                  setRows((current) => [
                    ...current,
                    { key: keyCounter.current++, id: '', cache: 'auto' },
                  ])
                }
              >
                {t('vendors.form.addModel')}
              </Button>
            </div>
          </div>
        </Field>
        {error !== null ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {t('common.save')}
          </Button>
          <Button disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Section>
  );
}
