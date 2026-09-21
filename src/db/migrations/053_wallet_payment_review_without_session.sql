-- A payment review is approved by one of the account's passkeys on the review page alone: no Center
-- sign-in session takes part, so an approved row no longer records one. The proof digest already
-- binds the approving credential. Earlier approvals keep the session that approved them.
ALTER TABLE rest_wallet_payment_reviews DROP CONSTRAINT rest_wallet_payment_reviews_check3;
ALTER TABLE rest_wallet_payment_reviews
  ADD CONSTRAINT rest_wallet_payment_reviews_check3
  CHECK ((
    (status='pending' AND session_id IS NULL AND proof_digest IS NULL AND signature IS NULL
      AND signed_commitment IS NULL AND approved_at_ms IS NULL AND cancelled_at_ms IS NULL)
    OR (status='approved' AND proof_digest IS NOT NULL AND signature IS NOT NULL
      AND signed_commitment IS NOT NULL AND approved_at_ms IS NOT NULL AND approved_at_ms>=created_at_ms
      AND approved_at_ms<expires_at_ms AND cancelled_at_ms IS NULL)
    OR (status='cancelled' AND session_id IS NULL AND proof_digest IS NULL AND signature IS NULL
      AND signed_commitment IS NULL AND approved_at_ms IS NULL AND cancelled_at_ms IS NOT NULL
      AND cancelled_at_ms>=created_at_ms AND cancelled_at_ms<expires_at_ms)
  ) IS TRUE);
