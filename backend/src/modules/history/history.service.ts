import { pool } from '../../db/client.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import type { ZoneAccessContext } from '../../shared/types.js';

function encodeCursor(ts: string, id: number): string {
  return Buffer.from(JSON.stringify({ ts, id })).toString('base64url');
}

function decodeCursor(cursor: string): { ts: string; id: number } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

async function getSensorWithZoneCheck(ctx: ZoneAccessContext, sensorId: string) {
  const params: unknown[] = [sensorId];
  let zoneClause = '';
  if (ctx.role !== 'supervisor') {
    zoneClause = 'AND s.zone_id = ANY($2)';
    params.push(ctx.zoneIds);
  }
  const { rows } = await pool.query(
    `SELECT s.id FROM sensors s WHERE s.id = $1 ${zoneClause}`,
    params
  );
  if (rows.length === 0) throw new NotFoundError('Sensor not found');
  return rows[0];
}

interface HistoryParams {
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export async function getSensorHistory(ctx: ZoneAccessContext, sensorId: string, params: HistoryParams) {
  await getSensorWithZoneCheck(ctx, sensorId);

  if (!params.from || !params.to) {
    throw new ValidationError('from and to query parameters are required');
  }

  const fromDate = new Date(params.from);
  const toDate = new Date(params.to);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    throw new ValidationError('Invalid datetime format for from/to');
  }

  const limit = Math.min(Math.max(params.limit || 100, 1), 500);

  const queryParams: unknown[] = [sensorId, params.from, params.to];
  let cursorClause = '';
  let paramIdx = 4;

  if (params.cursor) {
    const { ts, id } = decodeCursor(params.cursor);
    cursorClause = `AND (sr.reading_ts, sr.id) < ($${paramIdx}, $${paramIdx + 1})`;
    queryParams.push(ts, id);
    paramIdx += 2;
  }

  queryParams.push(limit);

  const { rows } = await pool.query(`
    SELECT
      sr.id as reading_id,
      sr.reading_ts as timestamp,
      sr.voltage,
      sr.current_val as current,
      sr.temperature,
      sr.status_code,
      COALESCE(
        json_agg(
          json_build_object(
            'anomaly_id', a.id,
            'anomaly_type', a.anomaly_type,
            'metric', a.metric,
            'severity', a.severity,
            'detected_at', a.detected_at,
            'suppression_applied', a.suppression_applied,
            'alert', CASE WHEN al.id IS NOT NULL THEN
              json_build_object(
                'alert_id', al.id,
                'status', al.status,
                'severity', al.severity,
                'is_suppressed', al.is_suppressed
              )
              ELSE NULL
            END
          )
          ORDER BY a.detected_at ASC, a.id ASC
        ) FILTER (WHERE a.id IS NOT NULL),
        '[]'::json
      ) as anomalies
    FROM sensor_readings sr
    LEFT JOIN anomalies a ON a.reading_id = sr.id
    LEFT JOIN alerts al ON al.anomaly_id = a.id
    WHERE sr.sensor_id = $1
      AND sr.reading_ts >= $2
      AND sr.reading_ts <= $3
      ${cursorClause}
    GROUP BY sr.id, sr.reading_ts, sr.voltage, sr.current_val, sr.temperature, sr.status_code
    ORDER BY sr.reading_ts DESC, sr.id DESC
    LIMIT $${paramIdx}
  `, queryParams);

  const data = rows.map(r => ({
    reading_id: Number(r.reading_id),
    timestamp: r.timestamp,
    voltage: parseFloat(r.voltage),
    current: parseFloat(r.current),
    temperature: parseFloat(r.temperature),
    status_code: r.status_code,
    anomalies: r.anomalies,
  }));

  const next_cursor = rows.length === limit
    ? encodeCursor(rows[rows.length - 1].timestamp, Number(rows[rows.length - 1].reading_id))
    : null;

  return { data, meta: { limit, next_cursor } };
}
