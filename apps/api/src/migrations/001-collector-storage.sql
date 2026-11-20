-- Digest keys have a fixed index size. JSON retains the exact identifiers and accepted wire values.
CREATE TABLE tracerelic_collector.writes (
    workspace_key bytea NOT NULL,
    position bigint GENERATED ALWAYS AS IDENTITY (CACHE 1),
    entry json NOT NULL,
    PRIMARY KEY (workspace_key, position)
);

CREATE TABLE tracerelic_collector.sessions (
    workspace_key bytea NOT NULL,
    harness text NOT NULL CHECK (harness IN ('codex', 'claude')),
    session_key bytea NOT NULL,
    first_position bigint NOT NULL,
    version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    summary json NOT NULL,
    PRIMARY KEY (workspace_key, harness, session_key)
);

CREATE TABLE tracerelic_collector.records (
    workspace_key bytea NOT NULL,
    harness text NOT NULL,
    session_key bytea NOT NULL,
    kind text NOT NULL CHECK (kind IN ('message', 'usage')),
    record_key bytea NOT NULL,
    ordinal bigint NOT NULL CHECK (ordinal > 0),
    payload json NOT NULL,
    PRIMARY KEY (workspace_key, harness, session_key, kind, record_key),
    FOREIGN KEY (workspace_key, harness, session_key)
        REFERENCES tracerelic_collector.sessions (workspace_key, harness, session_key)
);

CREATE TABLE tracerelic_collector.sources (
    workspace_key bytea NOT NULL,
    harness text NOT NULL,
    session_key bytea NOT NULL,
    installation_key bytea NOT NULL,
    stream_key bytea NOT NULL,
    first_position bigint NOT NULL,
    root_key bytea,
    checkpoint json NOT NULL,
    inventory json,
    PRIMARY KEY (workspace_key, harness, session_key, installation_key, stream_key),
    FOREIGN KEY (workspace_key, harness, session_key)
        REFERENCES tracerelic_collector.sessions (workspace_key, harness, session_key)
);

CREATE INDEX sources_by_root ON tracerelic_collector.sources (workspace_key, harness, installation_key, root_key)
    WHERE root_key IS NOT NULL;
