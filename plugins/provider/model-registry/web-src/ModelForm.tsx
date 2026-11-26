import { Button, Field, Input, Section, Select } from '@vessel-agent/plugin-ui';
import { useState } from 'react';
import type { Translator } from './i18n';
import {
  CANONICAL_PROVIDERS,
  type CredentialDto,
  defaultModeFor,
  type EntryInfoDto,
  type EntryParamDto,
  type EntryPricingDto,
  type ModelEntryDto,
  type ModelSetEntry,
  modesFor,
} from './types';

/**
 * 模型面表单（两面重构 §9.1）。字段序对齐用户裁定：
 * provider（协议下拉）→ 模型名称（name，占位 = 条目键）→ 别称 → 请求模式（随 provider 过滤）
 * → 访问凭证*（下拉 = credentials；空时内联「去创建凭证」）→ 价格四元组（可选）
 * → param（temperature/maxTokens/topP/promptCache + extra JSON）→ info（展示元数据 + 自由 JSON）。
 * 语义校验在后端 validateModels（写前预校验回传，错误原文展示）。
 */
export interface ModelFormProps {
  initial?: ModelEntryDto;
  credentials: CredentialDto[];
  busy: boolean;
  t: Translator;
  onSave: (id: string, entry: ModelSetEntry) => void;
  onCancel: () => void;
}

function numOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

