import { createBrowserRouter } from 'react-router-dom';
import { Layout } from './Layout';
import { HomePage } from './pages/HomePage';
import { ProductsPage } from './features/products/ProductsPage';
import { ProductDetailPage } from './features/products/ProductDetailPage';
import { OrdersPage } from './features/orders/OrdersPage';
import { NewOrderPage } from './features/orders/NewOrderPage';
import { OrderDetailPage } from './features/orders/OrderDetailPage';
import { ProfilePage } from './features/users/ProfilePage';
import { BillingPage } from './features/users/BillingPage';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { LoginPage } from './auth/LoginPage';
import { RegisterPage } from './auth/RegisterPage';
import { ConfirmPage } from './auth/ConfirmPage';

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
      {
        path: 'products/:id',
        element: (
          <ProtectedRoute>
            <ProductDetailPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'orders',
        element: (
          <ProtectedRoute>
            <OrdersPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'orders/new',
        element: (
          <ProtectedRoute>
            <NewOrderPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'orders/:id',
        element: (
          <ProtectedRoute>
            <OrderDetailPage />
          </ProtectedRoute>
        ),
      },
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      { path: 'confirm', element: <ConfirmPage /> },
      {
        path: 'profile',
        element: (
          <ProtectedRoute>
            <ProfilePage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'billing',
        element: (
          <ProtectedRoute>
            <BillingPage />
          </ProtectedRoute>
        ),
      },
      // Register your route here.
    ],
  },
]);
