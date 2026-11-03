import { useState } from 'react';
import { t } from '../i18n';
import { useToast } from './ToastProvider';
import { Tooltip } from './Tooltip';
import { Button } from './ui';
import { copyText } from './ui/clipboard';

export function CopyButton({
  text,
  label = t('common.copy'),
  toast: toastLabel = t('common.copied'),
  className = 'link-btn',
}: {
  text: string;
  label?: string;
  toast?: string;
  className?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  return (
    <Tooltip label={label}>
      <Button
        variant="link"
        className={className}
        aria-label={label}
        onClick={() => {
          void copyText(text)
            .then(() => {
              setCopied(true);
              toast.success(toastLabel);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch((error: unknown) => {
              toast.error(error instanceof Error ? error.message : String(error));
            });
        }}
      >
        {copied ? t('common.copied') : label}
      </Button>
    </Tooltip>
  );
}
