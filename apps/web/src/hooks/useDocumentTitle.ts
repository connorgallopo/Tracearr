import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { navigation, isNavGroup } from '@/components/layout/nav-data';
import type { NavKey } from '@tracearr/translations';

const APP_NAME = 'Tracearr';

/**
 * Build a flat map of href -> nameKey from navigation data
 */
function buildRouteMap(): Map<string, NavKey> {
  const map = new Map<string, NavKey>();

  for (const entry of navigation) {
    if (isNavGroup(entry)) {
      for (const child of entry.children) {
        map.set(child.href, child.nameKey);
      }
    } else {
      map.set(entry.href, entry.nameKey);
    }
  }

  return map;
}

const routeMap = buildRouteMap();

/**
 * Hook to automatically update the document title based on the current route.
 * Titles are derived from nav-data.ts for consistency.
 */
export function useDocumentTitle() {
  const location = useLocation();
  const { t } = useTranslation(['nav', 'pages']);

  useEffect(() => {
    const pathname = location.pathname;

    if (pathname === '/stats/overview') {
      document.title = `${t('pages:statsOverview.title')} | ${APP_NAME}`;
      return;
    }

    // Check for exact match in navigation
    const navKey = routeMap.get(pathname);
    if (navKey) {
      document.title = `${t(navKey)} | ${APP_NAME}`;
      return;
    }

    // Handle dynamic routes and routes not in nav
    if (pathname.startsWith('/users/')) {
      document.title = `User Details | ${APP_NAME}`;
      return;
    }

    if (pathname.startsWith('/media/')) {
      document.title = `Media Details | ${APP_NAME}`;
      return;
    }

    if (pathname.startsWith('/settings')) {
      document.title = `${t('settings')} | ${APP_NAME}`;
      return;
    }

    // Fallback: derive title from pathname
    const segments = pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    if (lastSegment) {
      const title = lastSegment
        .split('-')
        .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      document.title = `${title} | ${APP_NAME}`;
      return;
    }

    document.title = APP_NAME;
  }, [location.pathname, t]);
}
