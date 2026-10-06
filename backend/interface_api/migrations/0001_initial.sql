CREATE TABLE capabilities (
 capability_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
 input_schema_json TEXT NOT NULL CHECK(json_valid(input_schema_json)),
 output_schema_json TEXT NOT NULL CHECK(json_valid(output_schema_json)), created_at TEXT NOT NULL
);
CREATE TABLE app_deployments (
 app_deployment_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, product_id TEXT NOT NULL,
 base_url TEXT NOT NULL, environment TEXT NOT NULL, ui_variant TEXT NOT NULL, vendor_release TEXT,
 config_version INTEGER NOT NULL CHECK(config_version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE runs (
 run_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('discovery','replay')),
 purpose TEXT NOT NULL CHECK(purpose IN ('user','validation')),
 app_deployment_id TEXT NOT NULL REFERENCES app_deployments,
 deployment_snapshot_json TEXT NOT NULL CHECK(json_valid(deployment_snapshot_json)),
 capability_id TEXT REFERENCES capabilities, pinned_artifact_id TEXT REFERENCES artifacts,
 artifact_version INTEGER, artifact_definition_sha256 TEXT,
 selection_source TEXT NOT NULL CHECK(selection_source IN ('discovery','binding','explicit_artifact','validation')),
 binding_id TEXT REFERENCES capability_bindings, binding_version INTEGER,
 binding_snapshot_json TEXT CHECK(json_valid(binding_snapshot_json)), parent_run_id TEXT REFERENCES runs,
 finalized_artifact_id TEXT REFERENCES artifacts, task TEXT,
 inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)),
 status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_finalization','validating','cancelling','completed','failed','cancelled','interrupted')),
 result_json TEXT CHECK(json_valid(result_json)), runtime_result_json TEXT CHECK(json_valid(runtime_result_json)),
 idempotency_key TEXT UNIQUE, request_sha256 TEXT,
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
 last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_event_sequence>=0),
 CHECK(kind!='discovery' OR task IS NOT NULL), CHECK(kind!='replay' OR pinned_artifact_id IS NOT NULL),
 CHECK(purpose!='validation' OR (kind='replay' AND parent_run_id IS NOT NULL))
);
CREATE TABLE artifacts (
 artifact_id TEXT PRIMARY KEY, source_run_id TEXT NOT NULL UNIQUE REFERENCES runs,
 capability_id TEXT REFERENCES capabilities, version INTEGER CHECK(version>=1),
 schema_version INTEGER NOT NULL, tool_contract_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('draft','validating','validation_failed','published')),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)), capability_proposal_json TEXT CHECK(json_valid(capability_proposal_json)),
 definition_sha256 TEXT NOT NULL, validated_run_id TEXT REFERENCES runs,
 created_at TEXT NOT NULL, published_at TEXT, UNIQUE(capability_id,version),
 CHECK(state!='published' OR (capability_id IS NOT NULL AND version IS NOT NULL AND validated_run_id IS NOT NULL AND published_at IS NOT NULL))
);
CREATE TABLE capability_bindings (
 binding_id TEXT PRIMARY KEY, app_deployment_id TEXT NOT NULL REFERENCES app_deployments,
 capability_id TEXT NOT NULL REFERENCES capabilities, artifact_id TEXT NOT NULL REFERENCES artifacts,
 binding_version INTEGER NOT NULL CHECK(binding_version>=1), state TEXT NOT NULL CHECK(state IN ('ready','retired')),
 deployment_config_version INTEGER NOT NULL, validation_run_id TEXT NOT NULL REFERENCES runs,
 selection_note TEXT, created_at TEXT NOT NULL, retired_at TEXT,
 UNIQUE(app_deployment_id,capability_id,binding_version)
);
CREATE UNIQUE INDEX one_ready_binding ON capability_bindings(app_deployment_id,capability_id) WHERE state='ready';
CREATE TABLE run_events (
 run_id TEXT NOT NULL REFERENCES runs, sequence INTEGER NOT NULL CHECK(sequence>=1), timestamp TEXT NOT NULL,
 type TEXT NOT NULL, step_id TEXT, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(run_id,sequence)
);
CREATE TABLE evidence_assets (
 asset_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event_sequence INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('post_tool_screenshot','target_resolution_screenshot','observation_screenshot')),
 object_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
 byte_size INTEGER NOT NULL CHECK(byte_size>0), width INTEGER NOT NULL CHECK(width>0), height INTEGER NOT NULL CHECK(height>0),
 captured_at TEXT NOT NULL, label TEXT NOT NULL, result TEXT CHECK(result IN ('passed','failed')), detail TEXT,
 FOREIGN KEY(run_id,event_sequence) REFERENCES run_events(run_id,sequence)
);
CREATE TABLE artifact_assets (
 asset_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts, kind TEXT NOT NULL CHECK(kind='reference_crop'),
 object_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
 byte_size INTEGER NOT NULL CHECK(byte_size>0), width INTEGER NOT NULL CHECK(width>0), height INTEGER NOT NULL CHECK(height>0),
 source_run_id TEXT NOT NULL, source_event_sequence INTEGER NOT NULL,
 source_evidence_asset_id TEXT REFERENCES evidence_assets,
 crop_rect_json TEXT NOT NULL CHECK(json_valid(crop_rect_json)), relative_point_json TEXT NOT NULL CHECK(json_valid(relative_point_json)),
 capture_context_json TEXT NOT NULL CHECK(json_valid(capture_context_json)), created_at TEXT NOT NULL,
 FOREIGN KEY(source_run_id,source_event_sequence) REFERENCES run_events(run_id,sequence)
);
CREATE INDEX runs_created ON runs(created_at,run_id);
CREATE INDEX runs_deployment ON runs(app_deployment_id,status);
CREATE INDEX runs_artifact ON runs(pinned_artifact_id,created_at);
CREATE INDEX runs_parent ON runs(parent_run_id);
CREATE INDEX events_type ON run_events(run_id,type,sequence);
CREATE INDEX evidence_event ON evidence_assets(run_id,event_sequence);
CREATE INDEX artifacts_capability ON artifacts(capability_id,version);
CREATE TRIGGER capabilities_immutable BEFORE UPDATE ON capabilities BEGIN SELECT RAISE(ABORT,'capability contract is immutable'); END;
CREATE TRIGGER published_artifact_immutable BEFORE UPDATE ON artifacts WHEN OLD.state='published' BEGIN SELECT RAISE(ABORT,'published artifact is immutable'); END;
CREATE TRIGGER frozen_definition_immutable BEFORE UPDATE OF definition_json,definition_sha256 ON artifacts WHEN OLD.state IN ('validating','validation_failed') BEGIN SELECT RAISE(ABORT,'validated definition is immutable'); END;
CREATE TRIGGER snapshot_immutable BEFORE UPDATE OF deployment_snapshot_json,pinned_artifact_id,artifact_version,artifact_definition_sha256,binding_id,binding_version,binding_snapshot_json ON runs BEGIN SELECT RAISE(ABORT,'run selection is immutable'); END;
CREATE TRIGGER discovery_event_step BEFORE INSERT ON run_events WHEN NEW.step_id IS NOT NULL AND (SELECT kind FROM runs WHERE run_id=NEW.run_id)='discovery' BEGIN SELECT RAISE(ABORT,'discovery step_id must be null'); END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON run_events BEGIN SELECT RAISE(ABORT,'events are append only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON run_events BEGIN SELECT RAISE(ABORT,'events are append only'); END;
