-- A verified authority observation serves sign-in for fifteen minutes (was 120 s);
-- walletAuthorityMaximumAgeMs matches. Account-changing actions re-verify at a fresh block.
ALTER TABLE rest_wallet_authority DROP CONSTRAINT rest_wallet_authority_snapshot_shape;
ALTER TABLE rest_wallet_authority
  ADD CONSTRAINT rest_wallet_authority_snapshot_shape CHECK ((
    (snapshot IS NULL AND observation_digest IS NULL AND ready_until_ms IS NULL
      AND binding_id IS NULL AND binding_authorization_digest IS NULL)
    OR (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=32768
      AND snapshot->>'version'='center-wallet-authority-snapshot-v1'
      AND snapshot->>'accountId'=account_id AND snapshot->>'revision'=revision::text
      AND snapshot->>'authorityEpoch'=authority_epoch::text AND snapshot->>'sessionEpoch'=session_epoch::text
      AND jsonb_typeof(snapshot->'bootstrapRequired')='boolean'
      AND snapshot->>'readiness' IN ('verified','changed','unknown','fenced')
      AND (snapshot->>'updatedAtMs')::bigint BETWEEN 1 AND 9007199254740991
      AND (snapshot->'highestObservedBlock'='null'::jsonb OR
        (jsonb_typeof(snapshot->'highestObservedBlock')='string'
          AND snapshot->>'highestObservedBlock' ~ '^(0|[1-9][0-9]{0,77})$'
          AND (snapshot->>'highestObservedBlock')::numeric<=
            115792089237316195423570985008687907853269984665640564039457584007913129639935))
      AND (snapshot->'latestObservation'='null'::jsonb AND observation_digest IS NULL
        OR (jsonb_typeof(snapshot->'latestObservation')='object' AND observation_digest IS NOT NULL
          AND snapshot->'latestObservation'->>'version'='center-wallet-authority-observation-v1'
          AND snapshot->'latestObservation'->>'accountId'=account_id
          AND snapshot->'latestObservation'->>'contextDigest' ~ '^0x[0-9a-f]{64}$'
          AND (snapshot->'latestObservation'->>'observedAtMs')::bigint BETWEEN 1 AND (snapshot->>'updatedAtMs')::bigint))
      AND (snapshot->'identity'='null'::jsonb AND binding_id IS NULL AND binding_authorization_digest IS NULL
        OR (jsonb_typeof(snapshot->'identity')='object' AND snapshot->'identity'->>'accountId'=account_id
          AND binding_id IS NOT NULL AND binding_authorization_digest IS NOT NULL
          AND snapshot->'identity'->>'bindingId'=binding_id
          AND snapshot->'identity'->>'bindingAuthorizationDigest'=binding_authorization_digest))
      AND (snapshot->'historicalVerifiedIdentity'='null'::jsonb OR
        (jsonb_typeof(snapshot->'historicalVerifiedIdentity')='object' AND snapshot->'historicalVerifiedIdentity'->>'accountId'=account_id))
      AND (snapshot->'activeFence'='null'::jsonb OR
        (jsonb_typeof(snapshot->'activeFence')='object' AND snapshot->>'readiness'='fenced'))
      AND (snapshot->'lastClosedFence'='null'::jsonb OR jsonb_typeof(snapshot->'lastClosedFence')='object')
      AND ((snapshot->>'readiness'='verified' AND snapshot->'bootstrapRequired'='false'::jsonb
          AND snapshot->'activeFence'='null'::jsonb AND jsonb_typeof(snapshot->'identity')='object'
          AND jsonb_typeof(snapshot->'acceptedAnchor')='object'
          AND snapshot->'acceptedAnchor'->'chainId'='8453'::jsonb
          AND snapshot->'acceptedAnchor'->>'source'='onchain'
          AND snapshot->'acceptedAnchor'->>'blockHash' ~ '^0x[0-9a-f]{64}$'
          AND snapshot->'acceptedAnchor'->>'blockNumber' ~ '^(0|[1-9][0-9]{0,77})$'
          AND snapshot->'acceptedAnchor'->>'timestamp' ~ '^(0|[1-9][0-9]{0,77})$'
          AND snapshot->'identity'=snapshot->'historicalVerifiedIdentity'
          AND snapshot->'identity'=snapshot->'latestObservation'->'identity'
          AND snapshot->'acceptedAnchor'=snapshot->'latestObservation'->'head'
          AND snapshot->'latestObservation'->>'eligibility'='matched'
          AND ready_until_ms IS NOT NULL AND (snapshot->>'validUntilMs')::bigint=ready_until_ms
          AND ready_until_ms=(snapshot->'latestObservation'->>'validUntilMs')::bigint
          AND ready_until_ms>(snapshot->'latestObservation'->>'observedAtMs')::bigint
          AND ready_until_ms<=(snapshot->'latestObservation'->>'observedAtMs')::bigint+900000
          AND ready_until_ms<=(snapshot->'acceptedAnchor'->>'timestamp')::numeric*1000+1200000)
        OR (snapshot->>'readiness'<>'verified' AND ready_until_ms IS NULL AND snapshot->'validUntilMs'='null'::jsonb))
    )) IS TRUE);
