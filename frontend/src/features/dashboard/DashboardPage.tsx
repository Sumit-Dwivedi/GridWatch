import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useWebSocket, type WsEvent } from '../../hooks/useWebSocket';
import { StatusBadge } from '../../components/StatusBadge';
import { timeAgo } from '../../lib/time';

interface Sensor {
  sensor_id: string;
  sensor_name: string;
  external_key: string;
  zone_id: string;
  zone_name: string;
  current_status: string;
  last_reading_ts: string | null;
  latest_open_alert_id: number | null;
  latest_severity: string | null;
  is_suppressed: boolean;
  updated_at: string;
}

interface Counts {
  healthy: number;
  warning: number;
  critical: number;
  silent: number;
}

interface DashboardResponse {
  data: Sensor[];
  meta: { limit: number; next_cursor: string | null; counts: Counts };
}

const statusCards: { key: keyof Counts; label: string; color: string }[] = [
  { key: 'healthy', label: 'Healthy', color: 'border-emerald-500/30 text-emerald-400' },
  { key: 'warning', label: 'Warning', color: 'border-amber-500/30 text-amber-400' },
  { key: 'critical', label: 'Critical', color: 'border-red-500/30 text-red-400' },
  { key: 'silent', label: 'Silent', color: 'border-gray-500/30 text-gray-400' },
];

export function DashboardPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [counts, setCounts] = useState<Counts>({ healthy: 0, warning: 0, critical: 0, silent: 0 });
  const [cursor, setCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchSensors = useCallback(async (append = false, cursorVal?: string | null) => {
    try {
      let url = '/dashboard/sensors?limit=50';
      if (statusFilter) url += `&status=${statusFilter}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (append && cursorVal) url += `&cursor=${cursorVal}`;
      const res = await api.get<DashboardResponse>(url);
      setSensors(prev => append ? [...prev, ...res.data] : res.data);
      setCounts(res.meta.counts);
      setCursor(res.meta.next_cursor);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [statusFilter, search]);

  useEffect(() => {
    setLoading(true);
    setSensors([]);
    fetchSensors();
  }, [fetchSensors]);

  const onEvent = useCallback((event: WsEvent) => {
    if (event.type === 'sensor.state.changed') {
      const d = event.data;
      setSensors(prev => prev.map(s =>
        s.sensor_id === d.sensor_id
          ? { ...s, current_status: d.current_status as string, updated_at: d.updated_at as string }
          : s
      ));
      // Refresh counts
      fetchSensors();
    }
  }, [fetchSensors]);

  const { connected } = useWebSocket({ token, onEvent });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Dashboard</h2>
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
          <span className="text-xs text-gray-500">{connected ? 'Live' : 'Disconnected'}</span>
          {user?.role === 'supervisor' && (
            <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">All Zones</span>
          )}
        </div>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-4 gap-4">
        {statusCards.map(({ key, label, color }) => (
          <button
            key={key}
            onClick={() => setStatusFilter(statusFilter === key ? null : key)}
            className={`bg-gray-900 border rounded-lg p-4 text-left transition-colors ${
              statusFilter === key ? color + ' border-2' : 'border-gray-800 hover:border-gray-700'
            }`}
          >
            <div className={`text-2xl font-bold font-mono ${statusFilter === key ? '' : 'text-gray-100'}`}>
              {counts[key]}
            </div>
            <div className="text-sm text-gray-500">{label}</div>
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search sensors..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
      />

      {/* Sensor table */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-left">
              <th className="px-4 py-3 font-medium">Sensor</th>
              <th className="px-4 py-3 font-medium">Zone</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Last Reading</th>
              <th className="px-4 py-3 font-medium">Alert</th>
              <th className="px-4 py-3 font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {sensors.map((s) => (
              <tr
                key={s.sensor_id}
                onClick={() => navigate(`/sensors/${s.sensor_id}`)}
                className="border-b border-gray-800/50 hover:bg-gray-800/50 cursor-pointer"
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-200">{s.sensor_name}</div>
                  <div className="text-xs text-gray-500 font-mono">{s.external_key}</div>
                </td>
                <td className="px-4 py-3 text-gray-400">{s.zone_name}</td>
                <td className="px-4 py-3"><StatusBadge status={s.current_status} /></td>
                <td className="px-4 py-3 text-gray-400 font-mono text-xs">{timeAgo(s.last_reading_ts)}</td>
                <td className="px-4 py-3">
                  {s.latest_severity && <StatusBadge status={s.latest_severity} />}
                </td>
                <td className="px-4 py-3">
                  {s.is_suppressed && (
                    <span className="text-xs text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">suppressed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="text-center py-8 text-gray-500">Loading...</div>}
        {!loading && sensors.length === 0 && <div className="text-center py-8 text-gray-500">No sensors found</div>}
      </div>

      {cursor && (
        <button
          onClick={() => fetchSensors(true, cursor)}
          className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm px-4 py-2 rounded"
        >
          Load more
        </button>
      )}
    </div>
  );
}
