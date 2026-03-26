import { pool } from '../db/client.js';
import bcrypt from 'bcryptjs';

// ============================================================
// Hardcoded UUIDs for predictable references
// ============================================================
const ZONE_NORTH  = '00000000-0000-4000-a000-000000000001';
const ZONE_SOUTH  = '00000000-0000-4000-a000-000000000002';
const ZONE_CENTRAL= '00000000-0000-4000-a000-000000000003';

const USER_SUPERVISOR = '00000000-0000-4000-b000-000000000001';
const USER_OPERATOR1  = '00000000-0000-4000-b000-000000000002';
const USER_OPERATOR2  = '00000000-0000-4000-b000-000000000003';

const BATCH_ID = '00000000-0000-4000-c000-000000000001';

const zones = [
  { id: ZONE_NORTH,   code: 'north',   name: 'North Zone' },
  { id: ZONE_SOUTH,   code: 'south',   name: 'South Zone' },
  { id: ZONE_CENTRAL, code: 'central', name: 'Central Zone' },
];

// ============================================================
// Helpers
// ============================================================
function randomDate(daysBack: number): Date {
  const now = Date.now();
  return new Date(now - Math.random() * daysBack * 86400000);
}

async function bulkInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
  batchSize = 5000
) {
  const colStr = columns.join(', ');
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params: unknown[] = [];
    const valuesClauses: string[] = [];
    for (const row of batch) {
      const placeholders: string[] = [];
      for (const val of row) {
        params.push(val);
        placeholders.push(`$${params.length}`);
      }
      valuesClauses.push(`(${placeholders.join(', ')})`);
    }
    await pool.query(
      `INSERT INTO ${table} (${colStr}) VALUES ${valuesClauses.join(', ')}`,
      params
    );
  }
}

