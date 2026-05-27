-- Schema for the bindings-demo D1 database.

CREATE TABLE IF NOT EXISTS Guestbook (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL,
    message TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT (datetime('now'))
);
