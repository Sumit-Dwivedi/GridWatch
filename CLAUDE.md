# claude.md

## Purpose
Operating guide for building **GridWatch** — a real-time infrastructure anomaly detection platform. This is the ONLY skill file. All schema, API, architecture, and README guidance is consolidated here. Do not look for separate files.

## Stack
- Backend: Node.js + TypeScript + Express
- Frontend: React + Vite + Tailwind CSS + Shadcn UI
- Database: PostgreSQL 16 (source of truth)
- Optional: Redis 7 (pub/sub only — never for correctness-critical state)
- Orchestration: Docker Compose

## Non-Negotiable Rules
1. **Correctness over polish** — cut UI before cutting backend correctness
2. **Durability before ack** — readings committed to PostgreSQL before `/ingest` returns
3. **Async downstream** — anomaly detection never blocks ingest response
4. **Recoverability** — failed processing stays queued and retryable, never silently dropped
5. **Data-layer zone isolation** — operators filtered at SQL level, not just UI/route
6. **Push-based realtime** — WebSocket, never polling
7. **Exactly-once escalation** — enforced by DB unique constraint
8. **Append-only audit** — `alert_transitions` and `escalation_log` rows never updated or deleted

---

# ASSESSMENT REQUIREMENTS

## 1. Ingest Pipeline
- `POST /ingest` — up to 1000 readings per request
- Each reading: `sensor_id`, `timestamp`, `voltage`, `current`, `temperature`, `status_code`
- Response ≤ 200ms regardless of downstream processing
- Sustain 10,000 readings/minute without data loss
- Durable before response, async processing after
- Duplicate readings deduplicated by `(sensor_id, timestamp)` unique constraint

## 2. Anomaly Detection
**Rule A — Threshold Breach**: voltage or temperature outside per-sensor configurable min/max.
**Rule B — Rate-of-Change Spike**: value changed >X% vs average of previous 3 readings. Configurable per sensor.
**Rule C — Pattern Absence**: sensor silent >2 minutes. Must run independently of ingest — a scheduler, not triggered by data arrival.

- Rules A+B run in async workers consuming a job queue
- Rule C runs in a separate 30-second scheduler loop
- Single reading can trigger multiple anomalies
- Suppressed sensors still record anomalies

## 3. Alert Management
Every anomaly produces an alert (suppressed anomalies produce suppressed alerts).
- Statuses: `open` → `acknowledged` → `resolved`
- Also allowed: `open` → `resolved` (direct)
- No backwards transitions
- Severity: `warning` or `critical` from rule config
- Append-only `alert_transitions` log: actor, from_status, to_status, timestamp, reason
- No row in audit table ever updated or deleted

## 4. Auto-Escalation
- Critical alert open (not acknowledged) > 5 minutes → auto-escalate
- Reassign to operator's supervisor
- Write to `escalation_log` table
- `unique(alert_id)` on escalation_log — exactly once at DB level
- Must fire within 30s of the 5-minute mark
- If acknowledged before 5 min, escalation naturally won't fire

## 5. Zone Isolation
- Operators see only their assigned zone(s) sensors, readings, alerts, events
- Supervisors see all zones
- Enforced at query/repository layer — every query accepts `{ userId, role, zoneIds }` context
- Also applies to WebSocket event delivery
- Return 404 (not 403) for operator accessing other zone's resource

## 6. Live Dashboard
- Sensor states: `healthy`, `warning`, `critical`, `silent`
- State changes reach dashboard ≤ 3 seconds
- No client-side polling — WebSocket push
- Zone isolation applies to realtime events

## 7. Suppression
- Time window: `start_time`, `end_time`
- During suppression: anomalies still detected and recorded
- Alerts still created but marked `is_suppressed = true`
- Suppressed alerts don't escalate
- **Decision on open alerts**: existing open alerts remain unchanged; suppression only applies to future anomalies/alerts during the window

## 8. Historical Query
- `GET /sensors/:sensorId/history?from=&to=&limit=&cursor=`
- Returns readings + anomaly flags + alert linkage per reading
- Paginated, default 100
- ≤ 300ms on 30 days of data for one sensor

