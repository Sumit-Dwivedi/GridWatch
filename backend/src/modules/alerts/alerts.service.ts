import { pool } from '../../db/client.js';
import { NotFoundError, ConflictError } from '../../shared/errors.js';
import type { ZoneAccessContext } from '../../shared/types.js';
import type { PoolClient } from 'pg';

// --- Cursor helpers ---

function encodeCursor(openedAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ ts: openedAt, id })).toString('base64url');
}

function decodeCursor(cursor: string): { ts: string; id: number } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

// --- Zone filtering helpers ---

interface ZoneFilter {
  clause: string;
  params: unknown[];
  paramOffset: number;
}

function buildZoneFilter(ctx: ZoneAccessContext, requestedZoneId?: string, startParam: number = 1): ZoneFilter {
  const params: unknown[] = [];
  let clause = '';

  if (ctx.role === 'supervisor') {
    if (requestedZoneId) {
      clause = `AND a.zone_id = $${startParam}`;
      params.push(requestedZoneId);
    }
  } else {
    // Operator: always constrain to their zones
    clause = `AND a.zone_id = ANY($${startParam})`;
    if (requestedZoneId && ctx.zoneIds.includes(requestedZoneId)) {
      params.push([requestedZoneId]); // intersect: only the requested zone
    } else {
      params.push(ctx.zoneIds);
    }
  }

  return { clause, params, paramOffset: startParam + params.length };
}

// --- List alerts ---

interface ListAlertsParams {
  status?: string;
  severity?: string;
  zone_id?: string;
  sensor_id?: string;
  is_suppressed?: string;
  limit?: number;
  cursor?: string;
}

export async function listAlerts(ctx: ZoneAccessContext, params: ListAlertsParams) {
  const limit = Math.min(Math.max(params.limit || 100, 1), 500);

  const queryParams: unknown[] = [];
  const conditions: string[] = [];
  let paramIdx = 1;

  // Zone filtering
  const zf = buildZoneFilter(ctx, params.zone_id, paramIdx);
  if (zf.clause) conditions.push(zf.clause.replace('AND ', ''));
  queryParams.push(...zf.params);
  paramIdx = zf.paramOffset;

  // Optional filters
  if (params.status) {
    conditions.push(`a.status = $${paramIdx}`);
    queryParams.push(params.status);
    paramIdx++;
  }
  if (params.severity) {
    conditions.push(`a.severity = $${paramIdx}`);
    queryParams.push(params.severity);
    paramIdx++;
  }
  if (params.sensor_id) {
    conditions.push(`a.sensor_id = $${paramIdx}`);
    queryParams.push(params.sensor_id);
    paramIdx++;
  }
  if (params.is_suppressed !== undefined) {
    conditions.push(`a.is_suppressed = $${paramIdx}`);
    queryParams.push(params.is_suppressed === 'true');
    paramIdx++;
  }

  // Cursor
  if (params.cursor) {
    const { ts, id } = decodeCursor(params.cursor);
    conditions.push(`(a.opened_at, a.id) < ($${paramIdx}, $${paramIdx + 1})`);
    queryParams.push(ts, id);
    paramIdx += 2;
  }

  // Limit
  queryParams.push(limit);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(`
    SELECT
      a.id, a.sensor_id, a.zone_id, a.status, a.severity,
      a.is_suppressed, a.assigned_user_id, a.opened_at,
      a.acknowledged_at, a.resolved_at, a.escalated_at,
      s.name as sensor_name, s.external_key as sensor_external_key,
      z.name as zone_name,
      an.anomaly_type, an.metric
    FROM alerts a
    JOIN sensors s ON s.id = a.sensor_id
    JOIN zones z ON z.id = a.zone_id
    JOIN anomalies an ON an.id = a.anomaly_id
    ${whereClause}
    ORDER BY a.opened_at DESC, a.id DESC
    LIMIT $${paramIdx}
  `, queryParams);

  const data = rows.map(r => ({
    id: Number(r.id),
    sensor_id: r.sensor_id,
    sensor_name: r.sensor_name,
    sensor_external_key: r.sensor_external_key,
    zone_id: r.zone_id,
    zone_name: r.zone_name,
    status: r.status,
    severity: r.severity,
    is_suppressed: r.is_suppressed,
    assigned_user_id: r.assigned_user_id,
    opened_at: r.opened_at,
    acknowledged_at: r.acknowledged_at,
    resolved_at: r.resolved_at,
    escalated_at: r.escalated_at,
    anomaly: {
      type: r.anomaly_type,
      metric: r.metric,
    },
  }));

  const next_cursor = rows.length === limit
    ? encodeCursor(rows[rows.length - 1].opened_at, Number(rows[rows.length - 1].id))
    : null;

  return { data, meta: { limit, next_cursor } };
}

// --- Get alert detail ---

