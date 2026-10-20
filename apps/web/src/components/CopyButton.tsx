import { useState } from 'react';
import { useToast } from './ToastProvider';

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // 非安全上下文兜底（P0 不引入依赖）。
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  document.body.removeChild(area);
}

export function CopyButton({
  text,
  label = '复制',
  toast: toastLabel = '已复制',
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
    <button
      type="button"
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
      {copied ? '已复制' : label}
    </button>
  );
}