export function ModelForm({ initial, credentials, busy, t, onSave, onCancel }: ModelFormProps) {
  const editing = initial !== undefined;
  const [id, setId] = useState(initial?.id ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? 'openai');
  const [name, setName] = useState(
    initial !== undefined && initial.name !== initial.id ? initial.name : '',
  );
  const [alias, setAlias] = useState(initial?.alias ?? '');
  const [mode, setMode] = useState(initial?.mode ?? defaultModeFor(initial?.provider ?? 'openai'));
  const [credential, setCredential] = useState(initial?.credential ?? '');
  const [error, setError] = useState<string | null>(null);

  const p = initial?.pricing;
  const [inputPrice, setInputPrice] = useState(p?.inputPerMillion?.toString() ?? '');
  const [outputPrice, setOutputPrice] = useState(p?.outputPerMillion?.toString() ?? '');
  const [cacheReadPrice, setCacheReadPrice] = useState(p?.cacheReadPerMillion?.toString() ?? '');
  const [cacheWritePrice, setCacheWritePrice] = useState(p?.cacheWritePerMillion?.toString() ?? '');

  const param = initial?.param;
  const [temperature, setTemperature] = useState(param?.temperature?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(param?.maxTokens?.toString() ?? '');
  const [topP, setTopP] = useState(param?.topP?.toString() ?? '');
  const [promptCache, setPromptCache] = useState<'auto' | 'on' | 'off'>(
    param?.promptCache === undefined ? 'auto' : param.promptCache ? 'on' : 'off',
  );
  const [extraJson, setExtraJson] = useState(
    param?.extra !== undefined ? JSON.stringify(param.extra, null, 2) : '',
  );

  const info = initial?.info;
  const [displayName, setDisplayName] = useState(
    typeof info?.displayName === 'string' ? info.displayName : '',
  );
  const [description, setDescription] = useState(
    typeof info?.description === 'string' ? info.description : '',
  );
  const [contextWindow, setContextWindow] = useState(info?.contextWindow?.toString() ?? '');
  const [maxOutputTokens, setMaxOutputTokens] = useState(info?.maxOutputTokens?.toString() ?? '');
  const [capVision, setCapVision] = useState(info?.capabilities?.vision === true);
  const [capThinking, setCapThinking] = useState(info?.capabilities?.thinking === true);
  const [capTools, setCapTools] = useState(info?.capabilities?.tools === true);
  const knownInfoKeys = new Set([
    'displayName',
    'description',
    'contextWindow',
    'maxOutputTokens',
    'capabilities',
  ]);
  const extraInfo: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info ?? {})) {
    if (!knownInfoKeys.has(key)) extraInfo[key] = value;
  }
  const [infoJson, setInfoJson] = useState(
    Object.keys(extraInfo).length > 0 ? JSON.stringify(extraInfo, null, 2) : '',
  );

  const providerOptions = [...CANONICAL_PROVIDERS];
  if (!providerOptions.includes(provider as (typeof CANONICAL_PROVIDERS)[number])) {
    providerOptions.push(provider as (typeof CANONICAL_PROVIDERS)[number]);
  }

  function changeProvider(next: string): void {
    setProvider(next);
    setMode(defaultModeFor(next));
  }

  function parseJsonObject(raw: string, field: string): Record<string, unknown> | undefined | null {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError(t('models.form.badJson', { field }));
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      setError(t('models.form.badJson', { field }));
      return null;
    }
  }

  function submit(): void {
    setError(null);
    const key = id.trim();
    if (key === '') {
      setError(t('models.form.needId'));
      return;
    }
    if (credential === '') {
      setError(t('models.form.needCredential'));
      return;
    }
    const extra = parseJsonObject(extraJson, t('models.form.extra'));
    if (extra === null) return;
    const infoExtra = parseJsonObject(infoJson, t('models.form.infoJson'));
    if (infoExtra === null) return;

    const entry: ModelSetEntry = { credential };
    const wire = name.trim();
    if (wire !== '' && wire !== key) entry.name = wire;
    const aliasValue = alias.trim();
    if (aliasValue !== '') entry.alias = aliasValue;
    if (provider !== 'openai') entry.provider = provider;
    if (mode !== defaultModeFor(provider)) entry.mode = mode;

    const input = numOrUndefined(inputPrice);
    const output = numOrUndefined(outputPrice);
    if (input !== undefined || output !== undefined) {
      if (input === undefined || output === undefined) {
        setError(t('models.form.badNumber', { field: t('models.form.pricing') }));
        return;
      }
      const pricing: EntryPricingDto = { inputPerMillion: input, outputPerMillion: output };
      const cacheRead = numOrUndefined(cacheReadPrice);
      const cacheWrite = numOrUndefined(cacheWritePrice);
      if (cacheRead !== undefined) pricing.cacheReadPerMillion = cacheRead;
      if (cacheWrite !== undefined) pricing.cacheWritePerMillion = cacheWrite;
      entry.pricing = pricing;
    }

    const paramOut: EntryParamDto = {};
    const temp = numOrUndefined(temperature);
    const maxTok = numOrUndefined(maxTokens);
    const top = numOrUndefined(topP);
    if (temp !== undefined) paramOut.temperature = temp;
    if (maxTok !== undefined) paramOut.maxTokens = maxTok;
    if (top !== undefined) paramOut.topP = top;
    if (promptCache !== 'auto') paramOut.promptCache = promptCache === 'on';
    if (extra !== undefined) paramOut.extra = extra;
    if (Object.keys(paramOut).length > 0) entry.param = paramOut;

    const infoOut: EntryInfoDto = { ...infoExtra };
    if (displayName.trim() !== '') infoOut.displayName = displayName.trim();
    if (description.trim() !== '') infoOut.description = description.trim();
    const ctx = numOrUndefined(contextWindow);
    const maxOut = numOrUndefined(maxOutputTokens);
    if (ctx !== undefined) infoOut.contextWindow = ctx;
    if (maxOut !== undefined) infoOut.maxOutputTokens = maxOut;
    if (capVision || capThinking || capTools) {
      infoOut.capabilities = {
        ...(capVision ? { vision: true } : {}),
        ...(capThinking ? { thinking: true } : {}),
        ...(capTools ? { tools: true } : {}),
      };
    }
    if (Object.keys(infoOut).length > 0) entry.info = infoOut;

    onSave(key, entry);
  }

  return (
    <Section
      title={editing ? t('models.form.editTitle', { id: initial.id }) : t('models.form.addTitle')}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error !== null ? (
          <p role="alert" className="text-sm text-danger wrap-anywhere">
            {error}
          </p>
        ) : null}
        <div className="grid gap-4 compact:grid-cols-2">
          <Field label={t('models.form.id')} hint={t('models.form.idHint')} required>
            <Input
              value={id}
              onChange={(event) => setId(event.target.value)}
              disabled={busy || editing}
              placeholder="qwen4-max"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={t('models.form.provider')} hint={t('models.form.providerHint')}>
            <Select
              value={provider}
              onChange={(event) => changeProvider(event.target.value)}
              disabled={busy}
            >
              {providerOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('models.form.name')} hint={t('models.form.nameHint')}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
              placeholder={id.trim() !== '' ? id.trim() : 'dashscope/qwen4-max'}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={t('models.form.alias')} hint={t('models.form.aliasHint')}>
            <Input
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              disabled={busy}
              placeholder="qwen"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={t('models.form.mode')} hint={t('models.form.modeHint')}>
            <Select value={mode} onChange={(event) => setMode(event.target.value)} disabled={busy}>
              {modesFor(provider).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('models.form.credential')}
            hint={t('models.form.credentialHint')}
            required
          >
            {credentials.length === 0 ? (
              <p className="text-sm text-muted">
                {t('models.form.credentialNone')}{' '}
                <a className="underline" href="credentials.html">
                  {t('models.form.goCredentials')}
                </a>
              </p>
            ) : (
              <Select
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                disabled={busy}
              >
                <option value="">—</option>
                {credentials.map((cred) => (
                  <option key={cred.id} value={cred.id}>
                    {cred.id}
                    {cred.hasValue ? '' : ` (${t('credentials.valueMissing')})`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <details className="rounded-md border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t('models.form.pricing')} ({t('common.optional')})
          </summary>
          <div className="mt-3 grid gap-4 compact:grid-cols-2">
            <Field label={t('models.form.inputPrice')}>
              <Input
                value={inputPrice}
                onChange={(event) => setInputPrice(event.target.value)}
                disabled={busy}
                placeholder="2.0"
                autoComplete="off"
              />
            </Field>
            <Field label={t('models.form.outputPrice')}>
              <Input
                value={outputPrice}
                onChange={(event) => setOutputPrice(event.target.value)}
                disabled={busy}
                placeholder="8.0"
                autoComplete="off"
              />
            </Field>
            <Field label={t('models.form.cacheReadPrice')}>
              <Input
                value={cacheReadPrice}
                onChange={(event) => setCacheReadPrice(event.target.value)}
                disabled={busy}
                placeholder="0.4"
                autoComplete="off"
              />
            </Field>
            <Field label={t('models.form.cacheWritePrice')}>
              <Input
                value={cacheWritePrice}
                onChange={(event) => setCacheWritePrice(event.target.value)}
                disabled={busy}
                placeholder="2.5"
                autoComplete="off"
              />
            </Field>
          </div>
        </details>

        <details className="rounded-md border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t('models.form.param')} ({t('common.optional')})
          </summary>
          <div className="mt-3 grid gap-4 compact:grid-cols-2">
            <Field label={t('models.form.temperature')}>
              <Input
                value={temperature}
                onChange={(event) => setTemperature(event.target.value)}
                disabled={busy}
                placeholder="0.7"
                autoComplete="off"
              />
            </Field>
            <Field label={t('models.form.maxTokens')}>
              <Input
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
                disabled={busy}
                placeholder="8192"
                autoComplete="off"
              />
            </Field>
            <Field label={t('models.form.topP')}>
              <Input
                value={topP}
                onChange={(event) => setTopP(event.target.value)}
                disabled={busy}
                placeholder="0.9"
                autoComplete="off"
              />
            </Field>
            <Field label={t('models.form.promptCache')}>
              <Select
                value={promptCache}
                onChange={(event) => setPromptCache(event.target.value as 'auto' | 'on' | 'off')}
                disabled={busy}
              >
                <option value="auto">{t('models.form.cacheAuto')}</option>
                <option value="on">{t('models.form.cacheOn')}</option>
                <option value="off">{t('models.form.cacheOff')}</option>
              </Select>
            </Field>
          </div>
          <div className="mt-4">
            <Field label={t('models.form.extra')}>
              <textarea
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs"
                rows={3}
                value={extraJson}
                onChange={(event) => setExtraJson(event.target.value)}
                disabled={busy}
                placeholder='{"enable_thinking": true}'
                spellCheck={false}
              />
            </Field>
          </div>
        </details>

        <details className="rounded-md border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t('models.form.info')} ({t('common.optional')})
          </summary>
          <div className="mt-3 grid gap-4 compact:grid-cols-2">
            <Field label={t('models.form.displayName')}>
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                disabled={busy}
                placeholder="Qwen4 Max"
                autoComplete="off"
              />
            </Field>
            <Field label={t('models.form.contextWindow')}>
              <Input
                value={contextWindow}
                onChange={(event) => setContextWindow(event.target.value)}
                disabled={busy}
                placeholder="262144"
                autoComplete="off"
              />
            </Field>
            <Field label={t('models.form.maxOutputTokens')}>
              <Input
                value={maxOutputTokens}
                onChange={(event) => setMaxOutputTokens(event.target.value)}
                disabled={busy}
                placeholder="32768"
                autoComplete="off"
              />
            </Field>
            <Field label={t('models.form.description')}>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={busy}
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <span className="text-sm text-muted">{t('models.form.capabilities')}:</span>
            <label className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={capVision}
                onChange={(event) => setCapVision(event.target.checked)}
                disabled={busy}
              />
              {t('models.form.capVision')}
            </label>
            <label className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={capThinking}
                onChange={(event) => setCapThinking(event.target.checked)}
                disabled={busy}
              />
              {t('models.form.capThinking')}
            </label>
            <label className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={capTools}
                onChange={(event) => setCapTools(event.target.checked)}
                disabled={busy}
              />
              {t('models.form.capTools')}
            </label>
          </div>
          <div className="mt-4">
            <Field label={t('models.form.infoJson')}>
              <textarea
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs"
                rows={3}
                value={infoJson}
                onChange={(event) => setInfoJson(event.target.value)}
                disabled={busy}
                placeholder='{"family": "qwen"}'
                spellCheck={false}
              />
            </Field>
          </div>
        </details>

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
