import { createBrowserRouter } from 'react-router-dom';
import { Layout } from './Layout';
import { HomePage } from './pages/HomePage';
import { ProductsPage } from './features/products/ProductsPage';
import { ProtectedRoute } from './auth/ProtectedRoute';

// Route registry — register new routes here as { path, element } children.
// To add a page: create src/features/<name>/ (api.ts + a <Name>Page.tsx,
// mirroring src/features/products/), then add one entry below. Wrap with
// <ProtectedRoute> if the page should require auth (currently a stub —
// see src/auth/AuthContext.tsx).
export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      {
        path: 'products',
        element: (
          <ProtectedRoute>
            <ProductsPage />
          </ProtectedRoute>
        ),
      },
      // Register your route here.
    ],
  },
]);
