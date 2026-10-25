import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

const CONFIRMATION_MS = 1500;

/**
 * The textarea mounts inside `host` because a modal dialog's focus trap pulls focus
 * back from anything outside it, which drops the selection before the copy runs.
 */
function copyWithTextarea(value: string, host: HTMLElement): boolean {
  const previous = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  host.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  }
}

/**
 * navigator.clipboard only exists in secure contexts, and Tracearr is often opened
 * over plain HTTP on a LAN address. The textarea path works there.
 */
export async function copyText(
  value: string,
  host: HTMLElement = document.body
): Promise<'copied' | 'manual'> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return 'copied';
    } catch {
      // fall through to the textarea path
    }
  }
  return copyWithTextarea(value, host) ? 'copied' : 'manual';
}

function selectContents(element: HTMLElement) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    element.select();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

type CopyButtonProps = Omit<ComponentProps<typeof Button>, 'value' | 'onClick' | 'children'> & {
  value: string;
  /** Accessible name for the button, e.g. "Copy API key". */
  label: string;
  /** Renders the label beside the icon; off by default, which is the icon-only shape. */
  showLabel?: boolean;
  /** Shown beside the icon in place of the label, for a value that is its own tap target. */
  children?: ReactNode;
  /** Element showing the value; its text is selected when the browser blocks copying. */
  selectTarget?: () => HTMLElement | null;
};

export function CopyButton({
  value,
  label,
  showLabel = false,
  children,
  selectTarget,
  variant = 'outline',
  size = showLabel || children ? 'default' : 'icon',
  ...props
}: CopyButtonProps) {
  const { t } = useTranslation('notifications');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (host?: HTMLElement | null) => {
    if ((await copyText(value, host ?? undefined)) === 'copied') {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), CONFIRMATION_MS);
      return;
    }
    const target = selectTarget?.();
    if (target) selectContents(target);
    toast.error(t('toast.error.copyManual'));
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label={label}
      title={label}
      onClick={(event) => void copy(event.currentTarget.parentElement)}
      {...props}
    >
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {children ?? (showLabel && label)}
    </Button>
  );
}