// ============================================================
// Main seed
// ============================================================
async function seed() {
  const startTime = Date.now();
  const now = new Date();

  try {
    // ----------------------------------------------------------
    // Truncate all tables
    // ----------------------------------------------------------
    console.log('Truncating tables...');
    await pool.query(`
      TRUNCATE
        event_outbox,
        escalation_log,
        alert_transitions,
        alerts,
        anomalies,
        sensor_suppressions,
        sensor_state,
        reading_processing_jobs,
        sensor_readings,
        ingest_batches,
        sensor_silence_rules,
        sensor_spike_rules,
        sensor_threshold_rules,
        sensors,
        user_zone_assignments,
        users,
        zones
      CASCADE
    `);

    // ----------------------------------------------------------
    // 1. Zones
    // ----------------------------------------------------------
    console.log('Seeding zones...');
    await bulkInsert('zones', ['id', 'code', 'name'], zones.map(z => [z.id, z.code, z.name]));

    // ----------------------------------------------------------
    // 2. Users
    // ----------------------------------------------------------
    console.log('Seeding users...');
    const supHash = await bcrypt.hash('supervisor123', 10);
    const opHash  = await bcrypt.hash('operator123', 10);

    await bulkInsert('users', ['id', 'email', 'password_hash', 'full_name', 'role', 'supervisor_user_id'], [
      [USER_SUPERVISOR, 'supervisor@gridwatch.io', supHash, 'Supervisor Admin', 'supervisor', null],
      [USER_OPERATOR1,  'operator1@gridwatch.io',  opHash,  'Operator One',     'operator',   USER_SUPERVISOR],
      [USER_OPERATOR2,  'operator2@gridwatch.io',  opHash,  'Operator Two',     'operator',   USER_SUPERVISOR],
    ]);

    // Zone assignments — operators only, no supervisor
    await bulkInsert('user_zone_assignments', ['user_id', 'zone_id'], [
      [USER_OPERATOR1, ZONE_NORTH],
      [USER_OPERATOR2, ZONE_SOUTH],
    ]);

    // ----------------------------------------------------------
    // 3. Sensors (350 per zone = 1050 total)
    // ----------------------------------------------------------
    console.log('Seeding sensors (1050)...');
    const substations = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const SENSORS_PER_ZONE = 350;
    const SENSORS_PER_SUBSTATION = 50;

    interface SensorRecord {
      id: string;
      externalKey: string;
      zoneId: string;
      name: string;
      substationName: string;
      index: number;
    }
    const allSensors: SensorRecord[] = [];

    const sensorRows: unknown[][] = [];
    let globalIdx = 0;
    for (const zone of zones) {
      for (let i = 0; i < SENSORS_PER_ZONE; i++) {
        const subIdx = Math.floor(i / SENSORS_PER_SUBSTATION);
        const sensorNum = (i % SENSORS_PER_SUBSTATION) + 1;
        const sub = substations[subIdx % substations.length];
        const padded = String(i + 1).padStart(4, '0');
        const externalKey = `SEN-${zone.code.toUpperCase()}-${padded}`;
        const name = `${zone.name} / Substation ${sub} / Sensor ${sensorNum}`;
        const substationName = `Substation ${sub}`;
        const sensorId = crypto.randomUUID();
        const installedAt = randomDate(365);

        allSensors.push({
          id: sensorId,
          externalKey,
          zoneId: zone.id,
          name,
          substationName,
          index: globalIdx,
        });

        sensorRows.push([sensorId, externalKey, zone.id, name, substationName, true, installedAt.toISOString()]);
        globalIdx++;
      }
    }
    await bulkInsert('sensors', ['id', 'external_key', 'zone_id', 'name', 'substation_name', 'is_active', 'installed_at'], sensorRows);

    // ----------------------------------------------------------
    // 4. Sensor Rules
    // ----------------------------------------------------------
    console.log('Seeding sensor rules...');
    const thresholdRows: unknown[][] = [];
    const spikeRows: unknown[][] = [];
    const silenceRows: unknown[][] = [];

    for (let i = 0; i < allSensors.length; i++) {
      const s = allSensors[i];
      const isCritical = i % 10 === 0;
      thresholdRows.push([
        s.id,
        isCritical ? 200 : 210,
        isCritical ? 260 : 250,
        isCritical ? -10 : 0,
        isCritical ? 80 : 60,
        isCritical ? 'critical' : 'warning',
        true,
      ]);

      spikeRows.push([s.id, 'voltage',     15.0, 'warning',  true]);
      spikeRows.push([s.id, 'current',     20.0, 'warning',  true]);
      spikeRows.push([s.id, 'temperature', 10.0, 'critical', true]);

      silenceRows.push([s.id, 120, 'warning', true]);
    }

    await bulkInsert('sensor_threshold_rules',
      ['sensor_id', 'min_voltage', 'max_voltage', 'min_temperature', 'max_temperature', 'severity', 'is_enabled'],
      thresholdRows);
    await bulkInsert('sensor_spike_rules',
      ['sensor_id', 'metric', 'spike_pct', 'severity', 'is_enabled'],
      spikeRows);
    await bulkInsert('sensor_silence_rules',
      ['sensor_id', 'silence_after_seconds', 'severity', 'is_enabled'],
      silenceRows);

    // ----------------------------------------------------------
    // 5. Sensor Readings (server-side generation via generate_series)
    // ----------------------------------------------------------
    console.log('Seeding ingest batch...');
    await pool.query(
      `INSERT INTO ingest_batches (id, received_at, reading_count, request_id, status) VALUES ($1, $2, 0, 'seed', 'processed')`,
      [BATCH_ID, now.toISOString()]
    );

    // Sensor categories
    const TIER1_PER_ZONE = 20;
    const tier1Ids: string[] = [];
    for (let z = 0; z < 3; z++) {
      for (let i = 0; i < TIER1_PER_ZONE; i++) {
        tier1Ids.push(allSensors[z * SENSORS_PER_ZONE + i].id);
      }
    }

    const thresholdBreachIndices = [1, 351];
    const spikeIndices = [2, 352];
    const silentIndices = [3, 353, 703];
    const suppressedIndex = 4;

    const silentSensorIds = silentIndices.map(i => allSensors[i].id);
    const tier1Set = new Set(tier1Ids);
    const tier2Ids = allSensors.filter(s => !tier1Set.has(s.id)).map(s => s.id);

    const nowMs = now.getTime();

    // Drop indexes for fast bulk insert
    console.log('Preparing for bulk insert...');
    await pool.query(`DROP INDEX IF EXISTS uq_sensor_readings_sensor_ts`);
    await pool.query(`DROP INDEX IF EXISTS idx_sensor_readings_sensor_ts_desc`);
    await pool.query(`DROP INDEX IF EXISTS idx_sensor_readings_batch`);

    // Server-side generate_series — batch by chunks of sensors to keep transaction size manageable
    console.log('Generating Tier 1 readings (60 sensors × 48h @ 10s)...');
    let t0 = Date.now();

    // Run sensor batches in parallel (10 concurrent connections × 5 sensors each)
    const CONCURRENCY = 10;
    const TIER1_BATCH_SIZE = 5;
    const tier1Batches: string[][] = [];
    for (let i = 0; i < tier1Ids.length; i += TIER1_BATCH_SIZE) {
      tier1Batches.push(tier1Ids.slice(i, i + TIER1_BATCH_SIZE));
    }

    let completed = 0;
    const runBatch = async (batch: string[]) => {
      await pool.query(`
        INSERT INTO sensor_readings (sensor_id, reading_ts, voltage, current_val, temperature, status_code, ingest_batch_id)
        SELECT
          s.id,
          ts,
          round((230 + (random() * 6 - 3))::numeric, 4),
          round((10 + (random() * 2 - 1))::numeric, 4),
          round((35 + (random() * 4 - 2))::numeric, 4),
          'OK',
          $1::uuid
        FROM unnest($2::uuid[]) AS s(id)
        CROSS JOIN generate_series(
          $3::timestamptz,
          $4::timestamptz,
          interval '10 seconds'
        ) AS ts
        WHERE NOT (s.id = ANY($5::uuid[]) AND ts > $6::timestamptz)
      `, [
        BATCH_ID,
        batch,
        new Date(nowMs - 48 * 3600 * 1000).toISOString(),
        now.toISOString(),
        silentSensorIds,
        new Date(nowMs - 5 * 60 * 1000).toISOString(),
      ]);
      completed += batch.length;
      console.log(`  ${completed}/${tier1Ids.length} sensors done...`);
    };

    // Process with concurrency limit
    const executing: Promise<void>[] = [];
    for (const batch of tier1Batches) {
      const p = runBatch(batch);
      executing.push(p);
      if (executing.length >= CONCURRENCY) {
        await Promise.race(executing);
        // Remove settled promises
        for (let i = executing.length - 1; i >= 0; i--) {
          const status = await Promise.race([executing[i].then(() => 'done'), Promise.resolve('pending')]);
          if (status === 'done') executing.splice(i, 1);
        }
      }
    }
    await Promise.all(executing);
    console.log(`  Tier 1 done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    console.log('Generating Tier 2 readings (990 sensors × 2h @ 120s)...');
    t0 = Date.now();
    const TIER2_BATCH_SIZE = 100;
    const tier2Batches: string[][] = [];
    for (let i = 0; i < tier2Ids.length; i += TIER2_BATCH_SIZE) {
      tier2Batches.push(tier2Ids.slice(i, i + TIER2_BATCH_SIZE));
    }

    const runT2Batch = async (batch: string[]) => {
      await pool.query(`
        INSERT INTO sensor_readings (sensor_id, reading_ts, voltage, current_val, temperature, status_code, ingest_batch_id)
        SELECT
          s.id,
          ts,
          round((230 + (random() * 6 - 3))::numeric, 4),
          round((10 + (random() * 2 - 1))::numeric, 4),
          round((35 + (random() * 4 - 2))::numeric, 4),
          'OK',
          $1::uuid
        FROM unnest($2::uuid[]) AS s(id)
        CROSS JOIN generate_series(
          $3::timestamptz,
          $4::timestamptz,
          interval '120 seconds'
        ) AS ts
        WHERE NOT (s.id = ANY($5::uuid[]) AND ts > $6::timestamptz)
      `, [
        BATCH_ID,
        batch,
        new Date(nowMs - 2 * 3600 * 1000).toISOString(),
        now.toISOString(),
        silentSensorIds,
        new Date(nowMs - 5 * 60 * 1000).toISOString(),
      ]);
    };

    const t2Executing: Promise<void>[] = [];
    for (const batch of tier2Batches) {
      const p = runT2Batch(batch);
      t2Executing.push(p);
      if (t2Executing.length >= CONCURRENCY) {
        await Promise.race(t2Executing);
        for (let i = t2Executing.length - 1; i >= 0; i--) {
          const status = await Promise.race([t2Executing[i].then(() => 'done'), Promise.resolve('pending')]);
          if (status === 'done') t2Executing.splice(i, 1);
        }
      }
    }
    await Promise.all(t2Executing);
    console.log(`  Tier 2 done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Fix special sensors: threshold breach — force high voltage on last 5 readings
    t0 = Date.now();
    for (const idx of thresholdBreachIndices) {
      await pool.query(`
        UPDATE sensor_readings SET voltage = 260.0000
        WHERE sensor_id = $1 AND reading_ts >= (
          SELECT reading_ts FROM sensor_readings WHERE sensor_id = $1 ORDER BY reading_ts DESC OFFSET 4 LIMIT 1
        )
      `, [allSensors[idx].id]);
    }
    for (const idx of spikeIndices) {
      await pool.query(`
        UPDATE sensor_readings SET voltage = 290.0000
        WHERE sensor_id = $1 AND reading_ts = (
          SELECT max(reading_ts) FROM sensor_readings WHERE sensor_id = $1
        )
      `, [allSensors[idx].id]);
    }
    console.log(`  Special sensors fixed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Recreate indexes and switch back to logged
    console.log('Recreating indexes...');
    t0 = Date.now();
    await pool.query(`CREATE UNIQUE INDEX uq_sensor_readings_sensor_ts ON sensor_readings(sensor_id, reading_ts)`);
    await pool.query(`CREATE INDEX idx_sensor_readings_sensor_ts_desc ON sensor_readings(sensor_id, reading_ts DESC)`);
    await pool.query(`CREATE INDEX idx_sensor_readings_batch ON sensor_readings(ingest_batch_id)`);
    console.log(`  Indexes done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Update batch count
    const { rows: [{ count: totalReadings }] } = await pool.query(`SELECT count(*)::int as count FROM sensor_readings`);
    await pool.query(`UPDATE ingest_batches SET reading_count = $1 WHERE id = $2`, [totalReadings, BATCH_ID]);
    console.log(`  Total readings: ${totalReadings}`);

    // ----------------------------------------------------------
    // 6. Suppression
    // ----------------------------------------------------------
    console.log('Seeding suppression...');
    const suppressionSensor = allSensors[suppressedIndex];
    const { rows: [suppRow] } = await pool.query(
      `INSERT INTO sensor_suppressions (sensor_id, zone_id, start_time, end_time, created_by_user_id, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        suppressionSensor.id,
        suppressionSensor.zoneId,
        new Date(nowMs - 3600000).toISOString(),
        new Date(nowMs + 3600000).toISOString(),
        USER_OPERATOR1,
        'Planned maintenance',
      ]
    );
    const suppressionId = suppRow.id;

    // ----------------------------------------------------------
    // 7. Sensor State
    // ----------------------------------------------------------
    console.log('Seeding sensor state...');
    const silentSet = new Set(silentIndices);

    // Get last reading ids for all sensors
    const { rows: lastReadings } = await pool.query(`
      SELECT DISTINCT ON (sensor_id) sensor_id, id as reading_id, reading_ts
      FROM sensor_readings
      ORDER BY sensor_id, reading_ts DESC
    `);
    const lastReadingMap = new Map<string, { readingId: string; readingTs: string }>();
    for (const r of lastReadings) {
      lastReadingMap.set(r.sensor_id, { readingId: r.reading_id, readingTs: r.reading_ts });
    }

    const sensorStateRows: unknown[][] = [];
    for (let idx = 0; idx < allSensors.length; idx++) {
      const s = allSensors[idx];
      const lr = lastReadingMap.get(s.id);
      const isSilent = silentSet.has(idx);
      const isSuppressed = idx === suppressedIndex;

      sensorStateRows.push([
        s.id,
        s.zoneId,
        lr?.readingId ?? null,
        lr?.readingTs ?? null,
        isSilent ? 'silent' : 'healthy',
        null,
        null,
        isSuppressed,
        isSuppressed ? suppressionId : null,
      ]);
    }
    await bulkInsert('sensor_state',
      ['sensor_id', 'zone_id', 'last_reading_id', 'last_reading_ts', 'current_status', 'latest_open_alert_id', 'latest_severity', 'is_suppressed', 'active_suppression_id'],
      sensorStateRows);

    // ----------------------------------------------------------
    // 8. Pre-seeded Alerts
    // ----------------------------------------------------------
    console.log('Seeding alerts...');

    async function getReadingForSensor(sensorId: string, desc = true): Promise<{ id: string; reading_ts: string }> {
      const { rows } = await pool.query(
        `SELECT id, reading_ts FROM sensor_readings WHERE sensor_id = $1 ORDER BY reading_ts ${desc ? 'DESC' : 'ASC'} LIMIT 1`,
        [sensorId]
      );
      return rows[0];
    }

    async function createAlert(opts: {
      sensorIdx: number;
      anomalyType: string;
      metric: string;
      severity: 'warning' | 'critical';
      status: 'open' | 'acknowledged' | 'resolved';
      isSuppressed?: boolean;
      assignedUserId: string | null;
      transitions: Array<{ from: string | null; to: string; userId: string | null; reason: string | null }>;
      updateState?: { currentStatus: string; setAlert: boolean };
    }) {
      const sensor = allSensors[opts.sensorIdx];
      const reading = await getReadingForSensor(sensor.id);

      const { rows: [anomaly] } = await pool.query(
        `INSERT INTO anomalies (sensor_id, reading_id, anomaly_type, metric, severity, details, detected_at, suppression_applied)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          sensor.id,
          reading.id,
          opts.anomalyType,
          opts.metric,
          opts.severity,
          JSON.stringify({ seeded: true }),
          reading.reading_ts,
          opts.isSuppressed ?? false,
        ]
      );

      const acknowledgedAt = opts.status === 'acknowledged' || opts.status === 'resolved'
        ? new Date(nowMs - 1800000).toISOString() : null;
      const resolvedAt = opts.status === 'resolved'
        ? new Date(nowMs - 900000).toISOString() : null;

      const { rows: [alert] } = await pool.query(
        `INSERT INTO alerts (anomaly_id, sensor_id, zone_id, assigned_user_id, status, severity, is_suppressed, opened_at, acknowledged_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          anomaly.id,
          sensor.id,
          sensor.zoneId,
          opts.assignedUserId,
          opts.status,
          opts.severity,
          opts.isSuppressed ?? false,
          reading.reading_ts,
          acknowledgedAt,
          resolvedAt,
        ]
      );

      for (const t of opts.transitions) {
        await pool.query(
          `INSERT INTO alert_transitions (alert_id, from_status, to_status, changed_by_user_id, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [alert.id, t.from, t.to, t.userId, t.reason]
        );
      }

      if (opts.updateState) {
        const setAlert = opts.updateState.setAlert;
        await pool.query(
          `UPDATE sensor_state SET current_status = $1, latest_open_alert_id = $2, latest_severity = $3, updated_at = now()
           WHERE sensor_id = $4`,
          [
            opts.updateState.currentStatus,
            setAlert ? alert.id : null,
            setAlert ? opts.severity : null,
            sensor.id,
          ]
        );
      }

      return alert.id;
    }

    // 2 open critical alerts (threshold breach sensors)
    await createAlert({
      sensorIdx: 1,
      anomalyType: 'threshold_breach',
      metric: 'voltage',
      severity: 'critical',
      status: 'open',
      assignedUserId: USER_OPERATOR1,
      transitions: [{ from: null, to: 'open', userId: null, reason: null }],
      updateState: { currentStatus: 'critical', setAlert: true },
    });
    await createAlert({
      sensorIdx: 351,
      anomalyType: 'threshold_breach',
      metric: 'voltage',
      severity: 'critical',
      status: 'open',
      assignedUserId: USER_OPERATOR2,
      transitions: [{ from: null, to: 'open', userId: null, reason: null }],
      updateState: { currentStatus: 'critical', setAlert: true },
    });

    // 2 open warning alerts
    await createAlert({
      sensorIdx: 5,
      anomalyType: 'rate_of_change_spike',
      metric: 'voltage',
      severity: 'warning',
      status: 'open',
      assignedUserId: USER_OPERATOR1,
      transitions: [{ from: null, to: 'open', userId: null, reason: null }],
      updateState: { currentStatus: 'warning', setAlert: true },
    });
    await createAlert({
      sensorIdx: 355,
      anomalyType: 'rate_of_change_spike',
      metric: 'voltage',
      severity: 'warning',
      status: 'open',
      assignedUserId: USER_OPERATOR2,
      transitions: [{ from: null, to: 'open', userId: null, reason: null }],
      updateState: { currentStatus: 'warning', setAlert: true },
    });

    // 1 acknowledged warning (North)
    await createAlert({
      sensorIdx: 6,
      anomalyType: 'rate_of_change_spike',
      metric: 'temperature',
      severity: 'warning',
      status: 'acknowledged',
      assignedUserId: USER_OPERATOR1,
      transitions: [
        { from: null, to: 'open', userId: null, reason: null },
        { from: 'open', to: 'acknowledged', userId: USER_OPERATOR1, reason: 'Investigating' },
      ],
      updateState: { currentStatus: 'warning', setAlert: false },
    });

    // 1 resolved warning (South)
    await createAlert({
      sensorIdx: 356,
      anomalyType: 'rate_of_change_spike',
      metric: 'temperature',
      severity: 'warning',
      status: 'resolved',
      assignedUserId: USER_OPERATOR2,
      transitions: [
        { from: null, to: 'open', userId: null, reason: null },
        { from: 'open', to: 'resolved', userId: USER_OPERATOR2, reason: 'Sensor normalized' },
      ],
      updateState: { currentStatus: 'healthy', setAlert: false },
    });

    // 1 suppressed alert (North)
    await createAlert({
      sensorIdx: suppressedIndex,
      anomalyType: 'rate_of_change_spike',
      metric: 'voltage',
      severity: 'warning',
      status: 'open',
      isSuppressed: true,
      assignedUserId: USER_OPERATOR1,
      transitions: [{ from: null, to: 'open', userId: null, reason: null }],
      updateState: { currentStatus: 'healthy', setAlert: true },
    });

    // ----------------------------------------------------------
    // Done
    // ----------------------------------------------------------
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nSeed completed in ${elapsed}s`);
    console.log('');
    console.log('┌─────────────┬──────────────────────────┬───────────────┬─────────┐');
    console.log('│ Role        │ Email                    │ Password      │ Zone(s) │');
    console.log('├─────────────┼──────────────────────────┼───────────────┼─────────┤');
    console.log('│ Supervisor  │ supervisor@gridwatch.io  │ supervisor123 │ All     │');
    console.log('│ Operator 1  │ operator1@gridwatch.io   │ operator123   │ North   │');
    console.log('│ Operator 2  │ operator2@gridwatch.io   │ operator123   │ South   │');
    console.log('└─────────────┴──────────────────────────┴───────────────┴─────────┘');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
