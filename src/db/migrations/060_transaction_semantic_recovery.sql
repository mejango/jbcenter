-- A confirmed receipt with an unknown modeled outcome still needs reconciliation.
DROP INDEX rest_transaction_plans_recovery_idx;
CREATE INDEX rest_transaction_plans_recovery_idx ON rest_transaction_plans(created_at,id COLLATE "C")
  WHERE jsonb_path_exists(document, '$.steps[*] ? ((exists(@.attempt) || exists(@.externalExecution)) && (@.state == "reserved" || @.state == "submitted" || @.state == "unknown" || @.state == "confirming" || @.state == "reorged" || (@.state == "confirmed" && (!exists(@.semantic.status) || @.semantic.status == "unknown"))))');
