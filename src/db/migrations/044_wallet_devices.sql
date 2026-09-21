-- A device is a further live passkey on an account: its own on-chain signer, added by the account's
-- primary passkey. The primary stays unique per account; device rows carry the addition receipt.
ALTER TABLE rest_wallet_credentials ADD COLUMN device_receipt jsonb CHECK (device_receipt IS NULL OR (
  jsonb_typeof(device_receipt)='object' AND octet_length(device_receipt::text)<=16384
  AND device_receipt->>'version'='center-wallet-device-v1'
  AND device_receipt->>'accountId'=account_id AND device_receipt->>'enrollmentId'=enrollment_id::text
  AND device_receipt->>'rpId'=rp_id AND device_receipt->'credential'->>'credentialId'=credential_id
  AND device_receipt->'credential'->>'userHandle'=user_handle
  AND device_receipt->'credential'->'publicKey'->>'x'=public_key_x
  AND device_receipt->'credential'->'publicKey'->>'y'=public_key_y
  AND (device_receipt->'credential'->>'backupEligible')::boolean=backup_eligible
  AND (device_receipt->>'verifiedAtMs')::bigint=verified_at
  AND device_receipt->>'signerAddress' ~ '^0x[0-9a-f]{40}$') IS TRUE);
DROP INDEX rest_wallet_credential_current_primary;
CREATE UNIQUE INDEX rest_wallet_credential_current_primary ON rest_wallet_credentials(account_id)
  WHERE superseded_at IS NULL AND device_receipt IS NULL;
CREATE INDEX rest_wallet_credential_current_devices ON rest_wallet_credentials(account_id)
  WHERE superseded_at IS NULL AND device_receipt IS NOT NULL;
ALTER TABLE rest_wallet_ceremonies DROP CONSTRAINT rest_wallet_ceremonies_purpose_check;
ALTER TABLE rest_wallet_ceremonies ADD CONSTRAINT rest_wallet_ceremonies_purpose_check
  CHECK (purpose IN ('registration','login','session','deploy','payment','rotate','signup-resume','device'));
