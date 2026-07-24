import { Link, useNavigate, Outlet } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';

/** Shared nav + page shell rendered around every route via <Outlet />. */
export function Layout() {
  const { isAuthenticated, user, logout } = useAuth();
  const navigate = useNavigate();

  function handleSignOut() {
    logout();
    navigate('/');
  }

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
            {isAuthenticated && (
              <>
                <Link to="/profile">Profile</Link>
                <Link to="/billing">Billing</Link>
              </>
            )}
          </nav>
          {isAuthenticated && user ? (
            <span className="site-header__user">
              Signed in as <strong>{user.email}</strong>{' '}
              <button type="button" onClick={handleSignOut}>
                Sign out
              </button>
            </span>
          ) : (
            <span className="site-header__user">
              <Link to="/login">Sign in</Link>
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
