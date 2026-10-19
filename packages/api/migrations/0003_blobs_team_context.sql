-- Large artefacts (decision 0009), team-context versions (§6.3) and the
-- tracker-side ticket details intake and briefs need.

CREATE TABLE blobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  invocation_id  uuid REFERENCES invocations (id) ON DELETE SET NULL,
  kind           text NOT NULL,
  content_type   text NOT NULL,
  size_bytes     int NOT NULL,
  data           bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blobs_run_id_idx ON blobs (run_id);
CREATE INDEX blobs_kind_created_idx ON blobs (kind, created_at);

CREATE TABLE team_context (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version     int NOT NULL UNIQUE,
  source      text NOT NULL CHECK (source IN ('git', 'upload')),
  ref         text,
  manifest    jsonb,
  errors      jsonb NOT NULL DEFAULT '[]'::jsonb,
  package     bytea NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  active      boolean NOT NULL DEFAULT false,
  created_by  text
);
CREATE UNIQUE INDEX team_context_one_active ON team_context (active) WHERE active;

-- Description, acceptance criteria, comments, links, labels as fetched from the tracker.
ALTER TABLE tickets ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;
