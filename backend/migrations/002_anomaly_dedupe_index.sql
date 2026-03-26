BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_anomalies_reading_type_metric
  ON anomalies(reading_id, anomaly_type, metric)
  WHERE reading_id IS NOT NULL;

COMMIT;
