import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2 } from 'lucide-react';
import { SERVER_TYPE_BRAND_COLORS } from '@tracearr/shared';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { Button } from '@/components/ui/button';

// Plex's own sign-in button is gold with dark ink; white on the gold is about 2:1.
const PLEX_BRAND = { backgroundColor: SERVER_TYPE_BRAND_COLORS.plex };

export function PlexSignInButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      className="text-overlay w-full hover:brightness-95"
      style={PLEX_BRAND}
      onClick={onClick}
    >
      <MediaServerIcon type="plex" className="h-4 w-4" />
      {label}
    </Button>
  );
}

export function PlexWaiting({
  authUrl,
  onCancel,
  showCancel = true,
}: {
  authUrl: string | null;
  onCancel: () => void;
  showCancel?: boolean;
}) {
  const { t } = useTranslation(['pages', 'common']);

  return (
    <div className="space-y-4">
      <div className="bg-muted/50 rounded-lg p-4 text-center">
        <Loader2
          className="mx-auto mb-3 h-8 w-8 animate-spin"
          style={{ color: SERVER_TYPE_BRAND_COLORS.plex }}
        />
        <p className="text-sm font-medium">{t('pages:login.waitingForPlex')}</p>
        <p className="text-muted-foreground mt-1 text-xs">{t('pages:login.completeInPopup')}</p>
        {authUrl && (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => window.open(authUrl, '_blank')}
            className="mt-2 h-auto gap-1 p-0"
          >
            <ExternalLink className="h-3 w-3" />
            {t('pages:login.reopenPlexLogin')}
          </Button>
        )}
      </div>
      {showCancel && (
        <Button variant="ghost" className="w-full" onClick={onCancel}>
          {t('common:actions.cancel')}
        </Button>
      )}
    </div>
  );
}
