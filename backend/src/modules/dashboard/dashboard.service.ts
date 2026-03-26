import { pool } from '../../db/client.js';
import type { ZoneAccessContext } from '../../shared/types.js';

function encodeCursor(updatedAt: string, sensorId: string): string {
  return Buffer.from(JSON.stringify({ ts: updatedAt, id: sensorId })).toString('base64url');
}

function decodeCursor(cursor: string): { ts: string; id: string } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

interface DashboardParams {
  zone_id?: string;
  status?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export async function getDashboardSensors(ctx: ZoneAccessContext, params: DashboardParams) {
  const limit = Math.min(Math.max(params.limit || 100, 1), 500);

  const queryParams: unknown[] = [];
  const conditions: string[] = [];
  let paramIdx = 1;

  // Zone filtering
  if (ctx.role === 'supervisor') {
    if (params.zone_id) {
      conditions.push(`ss.zone_id = $${paramIdx}`);
      queryParams.push(params.zone_id);
      paramIdx++;
    }
  } else {
    if (params.zone_id && ctx.zoneIds.includes(params.zone_id)) {
      conditions.push(`ss.zone_id = $${paramIdx}`);
      queryParams.push(params.zone_id);
      paramIdx++;
    } else {
      conditions.push(`ss.zone_id = ANY($${paramIdx})`);
      queryParams.push(ctx.zoneIds);
      paramIdx++;
    }
  }

  // Zone params for counts query (same zone scope but no status/search filter)
  const countParams: unknown[] = [...queryParams];
  const countConditions: string[] = [...conditions];

  // Status filter
  if (params.status) {
    conditions.push(`ss.current_status = $${paramIdx}`);
    queryParams.push(params.status);
    paramIdx++;
  }

  // Search filter
  if (params.search) {
    conditions.push(`(s.name ILIKE '%' || $${paramIdx} || '%' OR s.external_key ILIKE '%' || $${paramIdx} || '%')`);
    queryParams.push(params.search);
    paramIdx++;
  }

  // Cursor
  if (params.cursor) {
    const { ts, id } = decodeCursor(params.cursor);
    conditions.push(`(ss.updated_at, ss.sensor_id) < ($${paramIdx}, $${paramIdx + 1})`);
    queryParams.push(ts, id);
    paramIdx += 2;
  }

  queryParams.push(limit);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Main query + counts query in parallel
  const countWhereClause = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';

  const [sensorsResult, countsResult] = await Promise.all([
    pool.query(`
      SELECT
        ss.sensor_id,
        s.name as sensor_name,
        s.external_key,
        ss.zone_id,
        z.name as zone_name,
        ss.current_status,
        ss.last_reading_ts,
        ss.latest_open_alert_id,
        ss.latest_severity,
        ss.updated_at,
        EXISTS (
          SELECT 1 FROM sensor_suppressions sup
          WHERE sup.sensor_id = ss.sensor_id
            AND sup.start_time <= now() AND sup.end_time > now()
        ) as is_suppressed
      FROM sensor_state ss
      JOIN sensors s ON s.id = ss.sensor_id
      JOIN zones z ON z.id = ss.zone_id
      ${whereClause}
      ORDER BY ss.updated_at DESC, ss.sensor_id DESC
      LIMIT $${paramIdx}
    `, queryParams),
    pool.query(`
      SELECT current_status, count(*)::int as cnt
      FROM sensor_state ss
      ${countWhereClause}
      GROUP BY current_status
    `, countParams),
  ]);

  const data = sensorsResult.rows.map(r => ({
    sensor_id: r.sensor_id,
    sensor_name: r.sensor_name,
    external_key: r.external_key,
    zone_id: r.zone_id,
    zone_name: r.zone_name,
    current_status: r.current_status,
    last_reading_ts: r.last_reading_ts,
    latest_open_alert_id: r.latest_open_alert_id ? Number(r.latest_open_alert_id) : null,
    latest_severity: r.latest_severity,
    is_suppressed: r.is_suppressed,
    updated_at: r.updated_at,
  }));

  const counts: Record<string, number> = { healthy: 0, warning: 0, critical: 0, silent: 0 };
  for (const row of countsResult.rows) {
    counts[row.current_status] = row.cnt;
  }

  const next_cursor = sensorsResult.rows.length === limit
    ? encodeCursor(
        sensorsResult.rows[sensorsResult.rows.length - 1].updated_at,
        sensorsResult.rows[sensorsResult.rows.length - 1].sensor_id
      )
    : null;

  return { data, meta: { limit, next_cursor, counts } };
}