## Performance Benchmarks
| Endpoint | Target |
|---|---|
| `POST /ingest` (500 batch) | ≤ 200ms |
| `GET /sensors/:id/history` (30 days) | ≤ 300ms |
| `GET /alerts` (paginated, filtered) | ≤ 150ms |
| Sensor state → dashboard | ≤ 3 seconds |
| Escalation timer | Within 30s of 5-min mark |
| Silence detection | Within 60s of 2-min mark |

---

# DATABASE SCHEMA

All tables below. Use `timestamptz` everywhere. UUIDs for entity IDs, `bigserial` for high-volume tables.

## Access Control

```sql
CREATE TABLE zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operator', 'supervisor')),
  supervisor_user_id UUID REFERENCES users(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_zone_assignments (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zone_id UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, zone_id)
);
```

## Sensors & Rules

```sql
CREATE TABLE sensors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_key TEXT UNIQUE NOT NULL,
  zone_id UUID NOT NULL REFERENCES zones(id),
  name TEXT NOT NULL,
  substation_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  installed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sensors_zone_id ON sensors(zone_id);
CREATE INDEX idx_sensors_external_key ON sensors(external_key);

CREATE TABLE sensor_threshold_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id UUID NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  min_voltage NUMERIC(12,4),
  max_voltage NUMERIC(12,4),
  min_temperature NUMERIC(12,4),
  max_temperature NUMERIC(12,4),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by_user_id UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sensor_id)
);

CREATE TABLE sensor_spike_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id UUID NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('voltage', 'current', 'temperature')),
  spike_pct NUMERIC(8,4) NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by_user_id UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sensor_id, metric)
);

CREATE TABLE sensor_silence_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id UUID NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  silence_after_seconds INTEGER NOT NULL DEFAULT 120,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by_user_id UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sensor_id)
);
```

## Ingestion & Processing

```sql
CREATE TABLE ingest_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reading_count INTEGER NOT NULL,
  request_id TEXT,
  status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'processing', 'processed', 'partially_failed', 'failed'))
);

CREATE TABLE sensor_readings (
  id BIGSERIAL PRIMARY KEY,
  sensor_id UUID NOT NULL REFERENCES sensors(id),
  reading_ts TIMESTAMPTZ NOT NULL,
  voltage NUMERIC(12,4) NOT NULL,
  current_val NUMERIC(12,4) NOT NULL,
  temperature NUMERIC(12,4) NOT NULL,
  status_code TEXT NOT NULL,
  ingest_batch_id UUID NOT NULL REFERENCES ingest_batches(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_sensor_readings_sensor_ts ON sensor_readings(sensor_id, reading_ts);
CREATE INDEX idx_sensor_readings_sensor_ts_desc ON sensor_readings(sensor_id, reading_ts DESC);
CREATE INDEX idx_sensor_readings_batch ON sensor_readings(ingest_batch_id);

CREATE TABLE reading_processing_jobs (
  id BIGSERIAL PRIMARY KEY,
  reading_id BIGINT NOT NULL REFERENCES sensor_readings(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  lock_token UUID,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reading_jobs_available ON reading_processing_jobs(status, available_at, id)
  WHERE status = 'queued';
```

## Sensor State (Dashboard Acceleration)

```sql
CREATE TABLE sensor_state (
  sensor_id UUID PRIMARY KEY REFERENCES sensors(id) ON DELETE CASCADE,
  zone_id UUID NOT NULL REFERENCES zones(id),
  last_reading_id BIGINT,
  last_reading_ts TIMESTAMPTZ,
  current_status TEXT NOT NULL DEFAULT 'healthy'
    CHECK (current_status IN ('healthy', 'warning', 'critical', 'silent')),
  latest_open_alert_id BIGINT,
  latest_severity TEXT CHECK (latest_severity IN ('warning', 'critical')),
  is_suppressed BOOLEAN NOT NULL DEFAULT false,
  active_suppression_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sensor_state_zone_status ON sensor_state(zone_id, current_status, updated_at DESC);
```

## Suppressions

