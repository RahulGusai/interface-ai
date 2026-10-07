-- Some SQLite versions return 0 for json_valid(SQL NULL), rather than NULL.
-- Optional JSON columns must explicitly allow SQL NULL on every version.
-- The migration runner disables foreign keys on its connection and validates
-- their integrity before committing this table rebuild transaction.
DROP TRIGGER discovery_event_step;

CREATE TABLE runs_v2 (
 run_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('discovery','replay')),
 purpose TEXT NOT NULL CHECK(purpose IN ('user','validation')),
 app_deployment_id TEXT NOT NULL REFERENCES app_deployments,
 deployment_snapshot_json TEXT NOT NULL CHECK(json_valid(deployment_snapshot_json)),
 capability_id TEXT REFERENCES capabilities, pinned_artifact_id TEXT REFERENCES artifacts,
 artifact_version INTEGER, artifact_definition_sha256 TEXT,
 selection_source TEXT NOT NULL CHECK(selection_source IN ('discovery','binding','explicit_artifact','validation')),
 binding_id TEXT REFERENCES capability_bindings, binding_version INTEGER,
 binding_snapshot_json TEXT CHECK(binding_snapshot_json IS NULL OR json_valid(binding_snapshot_json)), parent_run_id TEXT REFERENCES runs,
 finalized_artifact_id TEXT REFERENCES artifacts, task TEXT,
 inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
 status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_finalization','validating','cancelling','completed','failed','cancelled','interrupted')),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 runtime_result_json TEXT CHECK(runtime_result_json IS NULL OR json_valid(runtime_result_json)),
 idempotency_key TEXT UNIQUE, request_sha256 TEXT,
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
 last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_event_sequence>=0),
 CHECK(kind!='discovery' OR task IS NOT NULL), CHECK(kind!='replay' OR pinned_artifact_id IS NOT NULL),
 CHECK(purpose!='validation' OR (kind='replay' AND parent_run_id IS NOT NULL))
);
INSERT INTO runs_v2 SELECT * FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v2 RENAME TO runs;

CREATE TABLE artifacts_v2 (
 artifact_id TEXT PRIMARY KEY, source_run_id TEXT NOT NULL UNIQUE REFERENCES runs,
 capability_id TEXT REFERENCES capabilities, version INTEGER CHECK(version>=1),
 schema_version INTEGER NOT NULL, tool_contract_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('draft','validating','validation_failed','published')),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
 capability_proposal_json TEXT CHECK(capability_proposal_json IS NULL OR json_valid(capability_proposal_json)),
 definition_sha256 TEXT NOT NULL, validated_run_id TEXT REFERENCES runs,
 created_at TEXT NOT NULL, published_at TEXT, UNIQUE(capability_id,version),
 CHECK(state!='published' OR (capability_id IS NOT NULL AND version IS NOT NULL AND validated_run_id IS NOT NULL AND published_at IS NOT NULL))
);
INSERT INTO artifacts_v2 SELECT * FROM artifacts;
DROP TABLE artifacts;
ALTER TABLE artifacts_v2 RENAME TO artifacts;

CREATE INDEX runs_created ON runs(created_at,run_id);
CREATE INDEX runs_deployment ON runs(app_deployment_id,status);
CREATE INDEX runs_artifact ON runs(pinned_artifact_id,created_at);
CREATE INDEX runs_parent ON runs(parent_run_id);
CREATE INDEX artifacts_capability ON artifacts(capability_id,version);
CREATE TRIGGER published_artifact_immutable BEFORE UPDATE ON artifacts WHEN OLD.state='published' BEGIN SELECT RAISE(ABORT,'published artifact is immutable'); END;
CREATE TRIGGER frozen_definition_immutable BEFORE UPDATE OF definition_json,definition_sha256 ON artifacts WHEN OLD.state IN ('validating','validation_failed') BEGIN SELECT RAISE(ABORT,'validated definition is immutable'); END;
CREATE TRIGGER snapshot_immutable BEFORE UPDATE OF deployment_snapshot_json,pinned_artifact_id,artifact_version,artifact_definition_sha256,binding_id,binding_version,binding_snapshot_json ON runs BEGIN SELECT RAISE(ABORT,'run selection is immutable'); END;
CREATE TRIGGER discovery_event_step BEFORE INSERT ON run_events WHEN NEW.step_id IS NOT NULL AND (SELECT kind FROM runs WHERE run_id=NEW.run_id)='discovery' BEGIN SELECT RAISE(ABORT,'discovery step_id must be null'); END;
