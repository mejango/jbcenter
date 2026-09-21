-- The refresh queue pins one configuration for all replicas (023). An account now stays tracked
-- for a day after its last request instead of two minutes, so a returning customer never waits on
-- a history catch-up; clear the pinned copy so the next replica records the new settings instead
-- of refusing every claim.
UPDATE rest_wallet_authority_refresh_control SET configuration=NULL WHERE id=1;