```sql
CREATE TABLE sensor_suppressions (
  id BIGSERIAL PRIMARY KEY,
  sensor_id UUID NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  zone_id UUID NOT NULL REFERENCES zones(id),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);
CREATE INDEX idx_suppressions_sensor_window ON sensor_suppressions(sensor_id, start_time, end_time);
CREATE INDEX idx_suppressions_zone_window ON sensor_suppressions(zone_id, start_time, end_time);
```

## Anomalies & Alerts

```sql
CREATE TABLE anomalies (
  id BIGSERIAL PRIMARY KEY,
  sensor_id UUID NOT NULL REFERENCES sensors(id),
  reading_id BIGINT REFERENCES sensor_readings(id),
  anomaly_type TEXT NOT NULL
    CHECK (anomaly_type IN ('threshold_breach', 'rate_of_change_spike', 'pattern_absence')),
  metric TEXT CHECK (metric IN ('voltage', 'current', 'temperature')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  suppression_applied BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_anomalies_sensor_detected ON anomalies(sensor_id, detected_at DESC);
CREATE INDEX idx_anomalies_reading_id ON anomalies(reading_id) WHERE reading_id IS NOT NULL;

CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY,
  anomaly_id BIGINT NOT NULL UNIQUE REFERENCES anomalies(id),
  sensor_id UUID NOT NULL REFERENCES sensors(id),
  zone_id UUID NOT NULL REFERENCES zones(id),
  assigned_user_id UUID REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  is_suppressed BOOLEAN NOT NULL DEFAULT false,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alerts_zone_status_opened ON alerts(zone_id, status, opened_at DESC);
CREATE INDEX idx_alerts_assigned_status ON alerts(assigned_user_id, status, opened_at DESC);
CREATE INDEX idx_alerts_sensor_opened ON alerts(sensor_id, opened_at DESC);
CREATE INDEX idx_alerts_escalation_candidates ON alerts(status, severity, opened_at)
  WHERE status = 'open' AND severity = 'critical' AND escalated_at IS NULL AND is_suppressed = false;

CREATE TABLE alert_transitions (
  id BIGSERIAL PRIMARY KEY,
  alert_id BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  from_status TEXT CHECK (from_status IN ('open', 'acknowledged', 'resolved')),
  to_status TEXT NOT NULL CHECK (to_status IN ('open', 'acknowledged', 'resolved')),
  changed_by_user_id UUID REFERENCES users(id),
  reason TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alert_transitions_alert ON alert_transitions(alert_id, changed_at DESC);

CREATE TABLE escalation_log (
  id BIGSERIAL PRIMARY KEY,
  alert_id BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  escalated_from_user_id UUID REFERENCES users(id),
  escalated_to_user_id UUID NOT NULL REFERENCES users(id),
  escalated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL DEFAULT 'critical_unacknowledged_timeout',
  UNIQUE(alert_id)
);
```

## Event Outbox (Reliable Realtime)

```sql
CREATE TABLE event_outbox (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  zone_id UUID REFERENCES zones(id),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX idx_event_outbox_unpublished ON event_outbox(id) WHERE published_at IS NULL;
```

---

# API CONTRACT

## Response Format
```json
{ "data": {}, "meta": {}, "error": null }
```
Errors: `{ "data": null, "error": { "code": "...", "message": "..." } }`

## Authentication
- `POST /auth/login` — email + password → JWT `{ userId, role, zoneIds }`
- `GET /auth/me` — returns current user from JWT
- JWT in `Authorization: Bearer <token>` header

## Endpoints

### `POST /ingest` → 202
Request: `{ request_id?, readings: [{ sensor_id, timestamp, voltage, current, temperature, status_code }] }`
Response: `{ data: { ingest_batch_id, accepted_count, queued_count } }`
Single transaction: insert batch + readings + processing jobs. Return immediately.

### `GET /dashboard/sensors`
Zone-filtered current sensor states from `sensor_state` table.
Params: `zone_id?`, `status?`, `search?`, `limit?`, `cursor?`

### `GET /sensors/:sensorId`
Sensor detail + current state + active alerts + suppression status. Zone check.