export async function getAlert(ctx: ZoneAccessContext, alertId: number) {
  const params: unknown[] = [alertId];
  let zoneClause = '';

  if (ctx.role !== 'supervisor') {
    zoneClause = 'AND a.zone_id = ANY($2)';
    params.push(ctx.zoneIds);
  }

  const { rows } = await pool.query(`
    SELECT
      a.id, a.sensor_id, a.zone_id, a.status, a.severity,
      a.is_suppressed, a.assigned_user_id, a.opened_at,
      a.acknowledged_at, a.resolved_at, a.escalated_at,
      s.name as sensor_name, s.external_key as sensor_external_key,
      z.name as zone_name,
      an.id as anomaly_id, an.anomaly_type, an.metric,
      an.severity as anomaly_severity, an.details as anomaly_details,
      an.detected_at as anomaly_detected_at
    FROM alerts a
    JOIN sensors s ON s.id = a.sensor_id
    JOIN zones z ON z.id = a.zone_id
    JOIN anomalies an ON an.id = a.anomaly_id
    WHERE a.id = $1 ${zoneClause}
  `, params);

  if (rows.length === 0) {
    throw new NotFoundError('Alert not found');
  }

  const r = rows[0];

  // Fetch transitions
  const { rows: transitions } = await pool.query(`
    SELECT id, from_status, to_status, changed_by_user_id, reason, changed_at
    FROM alert_transitions
    WHERE alert_id = $1
    ORDER BY changed_at ASC, id ASC
  `, [alertId]);

  return {
    id: Number(r.id),
    sensor_id: r.sensor_id,
    sensor_name: r.sensor_name,
    sensor_external_key: r.sensor_external_key,
    zone_id: r.zone_id,
    zone_name: r.zone_name,
    status: r.status,
    severity: r.severity,
    is_suppressed: r.is_suppressed,
    assigned_user_id: r.assigned_user_id,
    opened_at: r.opened_at,
    acknowledged_at: r.acknowledged_at,
    resolved_at: r.resolved_at,
    escalated_at: r.escalated_at,
    anomaly: {
      id: Number(r.anomaly_id),
      type: r.anomaly_type,
      metric: r.metric,
      severity: r.anomaly_severity,
      details: r.anomaly_details,
      detected_at: r.anomaly_detected_at,
    },
    transitions: transitions.map(t => ({
      id: Number(t.id),
      from_status: t.from_status,
      to_status: t.to_status,
      changed_by_user_id: t.changed_by_user_id,
      reason: t.reason,
      changed_at: t.changed_at,
    })),
  };
}

// --- Acknowledge alert ---

