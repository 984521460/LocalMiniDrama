-- Immutable terminal cost settlements and durable compute-resource release obligations.
-- This migration performs no external action and stores only secret-free evidence digests.

CREATE TABLE mvp_benchmark_execution_settlements (
  uid TEXT PRIMARY KEY,
  reservation_uid TEXT NOT NULL UNIQUE
    REFERENCES mvp_benchmark_execution_reservations(uid) ON DELETE RESTRICT,
  authorization_uid TEXT NOT NULL
    REFERENCES mvp_benchmark_external_authorizations(uid) ON DELETE RESTRICT,
  session_uid TEXT NOT NULL REFERENCES mvp_benchmark_sessions(uid) ON DELETE RESTRICT,
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('h3','tts')),
  item_uid TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','cancelled')),
  terminal_evidence_sha256 TEXT NOT NULL,
  estimated_cost_cny_fen INTEGER NOT NULL,
  actual_cost_cny_fen INTEGER NOT NULL,
  billing_evidence_sha256 TEXT NOT NULL,
  settled_at_epoch_ms INTEGER NOT NULL,
  settlement_json TEXT NOT NULL,
  settlement_sha256 TEXT NOT NULL,
  CHECK (
    typeof(uid)='text' AND length(CAST(uid AS BLOB))=36
    AND uid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  CHECK (typeof(settlement_json)='text' AND length(CAST(settlement_json AS BLOB)) BETWEEN 2 AND 131072),
  CHECK (
    typeof(request_sha256)='text' AND length(CAST(request_sha256 AS BLOB))=64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(terminal_evidence_sha256)='text'
    AND length(CAST(terminal_evidence_sha256 AS BLOB))=64
    AND terminal_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(billing_evidence_sha256)='text'
    AND length(CAST(billing_evidence_sha256 AS BLOB))=64
    AND billing_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(settlement_sha256)='text' AND length(CAST(settlement_sha256 AS BLOB))=64
    AND settlement_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    typeof(estimated_cost_cny_fen)='integer'
    AND estimated_cost_cny_fen BETWEEN 0 AND 1000000
    AND typeof(actual_cost_cny_fen)='integer'
    AND actual_cost_cny_fen BETWEEN 0 AND estimated_cost_cny_fen
    AND typeof(settled_at_epoch_ms)='integer'
    AND settled_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
);

CREATE TABLE mvp_benchmark_execution_settlement_seals (
  settlement_uid TEXT PRIMARY KEY
    REFERENCES mvp_benchmark_execution_settlements(uid) ON DELETE RESTRICT,
  settlement_sha256 TEXT NOT NULL CHECK (
    typeof(settlement_sha256)='text' AND length(CAST(settlement_sha256 AS BLOB))=64
    AND settlement_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE mvp_benchmark_resource_release_obligations (
  authorization_uid TEXT PRIMARY KEY
    REFERENCES mvp_benchmark_external_authorizations(uid) ON DELETE RESTRICT,
  session_uid TEXT NOT NULL REFERENCES mvp_benchmark_sessions(uid) ON DELETE RESTRICT,
  drama_uid TEXT NOT NULL REFERENCES dramas(uid) ON DELETE RESTRICT,
  connection_uid TEXT NOT NULL REFERENCES remote_connections(uid) ON DELETE RESTRICT,
  connection_evidence_sha256 TEXT NOT NULL,
  authorization_sha256 TEXT NOT NULL,
  first_attestation_uid TEXT NOT NULL UNIQUE
    REFERENCES mvp_benchmark_live_environment_attestations(uid) ON DELETE RESTRICT,
  attestation_sha256 TEXT NOT NULL,
  required_at_epoch_ms INTEGER NOT NULL,
  expires_at_epoch_ms INTEGER NOT NULL,
  obligation_json TEXT NOT NULL,
  obligation_sha256 TEXT NOT NULL,
  CHECK (typeof(obligation_json)='text' AND length(CAST(obligation_json AS BLOB)) BETWEEN 2 AND 131072),
  CHECK (
    typeof(connection_evidence_sha256)='text'
    AND length(CAST(connection_evidence_sha256 AS BLOB))=64
    AND connection_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(authorization_sha256)='text'
    AND length(CAST(authorization_sha256 AS BLOB))=64
    AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(attestation_sha256)='text'
    AND length(CAST(attestation_sha256 AS BLOB))=64
    AND attestation_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(obligation_sha256)='text' AND length(CAST(obligation_sha256 AS BLOB))=64
    AND obligation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    typeof(required_at_epoch_ms)='integer'
    AND required_at_epoch_ms BETWEEN 0 AND 253402300799999
    AND typeof(expires_at_epoch_ms)='integer'
    AND expires_at_epoch_ms BETWEEN required_at_epoch_ms + 1 AND 253402300799999
  )
);

CREATE TABLE mvp_benchmark_resource_release_obligation_seals (
  authorization_uid TEXT PRIMARY KEY
    REFERENCES mvp_benchmark_resource_release_obligations(authorization_uid) ON DELETE RESTRICT,
  obligation_sha256 TEXT NOT NULL CHECK (
    typeof(obligation_sha256)='text' AND length(CAST(obligation_sha256 AS BLOB))=64
    AND obligation_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE mvp_benchmark_resource_release_receipts (
  authorization_uid TEXT PRIMARY KEY
    REFERENCES mvp_benchmark_resource_release_obligations(authorization_uid) ON DELETE RESTRICT,
  connection_uid TEXT NOT NULL REFERENCES remote_connections(uid) ON DELETE RESTRICT,
  connection_evidence_sha256 TEXT NOT NULL,
  obligation_sha256 TEXT NOT NULL,
  release_evidence_sha256 TEXT NOT NULL,
  released_at_epoch_ms INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  CHECK (typeof(receipt_json)='text' AND length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 65536),
  CHECK (
    typeof(connection_evidence_sha256)='text'
    AND length(CAST(connection_evidence_sha256 AS BLOB))=64
    AND connection_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(obligation_sha256)='text' AND length(CAST(obligation_sha256 AS BLOB))=64
    AND obligation_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(release_evidence_sha256)='text'
    AND length(CAST(release_evidence_sha256 AS BLOB))=64
    AND release_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(receipt_sha256)='text' AND length(CAST(receipt_sha256 AS BLOB))=64
    AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    typeof(released_at_epoch_ms)='integer'
    AND released_at_epoch_ms BETWEEN 0 AND 253402300799999
  )
);

CREATE TABLE mvp_benchmark_resource_release_receipt_seals (
  authorization_uid TEXT PRIMARY KEY
    REFERENCES mvp_benchmark_resource_release_receipts(authorization_uid) ON DELETE RESTRICT,
  receipt_sha256 TEXT NOT NULL CHECK (
    typeof(receipt_sha256)='text' AND length(CAST(receipt_sha256 AS BLOB))=64
    AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TRIGGER v2_mvp_benchmark_execution_settlements_validate_insert
BEFORE INSERT ON mvp_benchmark_execution_settlements
BEGIN
  SELECT CASE WHEN
    mvp_benchmark_execution_settlement_record_valid(
      NEW.uid,NEW.reservation_uid,NEW.authorization_uid,NEW.session_uid,NEW.drama_uid,
      NEW.item_kind,NEW.item_uid,NEW.request_sha256,NEW.outcome,
      NEW.terminal_evidence_sha256,NEW.estimated_cost_cny_fen,NEW.actual_cost_cny_fen,
      NEW.billing_evidence_sha256,NEW.settled_at_epoch_ms,
      NEW.settlement_json,NEW.settlement_sha256
    ) IS NOT 1
    OR NOT EXISTS (
      SELECT 1
      FROM mvp_benchmark_execution_reservations AS reservation
      JOIN mvp_benchmark_execution_reservation_seals AS seal
        ON seal.reservation_uid=reservation.uid
      JOIN mvp_benchmark_external_authorizations AS authorization
        ON authorization.uid=reservation.authorization_uid
      WHERE reservation.uid=NEW.reservation_uid
        AND reservation.authorization_uid=NEW.authorization_uid
        AND reservation.session_uid=NEW.session_uid
        AND reservation.drama_uid=NEW.drama_uid
        AND reservation.item_kind=NEW.item_kind
        AND reservation.item_uid=NEW.item_uid
        AND reservation.request_sha256=NEW.request_sha256
        AND reservation.estimated_cost_cny_fen=NEW.estimated_cost_cny_fen
        AND reservation.reservation_sha256=seal.reservation_sha256
        AND NEW.settled_at_epoch_ms>=reservation.reserved_at_epoch_ms
        AND NEW.actual_cost_cny_fen<=reservation.estimated_cost_cny_fen
        AND (
          SELECT COALESCE(sum(actual_cost_cny_fen),0)
          FROM mvp_benchmark_execution_settlements
          WHERE authorization_uid=NEW.authorization_uid
        )+NEW.actual_cost_cny_fen<=json_extract(
          authorization.authorization_json,'$.maximumCostCnyFen'
        )
    )
    OR NOT (
      (
        NEW.item_kind='h3' AND EXISTS (
          SELECT 1 FROM remote_tasks AS task
          WHERE task.uid=NEW.item_uid AND task.contract_version='remote-task.v1'
            AND task.status=NEW.outcome
            AND (
              (task.status='succeeded' AND task.stage='completed')
              OR (
                task.status='failed' AND task.stage='failed'
                AND task.recovery_state='orphaned' AND task.error_retryable=0
              )
              OR (task.status='cancelled' AND task.stage='cancelled')
            )
            AND mvp_benchmark_h3_terminal_evidence_sha256(
              task.uid,task.connection_evidence_sha256,task.request_sha256,
              task.stage,task.status,task.prompt_id,task.output_asset_version_uid,
              task.error_code,task.error_phase,task.error_retryable,task.recovery_state,
              task.state_version,task.completed_at
            )=NEW.terminal_evidence_sha256
            AND NEW.settled_at_epoch_ms>=(
              unixepoch(task.completed_at)*1000+CAST(substr(task.completed_at,21,3) AS INTEGER)
            )
        )
      ) OR (
        NEW.item_kind='tts' AND NEW.outcome='succeeded' AND EXISTS (
          SELECT 1 FROM audio_tts_execution_evidence AS evidence
          WHERE evidence.intent_uid=NEW.item_uid
            AND evidence.execution_sha256=NEW.terminal_evidence_sha256
            AND NEW.settled_at_epoch_ms>=evidence.created_at_epoch_ms
        )
      )
    )
  THEN RAISE(ABORT,'MVP benchmark execution settlement invalid') END;
END;

CREATE TRIGGER v2_mvp_benchmark_execution_settlements_create_seal
AFTER INSERT ON mvp_benchmark_execution_settlements
BEGIN
  INSERT INTO mvp_benchmark_execution_settlement_seals(settlement_uid,settlement_sha256)
  VALUES(NEW.uid,NEW.settlement_sha256);
END;

CREATE TRIGGER v2_mvp_benchmark_resource_release_obligations_validate_insert
BEFORE INSERT ON mvp_benchmark_resource_release_obligations
BEGIN
  SELECT CASE WHEN
    mvp_benchmark_release_obligation_record_valid(
      NEW.authorization_uid,NEW.session_uid,NEW.drama_uid,NEW.connection_uid,
      NEW.connection_evidence_sha256,NEW.authorization_sha256,NEW.first_attestation_uid,
      NEW.attestation_sha256,NEW.required_at_epoch_ms,NEW.expires_at_epoch_ms,
      NEW.obligation_json,NEW.obligation_sha256
    ) IS NOT 1
    OR NOT EXISTS (
      SELECT 1
      FROM mvp_benchmark_external_authorizations AS authorization
      JOIN mvp_benchmark_live_environment_attestations AS attestation
        ON attestation.uid=NEW.first_attestation_uid
      JOIN mvp_benchmark_live_environment_attestation_seals AS seal
        ON seal.attestation_uid=attestation.uid
      WHERE authorization.uid=NEW.authorization_uid
        AND authorization.session_uid=NEW.session_uid
        AND authorization.drama_uid=NEW.drama_uid
        AND authorization.authorization_sha256=NEW.authorization_sha256
        AND attestation.authorization_uid=authorization.uid
        AND attestation.connection_uid=NEW.connection_uid
        AND attestation.connection_evidence_sha256=NEW.connection_evidence_sha256
        AND attestation.attestation_sha256=NEW.attestation_sha256
        AND seal.attestation_sha256=attestation.attestation_sha256
        AND attestation.attested_at_epoch_ms=NEW.required_at_epoch_ms
        AND authorization.expires_at_epoch_ms=NEW.expires_at_epoch_ms
        AND mvp_benchmark_release_obligation_json(
          authorization.authorization_json,attestation.attestation_json
        )=NEW.obligation_json
        AND mvp_benchmark_release_obligation_sha256(
          authorization.authorization_json,attestation.attestation_json
        )=NEW.obligation_sha256
    )
  THEN RAISE(ABORT,'MVP benchmark resource release obligation invalid') END;
END;

CREATE TRIGGER v2_mvp_benchmark_live_environment_attestation_seals_create_release_obligation
AFTER INSERT ON mvp_benchmark_live_environment_attestation_seals
WHEN NOT EXISTS (
  SELECT 1 FROM mvp_benchmark_resource_release_obligations
  WHERE authorization_uid=(
    SELECT authorization_uid FROM mvp_benchmark_live_environment_attestations
    WHERE uid=NEW.attestation_uid
  )
)
BEGIN
  INSERT INTO mvp_benchmark_resource_release_obligations
    (authorization_uid,session_uid,drama_uid,connection_uid,connection_evidence_sha256,
     authorization_sha256,first_attestation_uid,attestation_sha256,required_at_epoch_ms,
     expires_at_epoch_ms,obligation_json,obligation_sha256)
  SELECT authorization.uid,authorization.session_uid,authorization.drama_uid,
         attestation.connection_uid,attestation.connection_evidence_sha256,
         authorization.authorization_sha256,attestation.uid,attestation.attestation_sha256,
         attestation.attested_at_epoch_ms,authorization.expires_at_epoch_ms,
         mvp_benchmark_release_obligation_json(
           authorization.authorization_json,attestation.attestation_json
         ),
         mvp_benchmark_release_obligation_sha256(
           authorization.authorization_json,attestation.attestation_json
         )
  FROM mvp_benchmark_external_authorizations AS authorization
  JOIN mvp_benchmark_live_environment_attestations AS attestation
    ON attestation.uid=NEW.attestation_uid
  WHERE authorization.uid=attestation.authorization_uid;
END;

CREATE TRIGGER v2_mvp_benchmark_resource_release_obligations_create_seal
AFTER INSERT ON mvp_benchmark_resource_release_obligations
BEGIN
  INSERT INTO mvp_benchmark_resource_release_obligation_seals
    (authorization_uid,obligation_sha256)
  VALUES(NEW.authorization_uid,NEW.obligation_sha256);
END;

CREATE TRIGGER v2_mvp_benchmark_resource_release_receipts_validate_insert
BEFORE INSERT ON mvp_benchmark_resource_release_receipts
BEGIN
  SELECT CASE WHEN
    mvp_benchmark_release_receipt_record_valid(
      NEW.authorization_uid,NEW.connection_uid,NEW.connection_evidence_sha256,
      NEW.obligation_sha256,NEW.release_evidence_sha256,NEW.released_at_epoch_ms,
      NEW.receipt_json,NEW.receipt_sha256
    ) IS NOT 1
    OR NOT EXISTS (
      SELECT 1
      FROM mvp_benchmark_resource_release_obligations AS obligation
      JOIN mvp_benchmark_resource_release_obligation_seals AS seal
        ON seal.authorization_uid=obligation.authorization_uid
      WHERE obligation.authorization_uid=NEW.authorization_uid
        AND obligation.connection_uid=NEW.connection_uid
        AND obligation.connection_evidence_sha256=NEW.connection_evidence_sha256
        AND obligation.obligation_sha256=NEW.obligation_sha256
        AND seal.obligation_sha256=obligation.obligation_sha256
        AND NEW.released_at_epoch_ms>=obligation.required_at_epoch_ms
    )
  THEN RAISE(ABORT,'MVP benchmark resource release receipt invalid') END;
END;

CREATE TRIGGER v2_mvp_benchmark_resource_release_receipts_create_seal
AFTER INSERT ON mvp_benchmark_resource_release_receipts
BEGIN
  INSERT INTO mvp_benchmark_resource_release_receipt_seals
    (authorization_uid,receipt_sha256)
  VALUES(NEW.authorization_uid,NEW.receipt_sha256);
END;

CREATE TRIGGER v2_mvp_benchmark_execution_settlements_reject_replacement
BEFORE INSERT ON mvp_benchmark_execution_settlements
WHEN EXISTS (
  SELECT 1 FROM mvp_benchmark_execution_settlements
  WHERE uid=NEW.uid OR reservation_uid=NEW.reservation_uid
)
BEGIN SELECT RAISE(ABORT,'MVP benchmark execution settlements are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_execution_settlements_immutable_update
BEFORE UPDATE ON mvp_benchmark_execution_settlements
BEGIN SELECT RAISE(ABORT,'MVP benchmark execution settlements are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_execution_settlements_append_only
BEFORE DELETE ON mvp_benchmark_execution_settlements
BEGIN SELECT RAISE(ABORT,'MVP benchmark execution settlements are append-only'); END;

CREATE TRIGGER v2_mvp_benchmark_resource_release_obligations_reject_replacement
BEFORE INSERT ON mvp_benchmark_resource_release_obligations
WHEN EXISTS (
  SELECT 1 FROM mvp_benchmark_resource_release_obligations
  WHERE authorization_uid=NEW.authorization_uid OR first_attestation_uid=NEW.first_attestation_uid
)
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release obligations are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_resource_release_obligations_immutable_update
BEFORE UPDATE ON mvp_benchmark_resource_release_obligations
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release obligations are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_resource_release_obligations_append_only
BEFORE DELETE ON mvp_benchmark_resource_release_obligations
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release obligations are append-only'); END;

CREATE TRIGGER v2_mvp_benchmark_resource_release_receipts_reject_replacement
BEFORE INSERT ON mvp_benchmark_resource_release_receipts
WHEN EXISTS (
  SELECT 1 FROM mvp_benchmark_resource_release_receipts
  WHERE authorization_uid=NEW.authorization_uid
)
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release receipts are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_resource_release_receipts_immutable_update
BEFORE UPDATE ON mvp_benchmark_resource_release_receipts
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release receipts are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_resource_release_receipts_append_only
BEFORE DELETE ON mvp_benchmark_resource_release_receipts
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release receipts are append-only'); END;

CREATE TRIGGER v2_mvp_benchmark_execution_settlement_seals_reject_replacement
BEFORE INSERT ON mvp_benchmark_execution_settlement_seals
WHEN EXISTS (SELECT 1 FROM mvp_benchmark_execution_settlement_seals WHERE settlement_uid=NEW.settlement_uid)
BEGIN SELECT RAISE(ABORT,'MVP benchmark execution settlement seals are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_execution_settlement_seals_immutable_update
BEFORE UPDATE ON mvp_benchmark_execution_settlement_seals
BEGIN SELECT RAISE(ABORT,'MVP benchmark execution settlement seals are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_execution_settlement_seals_append_only
BEFORE DELETE ON mvp_benchmark_execution_settlement_seals
BEGIN SELECT RAISE(ABORT,'MVP benchmark execution settlement seals are append-only'); END;

CREATE TRIGGER v2_mvp_benchmark_resource_release_obligation_seals_reject_replacement
BEFORE INSERT ON mvp_benchmark_resource_release_obligation_seals
WHEN EXISTS (SELECT 1 FROM mvp_benchmark_resource_release_obligation_seals WHERE authorization_uid=NEW.authorization_uid)
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release obligation seals are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_resource_release_obligation_seals_immutable_update
BEFORE UPDATE ON mvp_benchmark_resource_release_obligation_seals
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release obligation seals are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_resource_release_obligation_seals_append_only
BEFORE DELETE ON mvp_benchmark_resource_release_obligation_seals
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release obligation seals are append-only'); END;

CREATE TRIGGER v2_mvp_benchmark_resource_release_receipt_seals_reject_replacement
BEFORE INSERT ON mvp_benchmark_resource_release_receipt_seals
WHEN EXISTS (SELECT 1 FROM mvp_benchmark_resource_release_receipt_seals WHERE authorization_uid=NEW.authorization_uid)
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release receipt seals are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_resource_release_receipt_seals_immutable_update
BEFORE UPDATE ON mvp_benchmark_resource_release_receipt_seals
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release receipt seals are immutable'); END;
CREATE TRIGGER v2_mvp_benchmark_resource_release_receipt_seals_append_only
BEFORE DELETE ON mvp_benchmark_resource_release_receipt_seals
BEGIN SELECT RAISE(ABORT,'MVP benchmark resource release receipt seals are append-only'); END;

-- Upgrade closure: first existing attestation creates the same durable obligation.
INSERT INTO mvp_benchmark_resource_release_obligations
  (authorization_uid,session_uid,drama_uid,connection_uid,connection_evidence_sha256,
   authorization_sha256,first_attestation_uid,attestation_sha256,required_at_epoch_ms,
   expires_at_epoch_ms,obligation_json,obligation_sha256)
SELECT authorization.uid,authorization.session_uid,authorization.drama_uid,
       attestation.connection_uid,attestation.connection_evidence_sha256,
       authorization.authorization_sha256,attestation.uid,attestation.attestation_sha256,
       attestation.attested_at_epoch_ms,authorization.expires_at_epoch_ms,
       mvp_benchmark_release_obligation_json(
         authorization.authorization_json,attestation.attestation_json
       ),
       mvp_benchmark_release_obligation_sha256(
         authorization.authorization_json,attestation.attestation_json
       )
FROM mvp_benchmark_external_authorizations AS authorization
JOIN mvp_benchmark_live_environment_attestations AS attestation
  ON attestation.authorization_uid=authorization.uid
WHERE attestation.uid=(
  SELECT candidate.uid
  FROM mvp_benchmark_live_environment_attestations AS candidate
  WHERE candidate.authorization_uid=authorization.uid
  ORDER BY candidate.attested_at_epoch_ms,candidate.uid
  LIMIT 1
);