### `GET /sensors/:sensorId/history`
Params: `from` (required), `to` (required), `limit?` (default 100), `cursor?`
Returns readings with anomaly/alert linkage. Zone check.

### `GET /alerts`
Zone-filtered, paginated alerts.
Params: `status?`, `severity?`, `zone_id?`, `sensor_id?`, `is_suppressed?`, `limit?`, `cursor?`

### `GET /alerts/:alertId`
Alert with transition history. Zone check.

### `POST /alerts/:alertId/acknowledge`
Body: `{ reason? }`. Transition: `open → acknowledged`. Invalid → 409.

### `POST /alerts/:alertId/resolve`
Body: `{ reason? }`. Transition: `open|acknowledged → resolved`. Invalid → 409.

### `POST /sensors/:sensorId/suppressions`
Body: `{ start_time, end_time, note? }`. Zone check. Creates suppression window.

### `GET /sensors/:sensorId/suppressions`
Returns suppression windows for sensor. Zone check.

### WebSocket `/ws`
Auth via token. Server subscribes connection to user's zone channels only.
Events: `sensor.state.changed`, `alert.created`, `alert.updated`, `suppression.updated`

---

# WORKER & SCHEDULER CONTRACTS

## Reading Processing Worker (Rules A + B)
1. Claim queued jobs: `SELECT ... FROM reading_processing_jobs WHERE status='queued' ... FOR UPDATE SKIP LOCKED`
2. Load reading + sensor rules
3. Rule A: check voltage/temperature against threshold rules
4. Rule B: fetch previous 3 readings, compute average, check spike %
5. Insert anomaly records (dedupe with ON CONFLICT)
6. Check suppression status at anomaly time
7. Create alerts (marked suppressed if applicable)
8. Update `sensor_state` — derive: silent > critical > warning > healthy
9. Insert event into `event_outbox` if state changed
10. Mark job done

Idempotency: unique on `(reading_id, anomaly_type, metric)` or ON CONFLICT DO NOTHING.

## Silence Detector (Rule C) — runs every 30 seconds
1. Query `sensor_state WHERE last_reading_ts < now() - interval '2 minutes' AND current_status != 'silent'`
2. For each: check no active silence anomaly already exists
3. Create `pattern_absence` anomaly (reading_id = NULL)
4. Create alert (suppressed if in window)
5. Update `sensor_state.current_status = 'silent'`
6. Insert event into `event_outbox`

## Escalation Scheduler — runs every 15 seconds
1. Query: `alerts WHERE status='open' AND severity='critical' AND is_suppressed=false AND escalated_at IS NULL AND opened_at <= now() - interval '5 minutes'`
2. For each (in transaction): atomic UPDATE `SET escalated_at=now(), assigned_user_id=$supervisor WHERE escalated_at IS NULL`
3. INSERT into `escalation_log` (unique constraint prevents dupes)
4. Insert event into `event_outbox`

## Event Outbox Publisher — runs every 500ms
1. `SELECT FROM event_outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`
2. Broadcast to zone-scoped WebSocket connections
3. `UPDATE event_outbox SET published_at = now()`

---

# PROJECT STRUCTURE

