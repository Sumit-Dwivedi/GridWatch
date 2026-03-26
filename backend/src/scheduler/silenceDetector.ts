import { pool } from '../db/client.js';

const POLL_INTERVAL_MS = 30_000;
const SILENCE_THRESHOLD_SECONDS = 120; // 2 minutes

// Cache: zone_id -> lowest operator user_id
const zoneOperatorCache = new Map<string, string | null>();

async function getZoneOperator(zoneId: string): Promise<string | null> {
  if (zoneOperatorCache.has(zoneId)) return zoneOperatorCache.get(zoneId)!;
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
     JOIN user_zone_assignments uza ON uza.user_id = u.id
     WHERE uza.zone_id = $1 AND u.role = 'operator' AND u.is_active = true
     ORDER BY u.id ASC LIMIT 1`,
    [zoneId]
  );
  const operatorId = rows.length > 0 ? rows[0].id : null;
  zoneOperatorCache.set(zoneId, operatorId);
  return operatorId;
}

async function detectSilentSensors(): Promise<number> {
  // Find sensors that should be marked silent:
  // - Have a silence rule enabled
  // - last_reading_ts older than silence_after_seconds
  // - current_status is NOT already 'silent'
  const { rows: candidates } = await pool.query(`
    SELECT ss.sensor_id, ss.zone_id, ss.current_status, ss.last_reading_ts,
           ssr.silence_after_seconds, ssr.severity
    FROM sensor_state ss
    JOIN sensor_silence_rules ssr ON ssr.sensor_id = ss.sensor_id AND ssr.is_enabled = true
    WHERE ss.current_status != 'silent'
      AND ss.last_reading_ts IS NOT NULL
      AND ss.last_reading_ts < now() - make_interval(secs => ssr.silence_after_seconds)
  `);

  if (candidates.length === 0) return 0;

  let detected = 0;

  for (const sensor of candidates) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Double-check: no existing unresolved pattern_absence anomaly for this sensor
      const { rows: existing } = await client.query(
        `SELECT id FROM anomalies
         WHERE sensor_id = $1 AND anomaly_type = 'pattern_absence'
           AND NOT EXISTS (
             SELECT 1 FROM alerts WHERE anomaly_id = anomalies.id AND status = 'resolved'
           )
         ORDER BY detected_at DESC LIMIT 1`,
        [sensor.sensor_id]
      );
      if (existing.length > 0) {
        await client.query('COMMIT');
        continue;
      }

      // Check suppression
      const { rows: suppressionRows } = await client.query(
        `SELECT id FROM sensor_suppressions
         WHERE sensor_id = $1 AND start_time <= now() AND end_time > now()
         LIMIT 1`,
        [sensor.sensor_id]
      );
      const isSuppressed = suppressionRows.length > 0;

      // Create anomaly (reading_id = NULL for pattern_absence)
      const { rows: anomalyRows } = await client.query(
        `INSERT INTO anomalies (sensor_id, reading_id, anomaly_type, metric, severity, details, detected_at, suppression_applied)
         VALUES ($1, NULL, 'pattern_absence', NULL, $2, $3, now(), $4)
         RETURNING id`,
        [
          sensor.sensor_id,
          sensor.severity,
          JSON.stringify({
            last_reading_ts: sensor.last_reading_ts,
            silence_threshold_seconds: sensor.silence_after_seconds,
          }),
          isSuppressed,
        ]
      );
      const anomalyId = anomalyRows[0].id;

      // Create alert
      const operatorId = await getZoneOperator(sensor.zone_id);
      const { rows: alertRows } = await client.query(
        `INSERT INTO alerts (anomaly_id, sensor_id, zone_id, assigned_user_id, status, severity, is_suppressed, opened_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'open', $5, $6, now(), now(), now())
         ON CONFLICT (anomaly_id) DO NOTHING
         RETURNING id`,
        [anomalyId, sensor.sensor_id, sensor.zone_id, operatorId, sensor.severity, isSuppressed]
      );

      if (alertRows.length > 0) {
        const alertId = alertRows[0].id;

        // Initial transition
        await client.query(
          `INSERT INTO alert_transitions (alert_id, from_status, to_status, changed_by_user_id, reason, changed_at)
           VALUES ($1, NULL, 'open', NULL, 'System: sensor silence detected', now())`,
          [alertId]
        );

        // Update sensor_state to silent
        await client.query(
          `UPDATE sensor_state
           SET current_status = 'silent',
               latest_open_alert_id = $2,
               latest_severity = $3,
               updated_at = now()
           WHERE sensor_id = $1`,
          [sensor.sensor_id, alertId, sensor.severity]
        );

        // Event outbox
        await client.query(
          `INSERT INTO event_outbox (topic, zone_id, aggregate_type, aggregate_id, payload, created_at)
           VALUES ('alert.created', $1, 'alert', $2::text, $3, now())`,
          [sensor.zone_id, alertId, JSON.stringify({
            type: 'alert.created',
            data: {
              alert_id: alertId,
              sensor_id: sensor.sensor_id,
              zone_id: sensor.zone_id,
              severity: sensor.severity,
              status: 'open',
              is_suppressed: isSuppressed,
              opened_at: new Date().toISOString(),
            },
          })]
        );

        // State change event
        await client.query(
          `INSERT INTO event_outbox (topic, zone_id, aggregate_type, aggregate_id, payload, created_at)
           VALUES ('sensor.state.changed', $1, 'sensor', $2::text, $3, now())`,
          [sensor.zone_id, sensor.sensor_id, JSON.stringify({
            type: 'sensor.state.changed',
            data: {
              sensor_id: sensor.sensor_id,
              zone_id: sensor.zone_id,
              previous_status: sensor.current_status,
              current_status: 'silent',
              updated_at: new Date().toISOString(),
            },
          })]
        );
      }

      await client.query('COMMIT');
      detected++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[silence-detector] Error processing sensor ${sensor.sensor_id}:`, err);
    } finally {
      client.release();
    }
  }

  return detected;
}

export function startSilenceDetector(): void {
  console.log('[silence-detector] Silence detector started (30s interval)');

  const loop = async () => {
    try {
      const detected = await detectSilentSensors();
      if (detected > 0) {
        console.log(`[silence-detector] Marked ${detected} sensors as silent`);
      }
    } catch (err) {
      console.error('[silence-detector] Loop error:', err);
    }
    setTimeout(loop, POLL_INTERVAL_MS);
  };

  // Start after a short delay
  setTimeout(loop, 2000);
}
