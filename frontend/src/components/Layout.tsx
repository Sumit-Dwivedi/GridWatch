import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <h1 className="text-lg font-bold tracking-wide text-gray-100">
            <span className="text-emerald-400">Grid</span>Watch
          </h1>
          <nav className="flex gap-1">
            <NavLink
              to="/dashboard"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-sm ${isActive ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`
              }
            >
              Dashboard
            </NavLink>
            <NavLink
              to="/alerts"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-sm ${isActive ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`
              }
            >
              Alerts
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-sm">
            <div className="text-gray-300">{user?.full_name}</div>
            <div className="text-xs text-gray-500">
              <span className={`${user?.role === 'supervisor' ? 'text-blue-400' : 'text-gray-400'}`}>
                {user?.role}
              </span>
            </div>
          </div>
          <button
            onClick={logout}
            className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-800"
          >
            Logout
          </button>
        </div>
      </header>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
