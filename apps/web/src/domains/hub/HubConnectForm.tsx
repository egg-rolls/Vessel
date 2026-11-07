/**
 * Hub 连接表单：只收集 Hub URL 与 Hub read token（CONTRACT-0.49 §8）。
 *
 * token 输入不回显已存值；提交成功后只写 `sessionStorage`。
 * Hub 对回环 peer 免 token，因此 token 可留空（远程 Hub 需要）。
 */

import { useState } from 'react';
import { Button, Field, Input, Section } from '../../components/ui';
import type { HubErrorKind } from '../../gateway/platform/hub';
import { t } from '../../i18n';

function errorText(kind: HubErrorKind, origin: string): string {
  switch (kind) {
    case 'invalid_url':
      return t('hub.connect.error.invalid');
    case 'network':
    case 'forbidden':
      return t('hub.connect.error.origin', { origin });
    default:
      return t('hub.connect.error.http');
  }
}

export function HubConnectForm({
  defaultUrl,
  connecting,
  error,
  canClear,
  onSubmit,
  onClear,
}: {
  defaultUrl: string;
  connecting: boolean;
  error: HubErrorKind | null;
  canClear: boolean;
  onSubmit(url: string, token: string): void;
  onClear(): void;
}) {
  // token 草稿永远从空开始：已存 token 不回显，只提示“已保存”。
  const [urlDraft, setUrlDraft] = useState(defaultUrl);
  const [tokenDraft, setTokenDraft] = useState('');
  const origin = window.location.origin;

  const submit = () => {
    if (connecting) return;
    void onSubmit(urlDraft, tokenDraft);
  };

  return (
    <Section title={t('hub.connect.title')} description={t('hub.connect.description')}>
      <div className="flex max-w-xl flex-col gap-3">
        <Field
          label={t('hub.connect.url')}
          htmlFor="hub-url"
          hint={t('hub.connect.urlHint', { origin })}
        >
          <Input
            id="hub-url"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="http://127.0.0.1:8643"
            spellCheck={false}
            autoComplete="off"
            invalid={error === 'invalid_url'}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </Field>

        <Field
          label={t('hub.connect.token')}
          htmlFor="hub-token"
          hint={t('hub.connect.tokenHint')}
          error={error !== null ? <span>{errorText(error, origin)}</span> : undefined}
        >
          <Input
            id="hub-token"
            type="password"
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            placeholder={t('hub.connect.tokenPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={submit} disabled={connecting}>
            {connecting ? t('hub.connect.connecting') : t('hub.connect.submit')}
          </Button>
          {canClear && (
            <Button onClick={onClear} disabled={connecting}>
              {t('hub.connect.clear')}
            </Button>
          )}
        </div>
      </div>
    </Section>
  );
}
