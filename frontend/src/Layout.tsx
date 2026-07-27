import { Link, Outlet } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';

/** Shared nav + page shell rendered around every route via <Outlet />. */
export function Layout() {
  const { user } = useAuth();

  return (
    <div className="app">
      <header className="site-header">
        <div className="site-header__inner">
          <Link className="site-header__brand" to="/">
            SOA<span>Store</span> 🛒
          </Link>
          <nav className="site-nav">
            <Link to="/">Home</Link>
            <Link to="/products">Products</Link>
            <Link to="/orders">Your Orders</Link>
          </nav>
          {user && (
            <span className="site-header__user">
              Hello, <strong>{user.name}</strong>
            </span>
          )}
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
