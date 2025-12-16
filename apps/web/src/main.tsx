import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { AuthProvider } from '@/hooks/useAuth';
import { ServerProvider } from '@/hooks/useServer';
import { SocketProvider } from '@/hooks/useSocket';
import { ThemeProvider } from '@/components/theme-provider';
import { App } from './App';
import './styles/globals.css';

// Get base path from Vite's import.meta.env (set via vite.config.ts)
const BASE_PATH = import.meta.env.BASE_URL || '/';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      // Retry failed queries with exponential backoff
      retry: 3,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
      // Auto-refetch when reconnecting or window regains focus
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="tracearr-theme">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={BASE_PATH}>
          <AuthProvider>
            <ServerProvider>
              <SocketProvider>
                <App />
              </SocketProvider>
            </ServerProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
);
