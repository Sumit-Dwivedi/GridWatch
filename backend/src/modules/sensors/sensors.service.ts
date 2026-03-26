import { pool } from '../../db/client.js';
import { NotFoundError } from '../../shared/errors.js';
import type { ZoneAccessContext } from '../../shared/types.js';

export async function getSensorDetail(ctx: ZoneAccessContext, sensorId: string) {
  // Sensor + zone check
  const sensorParams: unknown[] = [sensorId];
  let zoneClause = '';
  if (ctx.role !== 'supervisor') {
    zoneClause = 'AND s.zone_id = ANY($2)';
    sensorParams.push(ctx.zoneIds);
  }

  const { rows: sensorRows } = await pool.query(
    `SELECT s.id, s.name, s.external_key, s.zone_id, z.name as zone_name,
            s.is_active, s.installed_at
     FROM sensors s
     JOIN zones z ON z.id = s.zone_id
     WHERE s.id = $1 ${zoneClause}`,
    sensorParams
  );

  if (sensorRows.length === 0) throw new NotFoundError('Sensor not found');
  const sensor = sensorRows[0];

  // Parallel: state, active alerts, active suppression
  const [stateResult, alertsResult, suppressionResult] = await Promise.all([
    pool.query(
      `SELECT current_status, last_reading_ts, updated_at
       FROM sensor_state WHERE sensor_id = $1`,
      [sensorId]
    ),
    pool.query(
      `SELECT a.id, a.status, a.severity, a.opened_at, an.anomaly_type, an.metric
       FROM alerts a
       JOIN anomalies an ON an.id = a.anomaly_id
       WHERE a.sensor_id = $1 AND a.status = 'open' AND a.is_suppressed = false
       ORDER BY (CASE WHEN a.severity = 'critical' THEN 0 ELSE 1 END) ASC, a.opened_at DESC
       LIMIT 10`,
      [sensorId]
    ),
    pool.query(
      `SELECT id, start_time, end_time, note
       FROM sensor_suppressions
       WHERE sensor_id = $1 AND start_time <= now() AND end_time > now()
       ORDER BY created_at DESC LIMIT 1`,
      [sensorId]
    ),
  ]);

  const state = stateResult.rows[0];
  const activeSuppression = suppressionResult.rows[0] || null;
  const isSuppressed = activeSuppression !== null;

  return {
    sensor: {
      id: sensor.id,
      name: sensor.name,
      external_key: sensor.external_key,
      zone_id: sensor.zone_id,
      zone_name: sensor.zone_name,
      is_active: sensor.is_active,
      installed_at: sensor.installed_at,
    },
    state: {
      current_status: state?.current_status ?? 'healthy',
      last_reading_ts: state?.last_reading_ts ?? null,
      is_suppressed: isSuppressed,
      active_suppression_id: activeSuppression ? Number(activeSuppression.id) : null,
    },
    active_alerts: alertsResult.rows.map(a => ({
      id: Number(a.id),
      status: a.status,
      severity: a.severity,
      opened_at: a.opened_at,
      anomaly_type: a.anomaly_type,
      metric: a.metric,
    })),
    active_suppression: activeSuppression ? {
      id: Number(activeSuppression.id),
      start_time: activeSuppression.start_time,
      end_time: activeSuppression.end_time,
      note: activeSuppression.note,
    } : null,
  };
}
