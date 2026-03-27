# GridWatch — Real-Time Infrastructure Anomaly Detection

GridWatch monitors power grid sensors in real time, detects anomalies, manages alerts through a defined lifecycle, and pushes state changes to operator dashboards via WebSocket — all with strict zone-based access control.

---

## Setup

### Tech Stack
- **Backend**: Node.js 20 + TypeScript + Express 4
- **Frontend**: React 19 + Vite 6 + Tailwind CSS 4
- **Database**: PostgreSQL 16 (source of truth for all state)
- **Realtime**: WebSocket via `ws` library + event outbox pattern
- **Orchestration**: Docker Compose (4 containers: postgres, redis, backend, frontend)

### One-command startup
```bash
docker-compose up --build
```

### After containers are healthy
```bash
docker-compose exec backend npm run migrate
docker-compose exec backend npm run seed
```

Seed creates ~1.1M readings across 1050 sensors and takes approximately 90 seconds on Docker Desktop.

### Access
| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:4000 |
| WebSocket | ws://localhost:4000/ws |
| Health check | http://localhost:4000/health |

### Seed credentials
| Role | Email | Password | Zone(s) |
|---|---|---|---|
| Supervisor | supervisor@gridwatch.io | supervisor123 | All |
| Operator 1 | operator1@gridwatch.io | operator123 | North |
| Operator 2 | operator2@gridwatch.io | operator123 | South |

---

## Architecture

```
                            ┌─────────────────────────────────────────┐
                            │              Frontend (React)           │
                            │  Dashboard │ Alerts │ Sensor Detail     │
                            │         ▲ WebSocket (zone-scoped)       │
                            └─────────┼──────────────────────────────-┘
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        │                    Backend (Express + WS)                  │
        │                             │                              │
        │  POST /ingest ──►  Single TX: readings + jobs + state      │
        │       │                     │                              │
        │       ▼                     │                              │
        │  ┌──────────┐    ┌─────────┴────────┐                     │
        │  │ Reading   │    │  Outbox Publisher │ (500ms poll)        │
        │  │ Processor │    │  event_outbox ──► WS broadcast         │
        │  │ Worker    │    └──────────────────┘                     │
        │  │ (A + B)   │                                             │
        │  └──────────┘    ┌──────────────────┐                     │
        │                  │ Silence Detector  │ (30s scheduler)     │
        │                  │ Rule C            │                     │
        │                  └──────────────────┘                     │
        │                  ┌──────────────────┐                     │
        │                  │ Escalation Sched  │ (15s scheduler)     │
        │                  └──────────────────┘                     │
        └───────────────────────────┬────────────────────────────────┘
                                    │
                            ┌───────▼───────┐
                            │  PostgreSQL   │
                            │  (all state)  │
                            └───────────────┘
```

### Data Flow

1. **Ingest** (`POST /ingest`): Up to 1000 readings per request. A single transaction inserts the batch record, all readings (with `ON CONFLICT DO NOTHING` for dedup), processing jobs, and updates `sensor_state.last_reading_ts`. Response returns 202 immediately — anomaly detection is fully async.

2. **Anomaly Detection** (Reading Processor Worker): Claims jobs from `reading_processing_jobs` using `FOR UPDATE SKIP LOCKED` for safe concurrent processing. For each reading:
   - **Rule A (Threshold Breach)**: Checks voltage/temperature against per-sensor `sensor_threshold_rules`
   - **Rule B (Rate-of-Change Spike)**: Compares value against average of previous 3 readings; triggers if change exceeds configured percentage in `sensor_spike_rules`
   - A single reading can trigger multiple anomalies across different rules/metrics

3. **Silence Detection** (Rule C — 30s Scheduler): Runs independently of ingest. Queries `sensor_state` for sensors with `last_reading_ts` older than the configured silence threshold (default 2 minutes) and `current_status != 'silent'`. Creates `pattern_absence` anomalies with `reading_id = NULL`.

4. **Alert Creation**: Every anomaly produces an alert. If the sensor has an active suppression window, the anomaly is still recorded but the alert is marked `is_suppressed = true`. Suppressed alerts do not escalate.

5. **Alert Lifecycle**: `open → acknowledged → resolved` or `open → resolved` (direct). No backwards transitions. Every transition appends a row to `alert_transitions` — this table is append-only and rows are never updated or deleted.

6. **Escalation** (15s Scheduler): Finds critical open alerts that have been unacknowledged for >5 minutes. Atomically sets `escalated_at`, reassigns to the operator's supervisor, and inserts into `escalation_log`. The `UNIQUE(alert_id)` constraint on `escalation_log` prevents duplicate escalations at the database level.

