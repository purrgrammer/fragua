-- Fixture: a schema whose every column is mentioned in the companion
-- arch fragment. The drift-lint self-test asserts zero findings here.

CREATE TABLE IF NOT EXISTS fixture_table (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  documented_field INTEGER NOT NULL DEFAULT 0
) STRICT;