export async function acknowledgeAlert(ctx: ZoneAccessContext, alertId: number, reason?: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Zone check
    const checkParams: unknown[] = [alertId];
    let zoneClause = '';
    if (ctx.role !== 'supervisor') {
      zoneClause = 'AND zone_id = ANY($2)';
      checkParams.push(ctx.zoneIds);
    }

    const { rows: existing } = await client.query(
      `SELECT id, status, sensor_id, zone_id, severity FROM alerts WHERE id = $1 ${zoneClause}`,
      checkParams
    );
    if (existing.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Alert not found');
    }

    const alert = existing[0];
    if (alert.status !== 'open') {
      await client.query('ROLLBACK');
      throw new ConflictError(
        `Cannot acknowledge alert: current status is '${alert.status}', expected 'open'`
      );
    }

    // Atomic update
    const { rows: updated } = await client.query(
      `UPDATE alerts
       SET status = 'acknowledged', acknowledged_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'open'
       RETURNING id, status, severity, acknowledged_at`,
      [alertId]
    );

    if (updated.length === 0) {
      await client.query('ROLLBACK');
      throw new ConflictError(
        `Cannot acknowledge alert: current status is '${alert.status}', expected 'open'`
      );
    }

    // Append transition
    const effectiveReason = reason || 'Acknowledged by operator';
    await client.query(
      `INSERT INTO alert_transitions (alert_id, from_status, to_status, changed_by_user_id, reason, changed_at)
       VALUES ($1, 'open', 'acknowledged', $2, $3, now())`,
      [alertId, ctx.userId, effectiveReason]
    );

    // Recompute sensor state
    await recomputeSensorState(client, alert.sensor_id, alert.zone_id);

    // Event outbox: alert.updated
    await client.query(
      `INSERT INTO event_outbox (topic, zone_id, aggregate_type, aggregate_id, payload, created_at)
       VALUES ('alert.updated', $1, 'alert', $2::text, $3, now())`,
      [alert.zone_id, alertId, JSON.stringify({
        type: 'alert.updated',
        data: {
          alert_id: Number(alertId),
          zone_id: alert.zone_id,
          status: 'acknowledged',
          severity: alert.severity,
          acknowledged_at: updated[0].acknowledged_at,
        },
      })]
    );

    await client.query('COMMIT');

    return {
      id: Number(updated[0].id),
      status: updated[0].status,
      severity: updated[0].severity,
      acknowledged_at: updated[0].acknowledged_at,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// --- Resolve alert ---

export async function resolveAlert(ctx: ZoneAccessContext, alertId: number, reason?: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Zone check
    const checkParams: unknown[] = [alertId];
    let zoneClause = '';
    if (ctx.role !== 'supervisor') {
      zoneClause = 'AND zone_id = ANY($2)';
      checkParams.push(ctx.zoneIds);
    }

    const { rows: existing } = await client.query(
      `SELECT id, status, sensor_id, zone_id, severity FROM alerts WHERE id = $1 ${zoneClause}`,
      checkParams
    );
    if (existing.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Alert not found');
    }

    const alert = existing[0];
    if (alert.status === 'resolved') {
      await client.query('ROLLBACK');
      throw new ConflictError('Cannot resolve alert: already resolved');
    }

    const previousStatus = alert.status;

    // Atomic update
    const { rows: updated } = await client.query(
      `UPDATE alerts
       SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('open', 'acknowledged')
       RETURNING id, status, severity, resolved_at`,
      [alertId]
    );

    if (updated.length === 0) {
      await client.query('ROLLBACK');
      throw new ConflictError('Cannot resolve alert: already resolved');
    }

    // Append transition
    const effectiveReason = reason || 'Resolved by operator';
    await client.query(
      `INSERT INTO alert_transitions (alert_id, from_status, to_status, changed_by_user_id, reason, changed_at)
       VALUES ($1, $2, 'resolved', $3, $4, now())`,
      [alertId, previousStatus, ctx.userId, effectiveReason]
    );

    // Recompute sensor state
    await recomputeSensorState(client, alert.sensor_id, alert.zone_id);

    // Event outbox: alert.updated
    await client.query(
      `INSERT INTO event_outbox (topic, zone_id, aggregate_type, aggregate_id, payload, created_at)
       VALUES ('alert.updated', $1, 'alert', $2::text, $3, now())`,
      [alert.zone_id, alertId, JSON.stringify({
        type: 'alert.updated',
        data: {
          alert_id: Number(alertId),
          zone_id: alert.zone_id,
          status: 'resolved',
          severity: alert.severity,
          resolved_at: updated[0].resolved_at,
        },
      })]
    );

    await client.query('COMMIT');

    return {
      id: Number(updated[0].id),
      status: updated[0].status,
      severity: updated[0].severity,
      resolved_at: updated[0].resolved_at,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// --- Recompute sensor state ---
// Excludes suppressed, pattern_absence, and non-open alerts

async function recomputeSensorState(client: PoolClient, sensorId: string, zoneId: string) {
  // Get old status
  const { rows: [oldState] } = await client.query(
    `SELECT current_status FROM sensor_state WHERE sensor_id = $1`,
    [sensorId]
  );
  const oldStatus = oldState?.current_status ?? 'healthy';

  // Compute new status
  const { rows: [statusRow] } = await client.query(
    `SELECT
      CASE
        WHEN EXISTS (
          SELECT 1 FROM alerts a
          JOIN anomalies an ON an.id = a.anomaly_id
          WHERE a.sensor_id = $1 AND a.status = 'open' AND a.severity = 'critical'
            AND a.is_suppressed = false AND an.anomaly_type != 'pattern_absence'
        ) THEN 'critical'
        WHEN EXISTS (
          SELECT 1 FROM alerts a
          JOIN anomalies an ON an.id = a.anomaly_id
          WHERE a.sensor_id = $1 AND a.status = 'open' AND a.severity = 'warning'
            AND a.is_suppressed = false AND an.anomaly_type != 'pattern_absence'
        ) THEN 'warning'
        ELSE 'healthy'
      END as new_status`,
    [sensorId]
  );
  const newStatus = statusRow.new_status;

  await client.query(
    `UPDATE sensor_state
     SET current_status = $1,
         latest_open_alert_id = (
           SELECT a.id FROM alerts a
           JOIN anomalies an ON an.id = a.anomaly_id
           WHERE a.sensor_id = $2 AND a.status = 'open' AND a.is_suppressed = false
             AND an.anomaly_type != 'pattern_absence'
           ORDER BY (CASE WHEN a.severity = 'critical' THEN 0 ELSE 1 END), a.opened_at DESC
           LIMIT 1
         ),
         latest_severity = CASE WHEN $1 IN ('warning', 'critical') THEN $1 ELSE NULL END,
         updated_at = now()
     WHERE sensor_id = $2`,
    [newStatus, sensorId]
  );

  // Emit state change event if status changed
  if (newStatus !== oldStatus) {
    await client.query(
      `INSERT INTO event_outbox (topic, zone_id, aggregate_type, aggregate_id, payload, created_at)
       VALUES ('sensor.state.changed', $1, 'sensor', $2::text, $3, now())`,
      [zoneId, sensorId, JSON.stringify({
        type: 'sensor.state.changed',
        data: {
          sensor_id: sensorId,
          zone_id: zoneId,
          previous_status: oldStatus,
          current_status: newStatus,
          updated_at: new Date().toISOString(),
        },
      })]
    );
  }
}
