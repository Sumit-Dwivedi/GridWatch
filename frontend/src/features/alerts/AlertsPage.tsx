import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useWebSocket, type WsEvent } from '../../hooks/useWebSocket';
import { StatusBadge, SeverityBadge } from '../../components/StatusBadge';
import { timeAgo } from '../../lib/time';

interface Alert {
  id: number;
  sensor_id: string;
  sensor_name: string;
  sensor_external_key: string;
  zone_id: string;
  zone_name: string;
  status: string;
  severity: string;
  is_suppressed: boolean;
  assigned_user_id: string | null;
  opened_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  escalated_at: string | null;
  anomaly: { type: string; metric: string | null };
}

interface AlertsResponse {
  data: Alert[];
  meta: { limit: number; next_cursor: string | null };
}

const statusTabs = ['open', 'acknowledged', 'resolved'];
const severityTabs = ['all', 'warning', 'critical'];

export function AlertsPage() {
  const { token } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('open');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [error, setError] = useState('');

  const fetchAlerts = useCallback(async (append = false, cursorVal?: string | null) => {
    try {
      let url = '/alerts?limit=50';
      if (statusFilter) url += `&status=${statusFilter}`;
      if (severityFilter !== 'all') url += `&severity=${severityFilter}`;
      if (append && cursorVal) url += `&cursor=${cursorVal}`;
      const res = await api.get<AlertsResponse>(url);
      setAlerts(prev => append ? [...prev, ...res.data] : res.data);
      setCursor(res.meta.next_cursor);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [statusFilter, severityFilter]);

  useEffect(() => {
    setLoading(true);
    setAlerts([]);
    fetchAlerts();
  }, [fetchAlerts]);

  const onEvent = useCallback((event: WsEvent) => {
    if (event.type === 'alert.created' || event.type === 'alert.updated') {
      // Refresh list
      fetchAlerts();
    }
  }, [fetchAlerts]);

  useWebSocket({ token, onEvent });

  const acknowledge = async (alertId: number) => {
    setActionLoading(alertId);
    setError('');
    try {
      await api.post(`/alerts/${alertId}/acknowledge`, { reason: 'Acknowledged from dashboard' });
      setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, status: 'acknowledged' } : a));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(null);
    }
  };

  const resolve = async (alertId: number) => {
    setActionLoading(alertId);
    setError('');
    try {
      await api.post(`/alerts/${alertId}/resolve`, { reason: 'Resolved from dashboard' });
      setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, status: 'resolved' } : a));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Alerts</h2>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm px-3 py-2 rounded">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-6">
        <div className="flex gap-1">
          {statusTabs.map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded text-sm capitalize ${
                statusFilter === s ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {severityTabs.map(s => (
            <button
              key={s}
              onClick={() => setSeverityFilter(s)}
              className={`px-3 py-1.5 rounded text-sm capitalize ${
                severityFilter === s ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Alert table */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-left">
              <th className="px-4 py-3 font-medium">Severity</th>
              <th className="px-4 py-3 font-medium">Sensor</th>
              <th className="px-4 py-3 font-medium">Zone</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Opened</th>
              <th className="px-4 py-3 font-medium">Flags</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                <td className="px-4 py-3"><SeverityBadge severity={a.severity} /></td>
                <td className="px-4 py-3">
                  <div className="text-gray-200">{a.sensor_name}</div>
                  <div className="text-xs text-gray-500 font-mono">{a.sensor_external_key}</div>
                </td>
                <td className="px-4 py-3 text-gray-400">{a.zone_name}</td>
                <td className="px-4 py-3 text-gray-400 text-xs">
                  {a.anomaly.type.replace(/_/g, ' ')}
                  {a.anomaly.metric && <span className="text-gray-500"> ({a.anomaly.metric})</span>}
                </td>
                <td className="px-4 py-3"><StatusBadge status={a.status === 'acknowledged' ? 'warning' : a.status === 'open' ? 'critical' : 'healthy'} /></td>
                <td className="px-4 py-3 text-gray-400 font-mono text-xs">{timeAgo(a.opened_at)}</td>
                <td className="px-4 py-3 space-x-1">
                  {a.is_suppressed && (
                    <span className="text-xs text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded">suppressed</span>
                  )}
                  {a.escalated_at && (
                    <span className="text-xs text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">escalated</span>
                  )}
                </td>
                <td className="px-4 py-3 space-x-2">
                  {a.status === 'open' && (
                    <>
                      <button
                        onClick={() => acknowledge(a.id)}
                        disabled={actionLoading === a.id}
                        className="text-xs bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 px-2 py-1 rounded disabled:opacity-50"
                      >
                        Ack
                      </button>
                      <button
                        onClick={() => resolve(a.id)}
                        disabled={actionLoading === a.id}
                        className="text-xs bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 px-2 py-1 rounded disabled:opacity-50"
                      >
                        Resolve
                      </button>
                    </>
                  )}
                  {a.status === 'acknowledged' && (
                    <button
                      onClick={() => resolve(a.id)}
                      disabled={actionLoading === a.id}
                      className="text-xs bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 px-2 py-1 rounded disabled:opacity-50"
                    >
                      Resolve
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="text-center py-8 text-gray-500">Loading...</div>}
        {!loading && alerts.length === 0 && <div className="text-center py-8 text-gray-500">No alerts found</div>}
      </div>

      {cursor && (
        <button
          onClick={() => fetchAlerts(true, cursor)}
          className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm px-4 py-2 rounded"
        >
          Load more
        </button>
      )}
    </div>
  );
}
