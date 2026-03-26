import { pool } from '../db/client.js';

const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 1000;
const STALE_TIMEOUT_MINUTES = 5;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_SECONDS = 10;
const STATS_INTERVAL_MS = 30000;

let totalProcessed = 0;
let totalAnomalies = 0;

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

interface ReadingRow {
  id: string;
  sensor_id: string;
  reading_ts: string;
  voltage: string;
  current_val: string;
  temperature: string;
}

interface ThresholdRule {
  min_voltage: string | null;
  max_voltage: string | null;
  min_temperature: string | null;
  max_temperature: string | null;
  severity: string;
}

interface SpikeRule {
  metric: string;
  spike_pct: string;
  severity: string;
}

interface AnomalyInput {
  sensorId: string;
  readingId: string;
  anomalyType: string;
  metric: string;
  severity: string;
  details: Record<string, unknown>;
  suppressionApplied: boolean;
}

async function processJob(jobId: string, readingId: string): Promise<void> {
  // Load reading
  const { rows: [reading] } = await pool.query<ReadingRow>(
    `SELECT id, sensor_id, reading_ts, voltage, current_val, temperature
     FROM sensor_readings WHERE id = $1`,
    [readingId]
  );
  if (!reading) {
    throw new Error(`Reading ${readingId} not found`);
  }

  // Load sensor zone
  const { rows: [sensor] } = await pool.query(
    `SELECT zone_id FROM sensors WHERE id = $1`,
    [reading.sensor_id]
  );
  if (!sensor) {
    throw new Error(`Sensor ${reading.sensor_id} not found`);
  }
  const zoneId: string = sensor.zone_id;

  // Check suppression
  const { rows: suppressionRows } = await pool.query(
    `SELECT id FROM sensor_suppressions
     WHERE sensor_id = $1 AND start_time <= $2 AND end_time > $2
     LIMIT 1`,
    [reading.sensor_id, reading.reading_ts]
  );
  const isSuppressed = suppressionRows.length > 0;

  const anomalies: AnomalyInput[] = [];

  // --- Rule A: Threshold breach ---
  const { rows: thresholdRules } = await pool.query<ThresholdRule>(
    `SELECT min_voltage, max_voltage, min_temperature, max_temperature, severity
     FROM sensor_threshold_rules
     WHERE sensor_id = $1 AND is_enabled = true`,
    [reading.sensor_id]
  );

  for (const rule of thresholdRules) {
    const voltage = parseFloat(reading.voltage);
    const temperature = parseFloat(reading.temperature);

    // Voltage check
    if (rule.min_voltage !== null && voltage < parseFloat(rule.min_voltage)) {
      anomalies.push({
        sensorId: reading.sensor_id, readingId: reading.id,
        anomalyType: 'threshold_breach', metric: 'voltage', severity: rule.severity,
        details: { actual_value: voltage, threshold: parseFloat(rule.min_voltage), direction: 'below_min', rule_severity: rule.severity },
        suppressionApplied: isSuppressed,
      });
    } else if (rule.max_voltage !== null && voltage > parseFloat(rule.max_voltage)) {
      anomalies.push({
        sensorId: reading.sensor_id, readingId: reading.id,
        anomalyType: 'threshold_breach', metric: 'voltage', severity: rule.severity,
        details: { actual_value: voltage, threshold: parseFloat(rule.max_voltage), direction: 'above_max', rule_severity: rule.severity },
        suppressionApplied: isSuppressed,
      });
    }

    // Temperature check
    if (rule.min_temperature !== null && temperature < parseFloat(rule.min_temperature)) {
      anomalies.push({
        sensorId: reading.sensor_id, readingId: reading.id,
        anomalyType: 'threshold_breach', metric: 'temperature', severity: rule.severity,
        details: { actual_value: temperature, threshold: parseFloat(rule.min_temperature), direction: 'below_min', rule_severity: rule.severity },
        suppressionApplied: isSuppressed,
      });
    } else if (rule.max_temperature !== null && temperature > parseFloat(rule.max_temperature)) {
      anomalies.push({
        sensorId: reading.sensor_id, readingId: reading.id,
        anomalyType: 'threshold_breach', metric: 'temperature', severity: rule.severity,
        details: { actual_value: temperature, threshold: parseFloat(rule.max_temperature), direction: 'above_max', rule_severity: rule.severity },
        suppressionApplied: isSuppressed,
      });
    }
  }

  // --- Rule B: Rate-of-change spike ---
  const { rows: spikeRules } = await pool.query<SpikeRule>(
    `SELECT metric, spike_pct, severity
     FROM sensor_spike_rules
     WHERE sensor_id = $1 AND is_enabled = true`,
    [reading.sensor_id]
  );

  if (spikeRules.length > 0) {
    // Fetch previous 3 readings
    const { rows: prevReadings } = await pool.query(
      `SELECT voltage, current_val, temperature
       FROM sensor_readings
       WHERE sensor_id = $1 AND reading_ts < $2
       ORDER BY reading_ts DESC
       LIMIT 3`,
      [reading.sensor_id, reading.reading_ts]
    );

    if (prevReadings.length >= 3) {
      const metricMap: Record<string, { current: number; previous: number[] }> = {
        voltage: {
          current: parseFloat(reading.voltage),
          previous: prevReadings.map((r: { voltage: string }) => parseFloat(r.voltage)),
        },
        current: {
          current: parseFloat(reading.current_val),
          previous: prevReadings.map((r: { current_val: string }) => parseFloat(r.current_val)),
        },
        temperature: {
          current: parseFloat(reading.temperature),
          previous: prevReadings.map((r: { temperature: string }) => parseFloat(r.temperature)),
        },
      };

      for (const rule of spikeRules) {
        const data = metricMap[rule.metric];
        if (!data) continue;

        const avg = data.previous.reduce((a, b) => a + b, 0) / data.previous.length;
        if (Math.abs(avg) < 0.001) continue; // skip near-zero

        const changePct = Math.abs(data.current - avg) / Math.abs(avg) * 100;
        const thresholdPct = parseFloat(rule.spike_pct);

        if (changePct > thresholdPct) {
          anomalies.push({
            sensorId: reading.sensor_id, readingId: reading.id,
            anomalyType: 'rate_of_change_spike', metric: rule.metric, severity: rule.severity,
            details: {
              actual_value: data.current,
              previous_average: parseFloat(avg.toFixed(4)),
              change_pct: parseFloat(changePct.toFixed(2)),
              threshold_pct: thresholdPct,
            },
            suppressionApplied: isSuppressed,
          });
        }
      }
    }
  }

  // --- Create anomalies + alerts ---
  const operatorId = await getZoneOperator(zoneId);
  let stateChanged = false;

  for (const anomaly of anomalies) {
    // Insert anomaly (idempotent)
    const { rows: anomalyRows } = await pool.query(
      `INSERT INTO anomalies (sensor_id, reading_id, anomaly_type, metric, severity, details, detected_at, suppression_applied)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
       ON CONFLICT (reading_id, anomaly_type, metric) WHERE reading_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [anomaly.sensorId, anomaly.readingId, anomaly.anomalyType, anomaly.metric, anomaly.severity,
       JSON.stringify(anomaly.details), anomaly.suppressionApplied]
    );

    if (anomalyRows.length === 0) continue; // already exists from retry
    const anomalyId = anomalyRows[0].id;
    totalAnomalies++;

    // Insert alert (idempotent via unique anomaly_id)
    const { rows: alertRows } = await pool.query(
      `INSERT INTO alerts (anomaly_id, sensor_id, zone_id, assigned_user_id, status, severity, is_suppressed, opened_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', $5, $6, now(), now(), now())
       ON CONFLICT (anomaly_id) DO NOTHING
       RETURNING id`,
      [anomalyId, anomaly.sensorId, zoneId, operatorId, anomaly.severity, anomaly.suppressionApplied]
    );

    if (alertRows.length > 0) {
      const alertId = alertRows[0].id;
      stateChanged = true;

      // Initial transition
      await pool.query(
        `INSERT INTO alert_transitions (alert_id, from_status, to_status, changed_by_user_id, reason, changed_at)
         VALUES ($1, NULL, 'open', NULL, 'System: anomaly detected', now())`,
        [alertId]
      );

      // alert.created event
      await pool.query(
        `INSERT INTO event_outbox (topic, zone_id, aggregate_type, aggregate_id, payload, created_at)
         VALUES ('alert.created', $1, 'alert', $2::text, $3, now())`,
        [zoneId, alertId, JSON.stringify({
          type: 'alert.created',
          data: {
            alert_id: alertId,
            sensor_id: anomaly.sensorId,
            zone_id: zoneId,
            severity: anomaly.severity,
            status: 'open',
            is_suppressed: anomaly.suppressionApplied,
            opened_at: new Date().toISOString(),
          },
        })]
      );
    }
  }

  // --- Recompute sensor state ---
  // Always recompute when processing a reading (new data arrival should clear silent state)
  {
    // Get old status
    const { rows: [oldState] } = await pool.query(
      `SELECT current_status FROM sensor_state WHERE sensor_id = $1`,
      [reading.sensor_id]
    );
    const oldStatus = oldState?.current_status ?? 'healthy';

    // Compute new status — exclude pattern_absence anomalies so new readings clear 'silent'
    const { rows: [statusRow] } = await pool.query(
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
      [reading.sensor_id]
    );
    const newStatus = statusRow.new_status;

    await pool.query(
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
      [newStatus, reading.sensor_id]
    );

    // Emit state change event only if status actually changed
    if (oldStatus !== newStatus) {
      await pool.query(
        `INSERT INTO event_outbox (topic, zone_id, aggregate_type, aggregate_id, payload, created_at)
         VALUES ('sensor.state.changed', $1, 'sensor', $2::text, $3, now())`,
        [zoneId, reading.sensor_id, JSON.stringify({
          type: 'sensor.state.changed',
          data: {
            sensor_id: reading.sensor_id,
            zone_id: zoneId,
            previous_status: oldStatus,
            current_status: newStatus,
            updated_at: new Date().toISOString(),
          },
        })]
      );
    }
  }
}

async function recoverStaleJobs(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE reading_processing_jobs
     SET status = 'queued', locked_at = NULL, lock_token = NULL,
         available_at = now(), updated_at = now()
     WHERE status = 'processing'
       AND locked_at < now() - interval '${STALE_TIMEOUT_MINUTES} minutes'`
  );
  return rowCount ?? 0;
}

async function tick(): Promise<number> {
  // Claim batch
  const { rows: jobs } = await pool.query(
    `UPDATE reading_processing_jobs
     SET status = 'processing', locked_at = now(), attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM reading_processing_jobs
       WHERE status = 'queued' AND available_at <= now()
       ORDER BY id
       LIMIT ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, reading_id`
  );

  if (jobs.length === 0) return 0;

  for (const job of jobs) {
    try {
      await processJob(job.id, job.reading_id);
      await pool.query(
        `UPDATE reading_processing_jobs SET status = 'done', updated_at = now() WHERE id = $1`,
        [job.id]
      );
      totalProcessed++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[worker] Job ${job.id} failed: ${errorMsg}`);

      // Check current attempts
      const { rows: [jobRow] } = await pool.query(
        `SELECT attempts FROM reading_processing_jobs WHERE id = $1`,
        [job.id]
      );
      const attempts = jobRow?.attempts ?? MAX_ATTEMPTS;

      if (attempts >= MAX_ATTEMPTS) {
        await pool.query(
          `UPDATE reading_processing_jobs
           SET status = 'failed', last_error = $2, updated_at = now()
           WHERE id = $1`,
          [job.id, errorMsg]
        );
      } else {
        await pool.query(
          `UPDATE reading_processing_jobs
           SET status = 'queued', locked_at = NULL,
               available_at = now() + interval '${RETRY_DELAY_SECONDS} seconds',
               last_error = $2, updated_at = now()
           WHERE id = $1`,
          [job.id, errorMsg]
        );
      }
    }
  }

  return jobs.length;
}

export function startReadingProcessor(): void {
  console.log('[worker] Reading processor started');

  let statsTimer = Date.now();

  const loop = async () => {
    try {
      const recovered = await recoverStaleJobs();
      if (recovered > 0) {
        console.log(`[worker] Recovered ${recovered} stale jobs`);
      }

      const processed = await tick();

      // Log stats periodically
      if (Date.now() - statsTimer >= STATS_INTERVAL_MS) {
        console.log(`[worker] Stats: ${totalProcessed} jobs processed, ${totalAnomalies} anomalies detected`);
        statsTimer = Date.now();
      }

      // If jobs were found, loop immediately; otherwise wait
      setTimeout(loop, processed > 0 ? 0 : POLL_INTERVAL_MS);
    } catch (err) {
      console.error('[worker] Worker loop error:', err);
      setTimeout(loop, POLL_INTERVAL_MS);
    }
  };

  // Start after a short delay to let server finish initializing
  setTimeout(loop, 500);
}
