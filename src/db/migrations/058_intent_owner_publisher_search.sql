CREATE INDEX intents_owner_idx ON intents (lower(owner));
CREATE INDEX intents_publisher_idx ON intents (lower(publisher));
