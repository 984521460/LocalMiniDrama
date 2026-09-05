-- New paid-run authorizations must carry an explicit operator self-attestation. Historical
-- v1 authorization rows remain readable for settlement evidence, but cannot be made active.

ALTER TABLE mvp_benchmark_external_authorizations
ADD COLUMN request_sha256 TEXT
CHECK (
  request_sha256 IS NULL
  OR (
    typeof(request_sha256)='text'
    AND length(CAST(request_sha256 AS BLOB))=64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE mvp_benchmark_external_authorization_request_seals (
  authorization_uid TEXT PRIMARY KEY
    REFERENCES mvp_benchmark_external_authorizations(uid) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK (
    typeof(request_sha256)='text'
    AND length(CAST(request_sha256 AS BLOB))=64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TRIGGER v2_mvp_benchmark_external_authorization_request_seals_validate_insert
BEFORE INSERT ON mvp_benchmark_external_authorization_request_seals
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM mvp_benchmark_external_authorizations AS authorization
    WHERE authorization.uid=NEW.authorization_uid
      AND authorization.request_sha256=NEW.request_sha256
      AND mvp_benchmark_external_authorization_request_sha256(
        authorization.request_json
      )=NEW.request_sha256
  ) THEN RAISE(ABORT, 'MVP benchmark authorization request seal invalid') END;
END;

CREATE TRIGGER v2_mvp_benchmark_external_authorization_request_seals_immutable_update
BEFORE UPDATE ON mvp_benchmark_external_authorization_request_seals
BEGIN
  SELECT RAISE(ABORT, 'MVP benchmark authorization request seals are immutable');
END;

CREATE TRIGGER v2_mvp_benchmark_external_authorization_request_seals_append_only
BEFORE DELETE ON mvp_benchmark_external_authorization_request_seals
BEGIN
  SELECT RAISE(ABORT, 'MVP benchmark authorization request seals are append-only');
END;

CREATE TRIGGER v2_mvp_benchmark_external_authorizations_operator_attestation_insert
BEFORE INSERT ON mvp_benchmark_external_authorizations
BEGIN
  SELECT CASE WHEN
    NEW.request_sha256 IS NULL
    OR json_valid(NEW.request_json) IS NOT 1
    OR json_extract(NEW.request_json,'$.schemaVersion')
      IS NOT 'mvp-benchmark-external-authorization-request.v2'
    OR json_type(NEW.request_json,'$.operatorAttestation') IS NOT 'object'
    OR json_extract(NEW.request_json,'$.operatorAttestation.schemaVersion')
      IS NOT 'mvp-benchmark-operator-attestation.v1'
    OR json_extract(NEW.request_json,'$.operatorAttestation.licenseId')
      IS NOT 'MiniMax-H3-Community-License-Agreement'
    OR json_extract(NEW.request_json,'$.operatorAttestation.licenseSourceRevision')
      IS NOT '42ed227ee7df40d41602854ae760620d6eb651fe'
    OR json_extract(NEW.request_json,'$.operatorAttestation.requiredEnvironmentSha256')
      IS NOT '716b53e4b0cc4bb2a732e16ff0722e5313bc9ecef28cb6950be092b4fd852d43'
    OR json_extract(NEW.request_json,'$.operatorAttestation.territoryEligibilityConfirmed') IS NOT 1
    OR COALESCE(
      json_extract(NEW.request_json,'$.operatorAttestation.commercialEligibilityBasis') NOT IN (
        'annual-revenue-not-over-usd-20000000', 'written-minimax-authorization'
      ),
      1
    )
    OR json_extract(NEW.request_json,'$.operatorAttestation.commercialUiAttributionAccepted') IS NOT 1
    OR json_extract(NEW.request_json,'$.operatorAttestation.acceptableUseAndSafeguardsAccepted') IS NOT 1
    OR json_extract(NEW.request_json,'$.operatorAttestation.downstreamUseRestrictionsAccepted') IS NOT 1
    OR json_extract(NEW.request_json,'$.operatorAttestation.publicAiContentDisclosureAccepted') IS NOT 1
    OR json_extract(NEW.request_json,'$.operatorAttestation.benchmarkInputRightsConfirmed') IS NOT 1
    OR mvp_benchmark_external_authorization_request_sha256(NEW.request_json)
      IS NOT NEW.request_sha256
  THEN RAISE(ABORT, 'MVP benchmark operator attestation invalid') END;
END;

CREATE TRIGGER v2_mvp_benchmark_external_authorizations_request_seal_after_insert
AFTER INSERT ON mvp_benchmark_external_authorizations
BEGIN
  INSERT INTO mvp_benchmark_external_authorization_request_seals
    (authorization_uid,request_sha256)
  VALUES (NEW.uid,NEW.request_sha256);
END;
