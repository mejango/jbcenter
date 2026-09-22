-- Which sender deployed a chain. A forwarded call was made by the canonical ERC-2771
-- forwarder, so its _msgSender() is Center's sponsor and the chain pairs with every chain
-- Center deploys itself. A row that is not forwarded was sent by a wallet, and the intent
-- can no longer be sponsored: the salts would differ.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS forwarded boolean NOT NULL DEFAULT false;

-- Every deployment the sponsor lane recorded is forwarded by construction, and its deploy
-- row confirmed the same transaction. Anything else stays false, which refuses sponsorship.
UPDATE deployments d SET forwarded = true
FROM intent_deploys i
WHERE i.intent_id = d.intent_id AND i.chain_id = d.chain_id
  AND i.status = 'confirmed' AND lower(i.transaction_hash) = lower(d.transaction_hash);
