-- Creation approvals may bind the registered enrollment identity (v2) so that the first passkey
-- assertion after registration both approves creation and proves possession. v1 rows are kept.
DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint WHERE conrelid='rest_wallet_deployments'::regclass
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%center-wallet-deployment-v1%';
 EXECUTE format('ALTER TABLE rest_wallet_deployments DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE rest_wallet_deployments ADD CONSTRAINT rest_wallet_deployment_approval_v2 CHECK ((jsonb_typeof(approval)='object' AND octet_length(approval::text)<=4096
    AND approval->>'version' IN ('center-wallet-deployment-v1','center-wallet-deployment-v2') AND approval->>'id'=id::text
    AND approval->>'enrollmentId'=enrollment_id::text AND approval->'ceremony'->>'id'=id::text
    AND approval->'ceremony'->>'purpose'='deploy' AND (approval->>'expiresAt')::bigint=expires_at
    AND (approval->'ceremony'->>'expiresAt')::bigint=expires_at) IS TRUE);