```
gridwatch/
├── docker-compose.yml
├── .env.example
├── README.md
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── migrations/
│   │   └── 001_initial_schema.sql    (single file with full schema)
│   ├── seeds/
│   │   └── seed.ts
│   └── src/
│       ├── index.ts                   (Express + WS server entry)
│       ├── config.ts
│       ├── db/
│       │   └── client.ts              (pg Pool)
│       ├── middleware/
│       │   ├── auth.ts                (JWT verify → req.user)
│       │   └── errorHandler.ts
│       ├── modules/
│       │   ├── auth/
│       │   │   ├── auth.routes.ts
│       │   │   └── auth.service.ts
│       │   ├── ingest/
│       │   │   ├── ingest.routes.ts
│       │   │   ├── ingest.service.ts
│       │   │   └── ingest.schema.ts   (Zod)
│       │   ├── sensors/
│       │   │   ├── sensors.routes.ts
│       │   │   └── sensors.service.ts
│       │   ├── alerts/
│       │   │   ├── alerts.routes.ts
│       │   │   └── alerts.service.ts
│       │   ├── suppressions/
│       │   │   ├── suppressions.routes.ts
│       │   │   └── suppressions.service.ts
│       │   ├── history/
│       │   │   ├── history.routes.ts
│       │   │   └── history.service.ts
│       │   └── dashboard/
│       │       ├── dashboard.routes.ts
│       │       └── dashboard.service.ts
│       ├── workers/
│       │   ├── readingProcessor.ts     (Rule A+B)
│       │   └── outboxPublisher.ts
│       ├── scheduler/
│       │   ├── silenceDetector.ts      (Rule C)
│       │   └── escalationScheduler.ts
│       ├── realtime/
│       │   └── wsServer.ts
│       └── shared/
│           ├── types.ts
│           ├── errors.ts
│           └── response.ts
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── lib/
│       │   ├── api.ts
│       │   └── ws.ts
│       ├── hooks/
│       │   ├── useAuth.ts
│       │   └── useWebSocket.ts
│       ├── context/
│       │   └── AuthContext.tsx
│       ├── components/
│       │   ├── Layout.tsx
│       │   └── StatusBadge.tsx
│       └── features/
│           ├── auth/LoginPage.tsx
│           ├── dashboard/DashboardPage.tsx
│           ├── alerts/AlertsPage.tsx
│           └── sensors/SensorDetailPage.tsx
```

---

# SEED DATA

- 3 zones: North, South, Central
- 3 users:
  - `supervisor@gridwatch.io` / `supervisor123` — supervisor, all zones
  - `operator1@gridwatch.io` / `operator123` — operator, zone: North
  - `operator2@gridwatch.io` / `operator123` — operator, zone: South
- 1000+ sensors: ~340 per zone with substation names
- Default rules for all sensors (threshold + spike + silence)
- Readings: full 48h for 60 representative sensors (10s interval), last 2h for remaining 940
- Pre-seeded: a few open alerts, one acknowledged alert, one active suppression
- `sensor_state` populated for all sensors

---

# IMPLEMENTATION PHASES

Build in this exact order. Each phase prompt to Claude Code should reference only the relevant section above.

## Phase 1: Scaffolding + Docker
- Create project structure
- docker-compose.yml (postgres, redis, backend, frontend)
- Backend: Express + TypeScript + pg pool setup
- Frontend: Vite + React + Tailwind + Shadcn setup
- Health check endpoint
- Goal: `docker-compose up` boots everything

## Phase 2: Schema + Migrations + Seed
- Single migration file with full schema from above
- Seed script with all data above
- `npm run migrate` and `npm run seed` commands
- Goal: database ready with realistic data

## Phase 3: Auth
- `POST /auth/login` — bcrypt verify → JWT
- `GET /auth/me`
- Auth middleware extracting `{ userId, role, zoneIds }` to `req.user`
- Goal: protected routes work

## Phase 4: Ingest Pipeline
- `POST /ingest` with Zod validation
- Single transaction: batch + readings + processing jobs
- Bulk insert, dedup on `(sensor_id, reading_ts)`
- Return 202 immediately
- Goal: 500-reading batch in <200ms, durable

## Phase 5: Anomaly Workers (Rules A + B)
- Worker loop claiming jobs with `FOR UPDATE SKIP LOCKED`
- Rule A: threshold check
- Rule B: rate-of-change vs previous 3
- Create anomalies + alerts (suppression-aware)
- Update `sensor_state`
- Insert events into `event_outbox`
- Goal: ingested readings produce correct anomalies and alerts

## Phase 6: Silence Detector (Rule C)
- Scheduler every 30s
- Detect sensors with `last_reading_ts < now() - 2min` and `current_status != 'silent'`
- Create absence anomaly + alert
- Update sensor_state to silent
- Insert outbox event
- Goal: silence detected within 60s of 2-min mark, no duplicates

## Phase 7: Escalation Scheduler
- Scheduler every 15s
- Find critical open unacknowledged alerts older than 5 min
- Atomic escalate: update alert + insert escalation_log
- Unique constraint prevents dupes
- Goal: escalates within 30s of 5-min mark, exactly once

