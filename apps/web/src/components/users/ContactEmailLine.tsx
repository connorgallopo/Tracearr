import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ContactEmailLineProps {
  contactEmail: string | null;
  isOwner: boolean;
  onEdit: () => void;
}

/** The newsletter address under the username line, with the owner-only edit pencil. */
export function ContactEmailLine({ contactEmail, isOwner, onEdit }: ContactEmailLineProps) {
  const { t } = useTranslation('pages');

  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
      <span>
        {t('userDetail.contactEmailLabel')} {contactEmail ?? t('userDetail.contactEmailNone')}
      </span>
      {isOwner && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('userDetail.editIdentity')}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      )}
      <span className="text-xs">{t('userDetail.contactEmailNoLogin')}</span>
    </p>
  );
}
