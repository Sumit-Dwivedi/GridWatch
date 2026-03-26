import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useWebSocket, type WsEvent } from '../../hooks/useWebSocket';
import { StatusBadge, SeverityBadge } from '../../components/StatusBadge';
import { timeAgo } from '../../lib/time';

interface SensorDetail {
  sensor: {
    id: string;
    name: string;
    external_key: string;
    zone_id: string;
    zone_name: string;
    is_active: boolean;
    installed_at: string | null;
  };
  state: {
    current_status: string;
    last_reading_ts: string | null;
    is_suppressed: boolean;
    active_suppression_id: number | null;
  };
  active_alerts: {
    id: number;
    status: string;
    severity: string;
    opened_at: string;
    anomaly_type: string;
    metric: string | null;
  }[];
  active_suppression: {
    id: number;
    start_time: string;
    end_time: string;
    note: string | null;
  } | null;
}

interface Reading {
  reading_id: number;
  timestamp: string;
  voltage: number;
  current: number;
  temperature: number;
  status_code: string;
  anomalies: { anomaly_type: string; metric: string; severity: string }[];
}

interface Suppression {
  id: number;
  start_time: string;
  end_time: string;
  note: string | null;
  is_active: boolean;
  created_at: string;
}

export function SensorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { token } = useAuth();
  const [detail, setDetail] = useState<SensorDetail | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Suppression form
  const [showSuppForm, setShowSuppForm] = useState(false);
  const [suppStart, setSuppStart] = useState('');
  const [suppEnd, setSuppEnd] = useState('');
  const [suppNote, setSuppNote] = useState('');
  const [suppLoading, setSuppLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!id) return;
    try {
      const now = new Date().toISOString();
      const hourAgo = new Date(Date.now() - 3600000).toISOString();

      const [detailRes, historyRes, suppRes] = await Promise.all([
        api.get<{ data: SensorDetail }>(`/sensors/${id}`),
        api.get<{ data: Reading[] }>(`/sensors/${id}/history?from=${hourAgo}&to=${now}&limit=50`),
        api.get<{ data: Suppression[] }>(`/sensors/${id}/suppressions`),
      ]);

      setDetail(detailRes.data);
      setReadings(historyRes.data);
      setSuppressions(suppRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sensor');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const onEvent = useCallback((event: WsEvent) => {
    if (event.data.sensor_id === id) {
      if (event.type === 'sensor.state.changed') {
        setDetail(prev => prev ? {
          ...prev,
          state: { ...prev.state, current_status: event.data.current_status as string }
        } : prev);
      } else if (event.type === 'alert.created') {
        fetchAll();
      }
    }
  }, [id, fetchAll]);

  useWebSocket({ token, onEvent });

  const createSuppression = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuppLoading(true);
    try {
      await api.post(`/sensors/${id}/suppressions`, {
        start_time: new Date(suppStart).toISOString(),
        end_time: new Date(suppEnd).toISOString(),
        note: suppNote || undefined,
      });
      setShowSuppForm(false);
      setSuppStart(''); setSuppEnd(''); setSuppNote('');
      fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create suppression');
    } finally {
      setSuppLoading(false);
    }
  };

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (error && !detail) return <div className="text-center py-12 text-red-400">{error}</div>;
  if (!detail) return <div className="text-center py-12 text-gray-500">Sensor not found</div>;

  const { sensor, state, active_alerts, active_suppression } = detail;

  return (
    <div className="space-y-6">
      <Link to="/dashboard" className="text-sm text-gray-500 hover:text-gray-300">&larr; Dashboard</Link>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-100">{sensor.name}</h2>
          <div className="text-sm text-gray-500 font-mono">{sensor.external_key}</div>
          <div className="text-sm text-gray-500 mt-1">{sensor.zone_name}</div>
        </div>
        <StatusBadge status={state.current_status} />
      </div>

      {/* State card */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Status</div>
          <StatusBadge status={state.current_status} />
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Last Reading</div>
          <div className="font-mono text-sm text-gray-300">{timeAgo(state.last_reading_ts)}</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Suppressed</div>
          <div className="text-sm">
            {state.is_suppressed
              ? <span className="text-purple-400">Yes</span>
              : <span className="text-gray-400">No</span>}
          </div>
        </div>
      </div>

      {/* Active suppression */}
      {active_suppression && (
        <div className="bg-purple-500/5 border border-purple-500/20 rounded-lg p-4">
          <div className="text-sm font-medium text-purple-400 mb-1">Active Suppression</div>
          <div className="text-xs text-gray-400">
            {new Date(active_suppression.start_time).toLocaleString()} — {new Date(active_suppression.end_time).toLocaleString()}
          </div>
          {active_suppression.note && <div className="text-xs text-gray-500 mt-1">{active_suppression.note}</div>}
        </div>
      )}

      {/* Active alerts */}
      <div>
        <h3 className="text-sm font-medium text-gray-400 mb-3">Active Alerts ({active_alerts.length})</h3>
        {active_alerts.length === 0 ? (
          <div className="text-sm text-gray-500">No active alerts</div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-left">
                  <th className="px-4 py-2 font-medium">Severity</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Metric</th>
                  <th className="px-4 py-2 font-medium">Opened</th>
                </tr>
              </thead>
              <tbody>
                {active_alerts.map(a => (
                  <tr key={a.id} className="border-b border-gray-800/50">
                    <td className="px-4 py-2"><SeverityBadge severity={a.severity} /></td>
                    <td className="px-4 py-2 text-gray-400">{a.anomaly_type.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-2 text-gray-400">{a.metric || '—'}</td>
                    <td className="px-4 py-2 text-gray-400 font-mono text-xs">{timeAgo(a.opened_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent readings */}
      <div>
        <h3 className="text-sm font-medium text-gray-400 mb-3">Recent Readings (last hour)</h3>
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-left">
                <th className="px-4 py-2 font-medium">Timestamp</th>
                <th className="px-4 py-2 font-medium text-right">Voltage</th>
                <th className="px-4 py-2 font-medium text-right">Current</th>
                <th className="px-4 py-2 font-medium text-right">Temp</th>
                <th className="px-4 py-2 font-medium">Anomalies</th>
              </tr>
            </thead>
            <tbody>
              {readings.map(r => (
                <tr key={r.reading_id} className={`border-b border-gray-800/50 ${r.anomalies.length > 0 ? 'bg-red-500/5' : ''}`}>
                  <td className="px-4 py-2 font-mono text-xs text-gray-400">{new Date(r.timestamp).toLocaleTimeString()}</td>
                  <td className="px-4 py-2 font-mono text-xs text-right text-gray-300">{r.voltage.toFixed(1)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-right text-gray-300">{r.current.toFixed(1)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-right text-gray-300">{r.temperature.toFixed(1)}</td>
                  <td className="px-4 py-2">
                    {r.anomalies.map((a, i) => (
                      <SeverityBadge key={i} severity={a.severity} />
                    ))}
                  </td>
                </tr>
              ))}
              {readings.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-4 text-center text-gray-500">No readings in last hour</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Suppressions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-400">Suppressions</h3>
          <button
            onClick={() => setShowSuppForm(!showSuppForm)}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded"
          >
            {showSuppForm ? 'Cancel' : 'Create Suppression'}
          </button>
        </div>

        {showSuppForm && (
          <form onSubmit={createSuppression} className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Start</label>
                <input
                  type="datetime-local"
                  value={suppStart}
                  onChange={e => setSuppStart(e.target.value)}
                  required
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">End</label>
                <input
                  type="datetime-local"
                  value={suppEnd}
                  onChange={e => setSuppEnd(e.target.value)}
                  required
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Note (optional)</label>
              <input
                type="text"
                value={suppNote}
                onChange={e => setSuppNote(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                placeholder="Planned maintenance"
              />
            </div>
            <button
              type="submit"
              disabled={suppLoading}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded"
            >
              {suppLoading ? 'Creating...' : 'Create'}
            </button>
          </form>
        )}

        {suppressions.length > 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-left">
                  <th className="px-4 py-2 font-medium">Start</th>
                  <th className="px-4 py-2 font-medium">End</th>
                  <th className="px-4 py-2 font-medium">Note</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {suppressions.map(s => (
                  <tr key={s.id} className="border-b border-gray-800/50">
                    <td className="px-4 py-2 font-mono text-xs text-gray-400">{new Date(s.start_time).toLocaleString()}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-400">{new Date(s.end_time).toLocaleString()}</td>
                    <td className="px-4 py-2 text-gray-400">{s.note || '—'}</td>
                    <td className="px-4 py-2">
                      {s.is_active
                        ? <span className="text-xs text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">active</span>
                        : <span className="text-xs text-gray-500">expired</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-sm text-gray-500">No suppressions</div>
        )}
      </div>
    </div>
  );
}
