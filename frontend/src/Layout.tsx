import { Link, Outlet } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';

/** Shared nav + page shell rendered around every route via <Outlet />. */
export function Layout() {
  const { user } = useAuth();

  return (
    <div>
      <header>
        <nav>
          <Link to="/">Home</Link> | <Link to="/products">Products</Link> |{' '}
          <Link to="/orders">Your Orders</Link>
        </nav>
        {user && <span> Signed in as {user.name}</span>}
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