7. **Realtime Delivery**: Business logic (workers, schedulers, API handlers) writes events to `event_outbox` within their transactions. The outbox publisher polls every 500ms, claims unpublished events with `FOR UPDATE SKIP LOCKED`, broadcasts to zone-scoped WebSocket connections, and marks them published. This decouples event emission from WebSocket delivery and survives crashes.

8. **Zone Isolation**: Every query that returns data to a user includes a zone filter at the SQL level. Operators' queries include `WHERE zone_id = ANY($zoneIds)`. Supervisors bypass zone filtering. Cross-zone access returns 404 (not 403) to prevent information leakage. WebSocket subscriptions are determined server-side from the JWT — clients cannot subscribe to arbitrary zones.

---

## Schema Decisions

### `sensor_readings` with `UNIQUE(sensor_id, reading_ts)`
Deduplication at the database level. The ingest endpoint uses `ON CONFLICT DO NOTHING` with `RETURNING` to silently skip duplicates and only create processing jobs for genuinely new readings. The descending index `(sensor_id, reading_ts DESC)` accelerates the history endpoint and the "previous 3 readings" lookup for Rule B.

### `reading_processing_jobs` — Durable Async Queue
A database-backed job queue using `FOR UPDATE SKIP LOCKED` for work claiming. Failed jobs stay in `status = 'failed'` with `last_error` for debugging. Jobs that hang (locked > 5 minutes) are automatically reclaimed. This is simpler and more reliable than an external queue for this scale — PostgreSQL is already the bottleneck, not the queue.

### `sensor_state` — Materialized Dashboard View
Pre-computed current status for each sensor: `current_status`, `last_reading_ts`, `latest_open_alert_id`, `is_suppressed`. The dashboard endpoint reads directly from this table with the `idx_sensor_state_zone_status` index, avoiding expensive joins on every request. State is recomputed by workers, schedulers, and API handlers whenever alerts change. The `is_suppressed` flag is a hint — dashboard and detail endpoints verify against `sensor_suppressions` as source of truth.

### `anomalies` Separate from `alerts`
Anomalies are detection facts: "this reading breached this threshold at this time." Alerts are workflow entities: "someone needs to acknowledge and resolve this." Separating them means anomalies are always recorded even when suppressed, and the alert lifecycle doesn't pollute the detection record. The unique index `(reading_id, anomaly_type, metric)` on anomalies ensures idempotent worker retries.

### `alert_transitions` — Append-Only Audit
Every status change appends a row with `from_status`, `to_status`, `changed_by_user_id`, `reason`, and `changed_at`. No rows are ever updated or deleted. This provides a complete forensic trail. The alert table itself stores the current state; transitions store the history.

### `escalation_log` with `UNIQUE(alert_id)`
The unique constraint is the final line of defense for exactly-once escalation. Even if the scheduler query returns the same alert twice (race condition between scheduler runs), the INSERT will fail on the second attempt. Combined with the atomic `UPDATE alerts SET escalated_at = now() WHERE id = $1 AND escalated_at IS NULL`, this provides three-layer protection: query filter, atomic update, unique constraint.

### `event_outbox` — Reliable Event Publishing
Events are written in the same transaction as the business logic that produces them. This guarantees that if the transaction commits, the event will eventually be published. The publisher marks events as published atomically. If the publisher crashes, unpublished events are picked up on the next poll. The `idx_event_outbox_unpublished` partial index keeps the poll query fast regardless of total event count.

---

## Real-Time Design

### WebSocket Server
The `ws` library is attached to the same HTTP server as Express via `http.createServer(app)`. Clients connect to `ws://localhost:4000/ws?token=<jwt>`. On connection:
1. JWT is verified using the same secret as the REST API
2. Invalid or missing token → connection closed with code 4001
3. Operator connections subscribe to their zone channels only
4. Supervisor connections subscribe to all zone channels (fetched from DB)
5. A welcome message confirms the subscription

### Zone-Scoped Broadcasting
An in-memory `Map<zoneId, Set<WebSocket>>` routes events to the correct clients. When the outbox publisher drains an event, it reads the `zone_id` column and calls `broadcastToZone()`. This means:
- Operators only receive events for sensors in their assigned zones
- The server controls subscriptions — clients cannot request other zones
- Supervisors see everything because they're subscribed to all zones

### Event Outbox Pattern
Business logic never touches WebSocket directly. Instead:
1. Worker detects anomaly → writes `alert.created` event to `event_outbox` in the same transaction
2. API handler acknowledges alert → writes `alert.updated` event in the same transaction
3. Outbox publisher (500ms loop) claims unpublished events → broadcasts → marks published

