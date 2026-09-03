import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DestinationsManager } from '@/components/settings/destinations';
import { useAuth } from '@/hooks/useAuth';

export function Destinations() {
  const { t } = useTranslation('pages');
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          {t('settings.destinations.title')}
        </CardTitle>
        <CardDescription>{t('settings.destinations.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isOwner ? (
          <DestinationsManager />
        ) : (
          <p className="text-muted-foreground text-sm">{t('settings.destinations.ownerOnly')}</p>
        )}
      </CardContent>
    </Card>
  );
}
