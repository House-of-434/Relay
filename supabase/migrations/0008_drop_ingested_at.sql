-- ingested_at was written by nothing and read by nothing: the capture ingest
-- upsert stamps created_at/updated_at, and no reader ever consumed a separate
-- ingest timestamp. Drop it. audio_path is deliberately kept (unused today)
-- as the reserved pointer for future audio retention.

alter table transcripts.meetings drop column if exists ingested_at;
