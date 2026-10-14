-- Target resolution is separate from effect approval and is also available
-- to READ_ONLY runs. Retain all existing review evidence and lifecycle fields.
CREATE TABLE human_review_v5 (
 review_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs,
 call_id TEXT NOT NULL, tool TEXT NOT NULL, arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json)),
 assessment_decision TEXT CHECK(assessment_decision IS NULL OR assessment_decision IN ('auto_approve','requires_human_review')),
 confidence REAL CHECK(confidence IS NULL OR (confidence>=0 AND confidence<=1)), reason TEXT NOT NULL,
 access_policy TEXT NOT NULL CHECK(access_policy IN ('READ_ONLY','READ_WRITE')),
 screenshot_asset_id TEXT NOT NULL REFERENCES evidence_assets, event_sequence INTEGER NOT NULL,
 state_fingerprint TEXT NOT NULL, request_sha256 TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','cancelled')),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, human_comment TEXT,
 target_resolution_json TEXT CHECK(target_resolution_json IS NULL OR json_valid(target_resolution_json)),
 selected_candidate_id TEXT,
 refresh_targets INTEGER NOT NULL DEFAULT 0 CHECK(refresh_targets IN (0,1)),
 CHECK(access_policy='READ_WRITE' OR target_resolution_json IS NOT NULL),
 CHECK(selected_candidate_id IS NULL OR refresh_targets=0),
 CHECK(status='approved' OR (selected_candidate_id IS NULL AND refresh_targets=0)),
 CHECK(target_resolution_json IS NOT NULL OR (selected_candidate_id IS NULL AND refresh_targets=0)),
 FOREIGN KEY(run_id,event_sequence) REFERENCES run_events(run_id,sequence)
);
INSERT INTO human_review_v5 SELECT *,NULL,NULL,0 FROM human_review;
DROP TABLE human_review;
ALTER TABLE human_review_v5 RENAME TO human_review;
CREATE UNIQUE INDEX one_pending_review ON human_review(run_id) WHERE status='pending';
CREATE INDEX reviews_queue ON human_review(status,created_at);
