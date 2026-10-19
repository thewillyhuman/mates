-- Domain tables of §4.1. The event log is the source of truth; the
-- scalar columns on runs/invocations are caches of the projection kept in
-- step on every append so the board and the reconcile loop can query them.

CREATE TABLE tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker       text NOT NULL DEFAULT 'jira',
  external_key  text NOT NULL,
  external_id   text,
  title         text NOT NULL,
  url           text,
  project_key   text,
  repo_id       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tracker, external_key)
);

CREATE TABLE runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id             uuid NOT NULL REFERENCES tickets (id),
  status                text NOT NULL CHECK (status IN
                          ('queued','intake','implementing','reviewing','mr_ready','blocked','cancelled','failed','done')),
  iteration             int NOT NULL DEFAULT 0,
  max_iterations        int NOT NULL,
  branch                text,
  base_branch           text,
  mr_id                 text,
  mr_url                text,
  mr_state              text CHECK (mr_state IN ('draft','ready','merged','closed')),
  workspace_ref         text,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  budget_usd            numeric,
  budget_tokens         bigint,
  team_context_version  int,
  paused                boolean NOT NULL DEFAULT false
);
-- One active run per ticket (§5.1 item 1).
CREATE UNIQUE INDEX runs_one_active_per_ticket
  ON runs (ticket_id) WHERE status NOT IN ('done','cancelled','failed');
CREATE INDEX runs_status_created_idx ON runs (status, created_at DESC);
CREATE INDEX runs_ticket_id_idx ON runs (ticket_id);

CREATE TABLE invocations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq                int NOT NULL,
  mate               text NOT NULL CHECK (mate IN ('intake','implementer','reviewer')),
  iteration          int NOT NULL,
  status             text NOT NULL CHECK (status IN
                       ('pending','running','succeeded','failed','cancelled','timed_out')),
  k8s_job_name       text NOT NULL,
  pod_name           text,
  model              text NOT NULL,
  attempt            int NOT NULL DEFAULT 0,
  started_at         timestamptz,
  finished_at        timestamptz,
  exit_code          int,
  claude_session_id  text,
  result_json        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE events (
  id             bigserial PRIMARY KEY,
  run_id         uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  invocation_id  uuid REFERENCES invocations (id) ON DELETE SET NULL,
  ts             timestamptz NOT NULL DEFAULT now(),
  type           text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_run_id_id_idx ON events (run_id, id);
CREATE INDEX events_type_ts_idx ON events (type, ts);

CREATE TABLE verdicts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id  uuid NOT NULL REFERENCES invocations (id) ON DELETE CASCADE,
  run_id         uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  iteration      int NOT NULL,
  decision       text NOT NULL CHECK (decision IN ('approve','changes_requested')),
  blocking       jsonb NOT NULL DEFAULT '[]'::jsonb,
  non_blocking   jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary        text NOT NULL DEFAULT '',
  raw            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verdicts_run_id_idx ON verdicts (run_id);

CREATE TABLE nudges (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                      uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  author                      text NOT NULL,
  text                        text NOT NULL,
  post_to_tracker             boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  consumed_by_invocation_id   uuid REFERENCES invocations (id) ON DELETE SET NULL
);
CREATE INDEX nudges_run_id_idx ON nudges (run_id);

CREATE TABLE usage (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id       uuid NOT NULL REFERENCES invocations (id) ON DELETE CASCADE,
  run_id              uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  model               text NOT NULL,
  input_tokens        bigint NOT NULL DEFAULT 0,
  output_tokens       bigint NOT NULL DEFAULT 0,
  cache_read_tokens   bigint NOT NULL DEFAULT 0,
  cache_write_tokens  bigint NOT NULL DEFAULT 0,
  cost_usd_reported   numeric,
  cost_usd_computed   numeric,
  source              text NOT NULL DEFAULT 'claude_code_result',
  ts                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_run_id_idx ON usage (run_id);
CREATE INDEX usage_ts_idx ON usage (ts);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
