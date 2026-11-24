import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';

/** The code a person approves in Silo: 4+4 digits with copy, "Open Silo", where to enter it, and the wait */
export function PairingCode({
  userCode,
  link,
  waiting,
  opened,
  expired,
  onRequestNew,
}: {
  userCode: string;
  link: string;
  waiting: boolean;
  opened: boolean;
  expired: boolean;
  onRequestNew: () => void;
}) {
  const { t } = useTranslation(['settings', 'pages']);
  const digits = userCode.replace(/\D/g, '');
  const shown = `${digits.slice(0, 4)} ${digits.slice(4)}`;
  const linkUrl = new URL(link);
  const enterAt = `${linkUrl.origin}${linkUrl.pathname}`;

  if (expired) {
    return (
      <output className="bg-muted/50 flex flex-col items-center gap-3 rounded-lg p-4 text-center">
        <p className="text-sm font-medium">{t('pages:login.member.codeExpired')}</p>
        <Button type="button" onClick={onRequestNew}>
          {t('settings:servers.pairing.newCode')}
        </Button>
      </output>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <CopyButton
        value={shown}
        label={t('pages:login.member.copyCode')}
        variant="ghost"
        className="h-auto w-full justify-center py-4 font-mono text-3xl tracking-[0.2em] sm:text-4xl"
      >
        {shown}
      </CopyButton>
      <p className="text-muted-foreground text-center text-sm">
        {t('settings:servers.pairing.enterAt', { address: enterAt })}
      </p>
      <Button variant="outline" className="self-center" asChild>
        <a href={link} target="_blank" rel="noreferrer">
          <ExternalLink />
          {t('settings:servers.pairing.openSilo')}
        </a>
      </Button>
      {waiting && (
        <div
          role="status"
          className="bg-muted/50 flex items-center justify-center gap-2 rounded-lg p-4 text-sm"
        >
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          {opened ? t('settings:servers.pairing.opened') : t('pages:login.member.waiting')}
        </div>
      )}
    </div>
  );
}
