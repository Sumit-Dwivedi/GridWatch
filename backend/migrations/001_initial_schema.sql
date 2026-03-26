BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Access Control
-- ============================================================

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

-- ============================================================
-- Sensors & Rules
-- ============================================================

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

-- ============================================================
-- Ingestion & Processing
-- ============================================================

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

-- ============================================================
-- Sensor State (Dashboard Acceleration)
-- ============================================================

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

-- ============================================================
-- Suppressions
-- ============================================================

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

-- ============================================================
-- Anomalies & Alerts
-- ============================================================

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

-- ============================================================
-- Event Outbox (Reliable Realtime)
-- ============================================================

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

COMMIT;
