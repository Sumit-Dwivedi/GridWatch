import { pool } from '../../db/client.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import type { ZoneAccessContext } from '../../shared/types.js';

// --- Zone-checked sensor lookup ---

async function getSensorWithZoneCheck(ctx: ZoneAccessContext, sensorId: string) {
  const params: unknown[] = [sensorId];
  let zoneClause = '';
  if (ctx.role !== 'supervisor') {
    zoneClause = 'AND s.zone_id = ANY($2)';
    params.push(ctx.zoneIds);
  }
  const { rows } = await pool.query(
    `SELECT s.id, s.zone_id FROM sensors s WHERE s.id = $1 ${zoneClause}`,
    params
  );
  if (rows.length === 0) throw new NotFoundError('Sensor not found');
  return rows[0];
}

// --- Create suppression ---

interface CreateSuppressionInput {
  start_time: string;
  end_time: string;
  note?: string;
}

export async function createSuppression(ctx: ZoneAccessContext, sensorId: string, input: CreateSuppressionInput) {
  const sensor = await getSensorWithZoneCheck(ctx, sensorId);

  const startTime = new Date(input.start_time);
  const endTime = new Date(input.end_time);
  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
    throw new ValidationError('Invalid datetime format');
  }
  if (endTime <= startTime) {
    throw new ValidationError('end_time must be after start_time');
  }

  const { rows } = await pool.query(
    `INSERT INTO sensor_suppressions (sensor_id, zone_id, start_time, end_time, created_by_user_id, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, sensor_id, zone_id, start_time, end_time, created_by_user_id, note, created_at`,
    [sensorId, sensor.zone_id, input.start_time, input.end_time, ctx.userId, input.note || null]
  );

  const suppression = rows[0];

  // If currently active, update sensor_state
  const now = new Date();
  if (startTime <= now && endTime > now) {
    await pool.query(
      `UPDATE sensor_state
       SET is_suppressed = true,
           active_suppression_id = (
             SELECT id FROM sensor_suppressions
             WHERE sensor_id = $1 AND start_time <= now() AND end_time > now()
             ORDER BY id DESC LIMIT 1
           ),
           updated_at = now()
       WHERE sensor_id = $1`,
      [sensorId]
    );

    // Event outbox
    await pool.query(
      `INSERT INTO event_outbox (topic, zone_id, aggregate_type, aggregate_id, payload, created_at)
       VALUES ('suppression.updated', $1, 'sensor', $2::text, $3, now())`,
      [sensor.zone_id, sensorId, JSON.stringify({
        type: 'suppression.updated',
        data: {
          sensor_id: sensorId,
          zone_id: sensor.zone_id,
          suppression_id: Number(suppression.id),
          is_suppressed: true,
        },
      })]
    );
  }

  return {
    id: Number(suppression.id),
    sensor_id: suppression.sensor_id,
    zone_id: suppression.zone_id,
    start_time: suppression.start_time,
    end_time: suppression.end_time,
    note: suppression.note,
    created_by_user_id: suppression.created_by_user_id,
  };
}

// --- List suppressions ---

export async function listSuppressions(ctx: ZoneAccessContext, sensorId: string, activeOnly?: boolean) {
  await getSensorWithZoneCheck(ctx, sensorId);

  let activeClause = '';
  if (activeOnly) {
    activeClause = 'AND start_time <= now() AND end_time > now()';
  }

  const { rows } = await pool.query(
    `SELECT id, sensor_id, start_time, end_time, note, created_by_user_id, created_at,
            (start_time <= now() AND end_time > now()) as is_active
     FROM sensor_suppressions
     WHERE sensor_id = $1 ${activeClause}
     ORDER BY created_at DESC`,
    [sensorId]
  );

  return rows.map(r => ({
    id: Number(r.id),
    sensor_id: r.sensor_id,
    start_time: r.start_time,
    end_time: r.end_time,
    note: r.note,
    created_by_user_id: r.created_by_user_id,
    is_active: r.is_active,
    created_at: r.created_at,
  }));
}
