import { pool } from '../db/client.js';
import { broadcastToZone } from '../realtime/wsServer.js';

const POLL_INTERVAL_MS = 500;
const BATCH_SIZE = 100;

async function drainOutbox(): Promise<number> {
  const { rows } = await pool.query(`
    UPDATE event_outbox
    SET published_at = now()
    WHERE id IN (
      SELECT id FROM event_outbox
      WHERE published_at IS NULL
      ORDER BY id ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, topic, zone_id, payload
  `, [BATCH_SIZE]);

  for (const event of rows) {
    if (!event.zone_id) continue;
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    broadcastToZone(event.zone_id, payload);
  }

  return rows.length;
}

export function startOutboxPublisher(): void {
  console.log('[outbox] Outbox publisher started (500ms interval)');
  let isRunning = false;

  setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      let total = 0;
      let batch: number;
      // Drain in batches until empty
      do {
        batch = await drainOutbox();
        total += batch;
      } while (batch === BATCH_SIZE);

      if (total > 0) {
        console.log(`[outbox] Published ${total} events`);
      }
    } catch (err) {
      console.error('[outbox] Publisher error:', err);
    } finally {
      isRunning = false;
    }
  }, POLL_INTERVAL_MS);
}