## Phase 8: Alert Lifecycle API
- `GET /alerts` — zone-filtered, paginated, indexed
- `GET /alerts/:alertId` — with transitions
- `POST /alerts/:alertId/acknowledge` — open→ack only
- `POST /alerts/:alertId/resolve` — open|ack→resolved only
- Append-only audit in `alert_transitions`
- Recompute sensor_state on resolution
- Goal: correct transitions, no backwards, audit logged

## Phase 9: Suppression + History + Dashboard APIs
- `POST /sensors/:sensorId/suppressions`
- `GET /sensors/:sensorId/suppressions`
- `GET /sensors/:sensorId/history` — readings + anomaly/alert join, paginated
- `GET /dashboard/sensors` — from sensor_state, zone-filtered
- `GET /sensors/:sensorId` — detail with state, alerts, suppression
- Goal: all API endpoints working with zone isolation

## Phase 10: WebSocket Realtime
- WS server on `/ws`, auth via token
- Zone-scoped channel subscriptions
- Outbox publisher loop (500ms) → broadcast to matching connections
- Events: sensor.state.changed, alert.created, alert.updated
- Goal: state changes reach client in <3s, zone-isolated

## Phase 11: React Frontend
- Login page
- Live dashboard: sensor grid with status badges, zone filter, WS updates
- Alert panel: list with ack/resolve actions, severity badges
- Sensor detail: readings, anomalies, suppression, create suppression form
- All zone-scoped, no polling
- Goal: operational UI reflecting backend correctness

## Phase 12: Testing + README
- Manual verification of all benchmarks
- Fill README with: setup, architecture, schema decisions, realtime design, finished/cut, 3 hardest problems, production gap, suppression decision
- Goal: reviewer can run, understand, and question the system

---

# REVIEW CHECKLIST

Before declaring done:
- [ ] `docker-compose up` works on clean machine
- [ ] `npm run migrate` + `npm run seed` populates DB
- [ ] Ingest stores durably before response, <200ms
- [ ] Ingest does NOT wait for anomaly processing
- [ ] Failed jobs remain recoverable in DB
- [ ] Rules A+B create correct anomalies
- [ ] Rule C detects silence independently of ingest
- [ ] Single reading can trigger multiple anomalies
- [ ] Suppressed anomalies recorded, alerts marked suppressed
- [ ] Alert transitions enforce valid lifecycle only
- [ ] Audit trail is append-only
- [ ] Escalation fires once and only once (DB unique constraint)
- [ ] Ack before 5 min prevents escalation
- [ ] Dashboard updates via WebSocket, not polling
- [ ] Operators see only their zones in API and WS
- [ ] Supervisor sees all zones
- [ ] History returns readings + anomaly flags + alert linkage, <300ms
- [ ] README has all required sections

---

# README TEMPLATE

The README must contain these sections (fill during Phase 12):
1. **Setup** — `docker-compose up`, seed credentials, npm commands
2. **Architecture** — data flow from ingest → worker → anomaly → alert → realtime → dashboard
3. **Schema Decisions** — justify tables, indexes, constraints
4. **Real-Time Design** — WebSocket + event outbox + zone isolation
5. **What Finished / What Cut** — explicit and honest
6. **Three Hardest Problems** — e.g., durable async ingest, exactly-once escalation, zone isolation
7. **Production Gap** — one serious improvement (e.g., partitioning, RLS, outbox pattern, observability)
8. **Suppression Decision** — behavior when suppression created while alert already open

---

# CODING RULES

## Backend
- TypeScript strict mode
- Service/repository separation — services handle business logic, repositories handle SQL
- Transactional logic in services
- DB constraints for correctness (unique, check, FK)
- Idempotent workers — retries safe
- Log failures with context for replay

## Frontend
- React with feature-based grouping
- Tailwind + Shadcn UI for speed
- No client-side polling — WebSocket only for live data
- Server-driven state after mutations

## What NOT to waste time on
- Over-abstracted domain frameworks
- Microservices architecture
- Fancy auth providers (seed login is enough)
- Complex charts or visualizations
- Over-designed component system