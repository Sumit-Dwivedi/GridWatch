import { pool } from '../../db/client.js';
import { ValidationError } from '../../shared/errors.js';
import type { IngestRequest } from './ingest.schema.js';

export interface IngestResult {
  ingest_batch_id: string;
  accepted_count: number;
  queued_count: number;
}

export async function ingestReadings(request: IngestRequest): Promise<IngestResult> {
  const { readings, request_id } = request;

  // Step 1: Resolve sensor external keys to internal UUIDs
  const uniqueExternalKeys = [...new Set(readings.map(r => r.sensor_id))];

  const { rows: sensorRows } = await pool.query(
    `SELECT id, external_key FROM sensors WHERE external_key = ANY($1)`,
    [uniqueExternalKeys]
  );

  const sensorMap = new Map<string, string>();
  for (const row of sensorRows) {
    sensorMap.set(row.external_key, row.id);
  }

  const unknownKeys = uniqueExternalKeys.filter(k => !sensorMap.has(k));
  if (unknownKeys.length > 0) {
    throw new ValidationError(`Unknown sensor IDs: ${unknownKeys.join(', ')}`);
  }

  // Build arrays for unnest
  const sensorIds: string[] = [];
  const timestamps: string[] = [];
  const voltages: number[] = [];
  const currents: number[] = [];
  const temperatures: number[] = [];
  const statusCodes: string[] = [];

  for (const reading of readings) {
    sensorIds.push(sensorMap.get(reading.sensor_id)!);
    timestamps.push(reading.timestamp);
    voltages.push(reading.voltage);
    currents.push(reading.current);
    temperatures.push(reading.temperature);
    statusCodes.push(reading.status_code);
  }

  // Step 2: Single transaction — batch + readings + jobs + state update
  const batchId = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 2a. Create ingest batch
    await client.query(
      `INSERT INTO ingest_batches (id, reading_count, request_id, status)
       VALUES ($1, $2, $3, 'accepted')`,
      [batchId, readings.length, request_id ?? null]
    );

    // 2b. Single CTE: insert readings + create jobs + update sensor_state
    const result = await client.query(`
      WITH inserted AS (
        INSERT INTO sensor_readings (sensor_id, reading_ts, voltage, current_val, temperature, status_code, ingest_batch_id)
        SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::numeric[], $4::numeric[], $5::numeric[], $6::text[], $7::uuid[])
        ON CONFLICT (sensor_id, reading_ts) DO NOTHING
        RETURNING id, sensor_id, reading_ts
      ),
      jobs AS (
        INSERT INTO reading_processing_jobs (reading_id, status, available_at)
        SELECT id, 'queued', now() FROM inserted
      ),
      latest_per_sensor AS (
        SELECT DISTINCT ON (sensor_id)
          sensor_id, id, reading_ts
        FROM inserted
        ORDER BY sensor_id, reading_ts DESC, id DESC
      ),
      state_update AS (
        UPDATE sensor_state
        SET last_reading_ts = lps.reading_ts,
            last_reading_id = lps.id,
            updated_at = now()
        FROM latest_per_sensor lps
        WHERE sensor_state.sensor_id = lps.sensor_id
          AND (sensor_state.last_reading_ts IS NULL OR sensor_state.last_reading_ts < lps.reading_ts)
      )
      SELECT count(*)::int AS queued_count FROM inserted
    `, [sensorIds, timestamps, voltages, currents, temperatures, statusCodes,
        Array(readings.length).fill(batchId)]);

    await client.query('COMMIT');

    return {
      ingest_batch_id: batchId,
      accepted_count: readings.length,
      queued_count: result.rows[0].queued_count,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