This means events are never lost even if the WebSocket layer is down — they'll be published when it recovers. The tradeoff is ~500ms additional latency on top of processing time.

### Why Not Polling
The assessment explicitly forbids client-side polling. Beyond compliance: WebSocket push delivers state changes in <3 seconds (worker processing + outbox drain), while polling at the same frequency would require 2 requests/second per client — unsustainable at scale.

### Reconnection
The frontend WebSocket hook auto-reconnects after 3 seconds on disconnect. On reconnect, the dashboard re-fetches the full sensor list to catch any events missed during the disconnection window.

### Heartbeat
Server pings every 30 seconds. Connections that don't respond with a pong are terminated — this prevents dead connections from accumulating.

---

## What Finished / What Cut

### Finished
- [x] Durable ingest pipeline — single TX for readings + jobs, 202 response before processing
- [x] Rule A: threshold breach detection (voltage, temperature vs per-sensor min/max)
- [x] Rule B: rate-of-change spike detection (vs average of previous 3 readings)
- [x] Rule C: pattern absence / silence detection (independent 30s scheduler)
- [x] Single reading can trigger multiple anomalies
- [x] Alert lifecycle: open → acknowledged → resolved (no backwards transitions)
- [x] Append-only audit trail in `alert_transitions`
- [x] Auto-escalation with exactly-once guarantee (DB unique constraint)
- [x] Suppression API — create/list suppression windows
- [x] Suppression-aware alerting — anomalies recorded, alerts marked suppressed
- [x] Historical query with anomaly + alert linkage, keyset pagination
- [x] Zone-scoped access control on every API endpoint and WebSocket
- [x] 404 (not 403) for cross-zone access to prevent information leakage
- [x] Push-based realtime dashboard via WebSocket (no polling)
- [x] Event outbox pattern for reliable event delivery
- [x] React dashboard with live sensor status grid and status counts
- [x] Alert management page with acknowledge/resolve actions
- [x] Sensor detail page with readings, alerts, suppression management
- [x] Docker Compose one-command startup
- [x] Seed data: 1050 sensors, 3 zones, ~1.1M readings (48h for 60 sensors, 2h for 990)

### Cut / Simplified
- **Rule configuration UI**: threshold/spike/silence rules are seeded, not editable through the frontend. API endpoints for CRUD on rules were not built.
- **Alert detail page**: alerts are viewed inline in the alerts table; there's no dedicated page showing the full transition history (the API supports it via `GET /alerts/:id`).
- **Charts/graphs**: readings are shown in a table, not plotted. No time-series visualization.
- **Notification toasts**: WebSocket events update state in-place but don't show dismissible notifications.
- **Production auth**: no refresh tokens, no password reset, no session invalidation. JWT has a 24h expiry.
- **Frontend error boundaries**: errors show inline messages, no React error boundary components.
- **Suppression auto-expiry background job**: `sensor_state.is_suppressed` is set when a suppression is created but not automatically cleared when it expires. Dashboard and detail endpoints derive suppression status from `sensor_suppressions` table as source of truth.
- **Search debouncing on dashboard**: search fires on every keystroke rather than after a delay.

---

## Three Hardest Problems

### 1. Durable Async Ingest Under 200ms

The core challenge: the response must confirm data is durable (committed to PostgreSQL) but must not wait for anomaly detection. The solution is a single CTE that inserts the batch record, all readings (via `unnest` arrays — constant parameter count regardless of batch size), creates processing jobs, and updates `sensor_state.last_reading_ts`:

```sql
WITH inserted AS (
  INSERT INTO sensor_readings (...) SELECT * FROM unnest($1::uuid[], $2::timestamptz[], ...)
  ON CONFLICT (sensor_id, reading_ts) DO NOTHING RETURNING id, sensor_id, reading_ts
),
jobs AS (
  INSERT INTO reading_processing_jobs (reading_id, status) SELECT id, 'queued' FROM inserted
),
state_update AS (
  UPDATE sensor_state SET last_reading_ts = ... FROM (SELECT DISTINCT ON ...) ...
)
SELECT count(*)::int AS queued_count FROM inserted
```

One round trip, one transaction, constant parameter count. The initial approach of three separate queries took ~950ms for 500 readings. The CTE approach brings it under 200ms. Deduplication happens in the same query via `ON CONFLICT DO NOTHING` — the `RETURNING` clause only returns genuinely new readings, so duplicate readings don't create processing jobs.

### 2. Exactly-Once Escalation

The escalation scheduler runs every 15 seconds. Without protection, concurrent or overlapping runs could escalate the same alert twice. Three layers prevent this:

