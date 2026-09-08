-- Transient, machine-local activity ownership; not part of portable archives.
CREATE TABLE recovery_activity_ownership (
  activity_key TEXT PRIMARY KEY CHECK(length(activity_key) BETWEEN 1 AND 160),
  owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
  owner_token TEXT NOT NULL CHECK(length(owner_token) = 36)
) STRICT;
