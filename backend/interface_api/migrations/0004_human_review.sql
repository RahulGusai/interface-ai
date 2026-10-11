-- Some SQLite versions return 0 for json_valid(SQL NULL), rather than NULL.
-- Optional JSON columns must explicitly allow SQL NULL on every version.
-- The migration runner disables foreign keys on its connection and validates
-- their integrity before committing this table rebuild transaction.
DROP TRIGGER discovery_event_step;

CREATE TABLE runs_v4 (
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
 status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_human','awaiting_finalization','validating','cancelling','completed','failed','cancelled','interrupted')),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 runtime_result_json TEXT CHECK(runtime_result_json IS NULL OR json_valid(runtime_result_json)),
 idempotency_key TEXT UNIQUE, request_sha256 TEXT,
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
 last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_event_sequence>=0),
 access_policy TEXT NOT NULL DEFAULT 'READ_ONLY' CHECK(access_policy IN ('READ_ONLY','READ_WRITE')),
 CHECK(kind!='discovery' OR task IS NOT NULL), CHECK(kind!='replay' OR pinned_artifact_id IS NOT NULL),
 CHECK(purpose!='validation' OR (kind='replay' AND parent_run_id IS NOT NULL))
);
INSERT INTO runs_v4 SELECT * FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v4 RENAME TO runs;

CREATE INDEX runs_created ON runs(created_at,run_id);
CREATE INDEX runs_deployment ON runs(app_deployment_id,status);
CREATE INDEX runs_artifact ON runs(pinned_artifact_id,created_at);
CREATE INDEX runs_parent ON runs(parent_run_id);
CREATE TRIGGER snapshot_immutable BEFORE UPDATE OF deployment_snapshot_json,pinned_artifact_id,artifact_version,artifact_definition_sha256,binding_id,binding_version,binding_snapshot_json ON runs BEGIN SELECT RAISE(ABORT,'run selection is immutable'); END;
CREATE TRIGGER discovery_event_step BEFORE INSERT ON run_events WHEN NEW.step_id IS NOT NULL AND (SELECT kind FROM runs WHERE run_id=NEW.run_id)='discovery' BEGIN SELECT RAISE(ABORT,'discovery step_id must be null'); END;
CREATE TABLE human_review (
 review_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs,
 call_id TEXT NOT NULL, tool TEXT NOT NULL, arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json)),
 assessment_decision TEXT CHECK(assessment_decision IS NULL OR assessment_decision IN ('auto_approve','requires_human_review')),
 confidence REAL CHECK(confidence IS NULL OR (confidence>=0 AND confidence<=1)), reason TEXT NOT NULL,
 access_policy TEXT NOT NULL CHECK(access_policy='READ_WRITE'),
 screenshot_asset_id TEXT NOT NULL REFERENCES evidence_assets, event_sequence INTEGER NOT NULL,
 state_fingerprint TEXT NOT NULL, request_sha256 TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','cancelled')),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, human_comment TEXT,
 FOREIGN KEY(run_id,event_sequence) REFERENCES run_events(run_id,sequence)
);
CREATE UNIQUE INDEX one_pending_review ON human_review(run_id) WHERE status='pending';
CREATE INDEX reviews_queue ON human_review(status,created_at);
