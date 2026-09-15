-- The refresh queue pins one configuration for all replicas (023). The lease and lead grew for
-- hosted-provider observations (migration 039 widened the authority window to match); clear the
-- pinned copy so the next replica records the new bounded settings instead of refusing every claim.
UPDATE rest_wallet_authority_refresh_control SET configuration=NULL WHERE id=1;
