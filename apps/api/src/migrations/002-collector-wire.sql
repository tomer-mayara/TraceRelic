CREATE TABLE tracerelic_collector.upload_parts (
    workspace_key bytea NOT NULL,
    installation_key bytea NOT NULL,
    upload text NOT NULL,
    part_index bigint NOT NULL,
    payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 524288),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (workspace_key, installation_key, upload, part_index)
);
CREATE INDEX upload_expiry ON tracerelic_collector.upload_parts(expires_at);

CREATE TABLE tracerelic_collector.source_aliases (
    workspace_key bytea NOT NULL,
    harness text NOT NULL,
    session_key bytea NOT NULL,
    installation_key bytea NOT NULL,
    stream_key bytea NOT NULL,
    target json NOT NULL,
    PRIMARY KEY (workspace_key, harness, session_key, installation_key, stream_key),
    FOREIGN KEY (workspace_key, harness, session_key, installation_key, stream_key)
      REFERENCES tracerelic_collector.sources(workspace_key, harness, session_key, installation_key, stream_key)
);
