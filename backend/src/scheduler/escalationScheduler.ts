import { pool } from '../db/client.js';

const POLL_INTERVAL_MS = 15_000;
const ESCALATION_THRESHOLD_MINUTES = 5;

async function escalateAlerts(): Promise<number> {
  // Find critical open alerts that are unacknowledged for > 5 minutes, not suppressed, not already escalated
  const { rows: candidates } = await pool.query(`
    SELECT a.id AS alert_id, a.sensor_id, a.zone_id, a.assigned_user_id, a.severity
    FROM alerts a
    WHERE a.status = 'open'
      AND a.severity = 'critical'
      AND a.is_suppressed = false
      AND a.escalated_at IS NULL
      AND a.opened_at <= now() - interval '${ESCALATION_THRESHOLD_MINUTES} minutes'
    ORDER BY a.opened_at ASC
  `);

  if (candidates.length === 0) return 0;

  let escalated = 0;

  for (const alert of candidates) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Atomic claim: only escalate if still not escalated
      const { rowCount } = await client.query(
        `UPDATE alerts
         SET escalated_at = now(), updated_at = now()
         WHERE id = $1 AND escalated_at IS NULL AND status = 'open'`,
        [alert.alert_id]
      );

      if (rowCount === 0) {
        // Already escalated or status changed — skip
        await client.query('COMMIT');
        continue;
      }

      // Find the supervisor for the currently assigned operator
      let supervisorId: string | null = null;
      if (alert.assigned_user_id) {
        const { rows } = await client.query(
          `SELECT supervisor_user_id FROM users WHERE id = $1`,
          [alert.assigned_user_id]
        );
        supervisorId = rows[0]?.supervisor_user_id ?? null;
      }

      // Fallback: find any active supervisor
      if (!supervisorId) {
        const { rows } = await client.query(
          `SELECT id FROM users WHERE role = 'supervisor' AND is_active = true LIMIT 1`
        );
        supervisorId = rows[0]?.id ?? null;
      }

      if (!supervisorId) {
        console.error(`[escalation] No supervisor found for alert ${alert.alert_id}`);
        await client.query('ROLLBACK');
        continue;
      }

      // Reassign alert to supervisor
      await client.query(
        `UPDATE alerts SET assigned_user_id = $2, updated_at = now() WHERE id = $1`,
        [alert.alert_id, supervisorId]
      );

      // Insert escalation log (unique constraint on alert_id prevents dupes)
      await client.query(
        `INSERT INTO escalation_log (alert_id, escalated_from_user_id, escalated_to_user_id, escalated_at, reason)
         VALUES ($1, $2, $3, now(), 'critical_unacknowledged_timeout')
         ON CONFLICT (alert_id) DO NOTHING`,
        [alert.alert_id, alert.assigned_user_id, supervisorId]
      );

      // Event outbox
      await client.query(
        `INSERT INTO event_outbox (topic, zone_id, aggregate_type, aggregate_id, payload, created_at)
         VALUES ('alert.updated', $1, 'alert', $2::text, $3, now())`,
        [alert.zone_id, alert.alert_id, JSON.stringify({
          type: 'alert.escalated',
          data: {
            alert_id: alert.alert_id,
            sensor_id: alert.sensor_id,
            zone_id: alert.zone_id,
            severity: alert.severity,
            escalated_from_user_id: alert.assigned_user_id,
            escalated_to_user_id: supervisorId,
            escalated_at: new Date().toISOString(),
          },
        })]
      );

      await client.query('COMMIT');
      escalated++;
      console.log(`[escalation] Alert ${alert.alert_id} escalated to supervisor ${supervisorId}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[escalation] Error escalating alert ${alert.alert_id}:`, err);
    } finally {
      client.release();
    }
  }

  return escalated;
}

export function startEscalationScheduler(): void {
  console.log('[escalation] Escalation scheduler started (15s interval)');

  const loop = async () => {
    try {
      const count = await escalateAlerts();
      if (count > 0) {
        console.log(`[escalation] Escalated ${count} alerts`);
      }
    } catch (err) {
      console.error('[escalation] Loop error:', err);
    }
    setTimeout(loop, POLL_INTERVAL_MS);
  };

  // Start after a short delay
  setTimeout(loop, 3000);
}
