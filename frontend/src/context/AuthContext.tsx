import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { api, setToken, getToken } from '../lib/api';

interface User {
  userId: string;
  email: string;
  full_name: string;
  role: 'operator' | 'supervisor';
  zoneIds: string[];
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const token = getToken();

  useEffect(() => {
    if (token) {
      api.get<{ data: { id: string; email: string; full_name: string; role: string; zone_ids: string[] } }>('/auth/me')
        .then((res) => {
          const u = res.data;
          setUser({ userId: u.id, email: u.email, full_name: u.full_name, role: u.role as 'operator' | 'supervisor', zoneIds: u.zone_ids || [] });
        })
        .catch(() => {
          setToken(null);
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api.post<{ data: { token: string; user: { id: string; email: string; full_name: string; role: string; zone_ids: string[] } } }>('/auth/login', { email, password });
    setToken(res.data.token);
    const u = res.data.user;
    setUser({ userId: u.id, email: u.email, full_name: u.full_name, role: u.role as 'operator' | 'supervisor', zoneIds: u.zone_ids || [] });
  };

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token: getToken(), isAuthenticated: !!user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
