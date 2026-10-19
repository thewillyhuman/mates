-- Audit trail of mutating actions (§10.4, decision 0018).
CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,
  action    text NOT NULL,
  target    text NOT NULL DEFAULT '',
  details   jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);
