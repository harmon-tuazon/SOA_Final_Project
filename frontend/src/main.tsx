import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { loadConfig } from './lib/config';
import { AuthProvider } from './auth/AuthContext';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The backend may not exist yet (see PRD frontend/0001) — don't
      // hammer it with retries when it's unconfigured/unreachable.
      retry: false,
    },
  },
});

// Load runtime config (the API base URL) BEFORE the first render, so every
// component sees a resolved config from mount. loadConfig() never throws —
// it falls back to the shipped default (empty apiBaseUrl) on failure.
await loadConfig();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('#root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