1. **Query filter**: `WHERE status = 'open' AND severity = 'critical' AND escalated_at IS NULL AND opened_at <= now() - interval '5 minutes'` — only finds unescalated alerts
2. **Atomic UPDATE**: `UPDATE alerts SET escalated_at = now() WHERE id = $1 AND escalated_at IS NULL` — the `WHERE escalated_at IS NULL` guard means only the first UPDATE succeeds; if `RETURNING` gives no row, the alert was already claimed
3. **Unique constraint**: `UNIQUE(alert_id)` on `escalation_log` — even if the UPDATE somehow succeeds twice (shouldn't happen, but defense in depth), the INSERT will fail

The escalation also naturally doesn't fire if the alert is acknowledged before the 5-minute mark — the `WHERE status = 'open'` filter excludes it.

### 3. Zone Isolation Across API and Realtime

Zone isolation must hold everywhere: REST API queries, WebSocket event delivery, and single-resource lookups. The implementation:

- **List queries**: operators always have `AND zone_id = ANY($zoneIds)` in the WHERE clause. If an operator passes a `zone_id` filter parameter, it's intersected with their allowed zones — requesting a zone they don't own returns zero rows, not an error.
- **Single-resource lookups**: `GET /sensors/:id`, `GET /alerts/:id`, etc. all include the zone check in the query. If the resource exists but belongs to another zone, the query returns no rows, and the API returns 404. This prevents operators from even confirming the existence of cross-zone resources.
- **WebSocket**: subscriptions are determined server-side from the JWT. The server maintains `Map<zoneId, Set<WebSocket>>`. Events include a `zone_id` and are only broadcast to connections subscribed to that zone. There is no client-side mechanism to subscribe to zones.
- **Supervisors**: bypass zone filtering entirely. They're subscribed to all WebSocket zone channels and their queries have no zone constraint.

---

## Production Gap: Time Partitioning for `sensor_readings`

With 1050 sensors producing readings every 10 seconds, `sensor_readings` grows by ~9M rows/day. Within a month, the table exceeds 270M rows. At this scale:

- Index maintenance on `(sensor_id, reading_ts)` becomes expensive for writes
- The history query degrades because the B-tree index spans all time
- No practical way to age out old data without locking the table

**Solution**: PostgreSQL declarative partitioning by month on `reading_ts`:

```sql
CREATE TABLE sensor_readings (...) PARTITION BY RANGE (reading_ts);
CREATE TABLE sensor_readings_2026_03 PARTITION OF sensor_readings
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
```

Each partition gets its own local indexes, keeping index sizes bounded. Retention becomes `DROP TABLE sensor_readings_2025_12` — instant, no vacuum. The history query benefits because PostgreSQL prunes partitions outside the requested `from`/`to` range.

A background job would create future partitions before they're needed (`pg_partman` or a simple scheduler). This is the single highest-impact change for production readiness — it addresses write performance, read performance, and operational maintenance simultaneously.

Additional production improvements worth noting:
- **Redis pub/sub for horizontal WebSocket scaling**: the current in-memory `Map<zoneId, Set<WebSocket>>` limits to a single backend instance. Publishing events to Redis channels and subscribing from each instance would allow multiple backend replicas.
- **Structured logging + OpenTelemetry**: replace `console.log` with structured JSON logs and add trace IDs for correlating ingest → worker → outbox → WebSocket delivery.
- **Dead letter queue**: failed processing jobs (attempts >= 3) should be moved to a dead letter table with alerting, rather than staying in `reading_processing_jobs` with `status = 'failed'`.

---

## Suppression Handling Decision

**When a suppression is created while an alert is already open, existing open alerts remain unchanged.** Suppression only applies to future anomalies and alerts generated during the suppression window.

This means:
- Creating a suppression does NOT auto-resolve or auto-suppress existing open alerts
- Anomalies detected during the suppression window are still recorded in the `anomalies` table with `suppression_applied = true`
- Alerts created for those anomalies are marked `is_suppressed = true` and do not trigger escalation
- After the suppression window expires, new anomalies produce normal (non-suppressed) alerts

**Why this approach**: auto-resolving existing alerts on suppression creation would be destructive — the operator might not realize that legitimate alerts were silently resolved. Keeping existing alerts untouched means the operator must explicitly acknowledge/resolve them, maintaining audit trail integrity. The suppression's effect is purely forward-looking, which is simpler to reason about and audit.

The `sensor_state.is_suppressed` flag is updated when a suppression is created but not automatically cleared on expiry. Dashboard and sensor detail endpoints derive the current suppression status from `sensor_suppressions` table directly (`WHERE start_time <= now() AND end_time > now()`), ensuring correctness even without a background cleanup job.
