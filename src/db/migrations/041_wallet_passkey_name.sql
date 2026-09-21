-- The name given to a passkey at enrollment or recovery, shown on the account page. Never editable:
-- changing the passkey itself is a recovery (new signer on the Safe, old one removed).
ALTER TABLE rest_wallet_credentials ADD COLUMN passkey_name text
  CHECK (passkey_name IS NULL OR octet_length(passkey_name) BETWEEN 1 AND 120);
