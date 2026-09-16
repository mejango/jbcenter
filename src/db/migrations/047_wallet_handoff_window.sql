-- An app's request lives up to fifteen minutes (plus the 30 s clock allowance), so a signup it
-- starts can finish and return to the app.
ALTER TABLE rest_wallet_handoffs DROP CONSTRAINT rest_wallet_handoffs_check;
ALTER TABLE rest_wallet_handoffs ADD CONSTRAINT rest_wallet_handoffs_check CHECK (expires_at_ms>created_at_ms AND expires_at_ms<=created_at_ms+930000);
