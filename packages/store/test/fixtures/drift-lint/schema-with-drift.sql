-- Fixture: a schema where one column is intentionally absent from the
-- companion arch fragment. The drift-lint self-test points at this pair
-- and asserts the lint surfaces the missing column by name.

CREATE TABLE IF NOT EXISTS fixture_table (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_internal_field INTEGER NOT NULL DEFAULT 0
) STRICT;
