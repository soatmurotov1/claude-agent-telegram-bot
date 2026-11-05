/**
 * Database schema, applied in order and recorded in schema_migrations. A migration is never changed after it was
 * released: add a new one instead. Nothing here deletes data automatically; rows go away only when an admin deletes a
 * chat (ON DELETE CASCADE from customers).
 */

export interface Migration {
  version: number;
  name: string;
  /** `vector` is "vector(768)" with pgvector, otherwise "real[]" (similarity is then computed in Node). */
  sql: (vector: string) => string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: (vector) => `
CREATE TABLE IF NOT EXISTS customers (
  id                BIGINT PRIMARY KEY,               -- Telegram user ID (= chat ID of the private chat)
  name              TEXT NOT NULL DEFAULT '',
  username          TEXT NOT NULL DEFAULT '',
  language          TEXT,
  first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_name      TEXT,
  stir              TEXT,
  phone             TEXT,
  email             TEXT,
  activity          TEXT,
  location          TEXT,
  mineral_type      TEXT,                             -- 'ruda' | 'noruda'
  mineral           TEXT,
  license_number    TEXT,
  license_expiry    DATE,
  preferences       TEXT,
  decisions         TEXT,
  next_contact_date DATE,
  facts             JSONB NOT NULL DEFAULT '{}'::jsonb,  -- every extracted fact with when it was said
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_last_seen ON customers (last_seen DESC);
CREATE INDEX IF NOT EXISTS customers_license_expiry ON customers (license_expiry);

CREATE TABLE IF NOT EXISTS companies (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name        TEXT,
  stir        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, stir)
);

CREATE TABLE IF NOT EXISTS licenses (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  number      TEXT,
  expires_on  DATE,
  mineral     TEXT,
  source      TEXT NOT NULL DEFAULT 'conversation',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, number)
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,                     -- "<source>:<chat id>", source = 'direct' or a business connection
  customer_id   BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_customer ON conversations (customer_id);

CREATE TABLE IF NOT EXISTS messages (
  id                  BIGSERIAL PRIMARY KEY,
  customer_id         BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK (role IN ('customer', 'bot', 'admin')),
  author              TEXT NOT NULL DEFAULT '',
  text                TEXT NOT NULL,
  language            TEXT,
  telegram_message_id BIGINT,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  import_key          TEXT UNIQUE                       -- set by the JSON import so it can run more than once
);
CREATE INDEX IF NOT EXISTS messages_customer_ts ON messages (customer_id, ts);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS messages_text_search ON messages USING GIN (to_tsvector('simple', text));

CREATE TABLE IF NOT EXISTS conversation_summaries (
  customer_id     BIGINT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL,
  analysis        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- topic, questions, needs, objections, outcome, next step
  last_message_id BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_memories (
  id                BIGSERIAL PRIMARY KEY,
  customer_id       BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,                    -- fact | question | answer | decision | preference | objection
  content           TEXT NOT NULL,
  source_message_id BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_memories_customer ON customer_memories (customer_id, created_at);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  message_id  BIGINT REFERENCES messages(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  model       TEXT NOT NULL,
  embedding   ${vector} NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id)
);
CREATE INDEX IF NOT EXISTS memory_embeddings_customer ON memory_embeddings (customer_id);

CREATE TABLE IF NOT EXISTS company_knowledge (
  key        TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  verified   BOOLEAN NOT NULL DEFAULT false,
  source     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_services (
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'interested',   -- interested | price_asked
  first_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, service)
);

CREATE TABLE IF NOT EXISTS sales_pipeline (
  customer_id BIGINT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL DEFAULT 'new',
  objections  TEXT[] NOT NULL DEFAULT '{}',
  next_step   TEXT,
  price_asked BOOLEAN NOT NULL DEFAULT false,
  offer_sent  BOOLEAN NOT NULL DEFAULT false,
  rejected    BOOLEAN NOT NULL DEFAULT false,
  complaint   BOOLEAN NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES customers(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  name        TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ,
  last_status TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS ai_requests (
  request_id           UUID PRIMARY KEY,
  chat_id              BIGINT,
  customer_id          BIGINT REFERENCES customers(id) ON DELETE CASCADE,
  admin_id             BIGINT,
  incoming_key         TEXT,
  request_type         TEXT NOT NULL,
  complexity           TEXT NOT NULL,
  context_completeness TEXT NOT NULL,
  selected_workflow    TEXT NOT NULL,
  workflow_path        TEXT[] NOT NULL DEFAULT '{}',
  confidence_score     REAL,
  confidence_level     TEXT,
  required_permissions TEXT[] NOT NULL DEFAULT '{}',
  execution_status     TEXT NOT NULL,
  final_result         TEXT,
  provider             TEXT,
  model                TEXT,
  topic                TEXT,
  service              TEXT,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ai_requests_created ON ai_requests (created_at);
CREATE INDEX IF NOT EXISTS ai_requests_customer ON ai_requests (customer_id, created_at);

CREATE TABLE IF NOT EXISTS ai_provider_logs (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  ok            BOOLEAN NOT NULL,
  failure       TEXT,
  error         TEXT,
  latency_ms    INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  attempt       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_provider_logs_created ON ai_provider_logs (created_at);

CREATE TABLE IF NOT EXISTS admin_messages (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   BIGINT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'assistant')),
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_messages_admin ON admin_messages (admin_id, id);

CREATE TABLE IF NOT EXISTS admin_state (
  admin_id   BIGINT PRIMARY KEY,
  focus      JSONB NOT NULL DEFAULT '{}'::jsonb,     -- last listed customers, the customer being discussed
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   BIGINT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   BIGINT,
  title      TEXT NOT NULL,
  format     TEXT NOT NULL,
  file_name  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT NOT NULL,
  event      TEXT NOT NULL,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created ON audit_logs (created_at);

-- Idempotency: one row per Telegram message handled, one reply per incoming message.
CREATE TABLE IF NOT EXISTS processed_updates (
  key        TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outgoing_replies (
  incoming_key TEXT PRIMARY KEY,
  customer_id  BIGINT REFERENCES customers(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  provider     TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Messages that could not be answered because every AI provider was down; retried until answered.
CREATE TABLE IF NOT EXISTS pending_replies (
  incoming_key TEXT PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  chat         JSONB NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  status       TEXT NOT NULL DEFAULT 'waiting',       -- waiting | done
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];
