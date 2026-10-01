CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code citext NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9_-]{2,31}$'),
  legal_name text NOT NULL CHECK (length(trim(legal_name)) > 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  timezone text NOT NULL DEFAULT 'Asia/Baghdad',
  currency varchar(3) NOT NULL DEFAULT 'IQD',
  owner_user_id uuid,
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code citext NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE permissions (
  code text PRIMARY KEY,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code citext NOT NULL,
  name text NOT NULL,
  system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE role_permissions (
  company_id uuid NOT NULL REFERENCES companies(id),
  role_id uuid NOT NULL,
  permission_code text NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (company_id, role_id, permission_code),
  FOREIGN KEY (company_id, role_id) REFERENCES roles(company_id, id)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id),
  username citext NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((platform_admin AND company_id IS NULL) OR (NOT platform_admin AND company_id IS NOT NULL)),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX users_company_username_unique ON users (company_id, username) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX users_platform_username_unique ON users (username) WHERE platform_admin;

ALTER TABLE companies
  ADD CONSTRAINT companies_owner_user_fk FOREIGN KEY (owner_user_id) REFERENCES users(id),
  ADD CONSTRAINT companies_approved_by_fk FOREIGN KEY (approved_by) REFERENCES users(id);

CREATE TABLE user_roles (
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  PRIMARY KEY (company_id, user_id, role_id),
  FOREIGN KEY (company_id, user_id) REFERENCES users(company_id, id),
  FOREIGN KEY (company_id, role_id) REFERENCES roles(company_id, id)
);

CREATE TABLE user_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('company', 'branch', 'warehouse', 'pos', 'customers')),
  scope_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id, scope_type, scope_id),
  FOREIGN KEY (company_id, user_id) REFERENCES users(company_id, id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash char(64) NOT NULL UNIQUE,
  device_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE sync_operations (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  operation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  client_sequence bigint NOT NULL CHECK (client_sequence > 0),
  schema_version integer NOT NULL DEFAULT 1,
  entity_version bigint,
  dependencies jsonb NOT NULL DEFAULT '[]',
  operation_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload_hash char(64) NOT NULL,
  payload jsonb NOT NULL,
  result jsonb NOT NULL,
  UNIQUE (company_id, operation_id),
  UNIQUE (company_id, device_id, client_sequence)
);

CREATE TABLE sync_changes (
  sequence bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('upsert', 'tombstone')),
  payload jsonb,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_changes_company_cursor_idx ON sync_changes (company_id, sequence);

CREATE TABLE financial_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  source_operation_id uuid NOT NULL,
  kind text NOT NULL,
  amount numeric(20, 6) NOT NULL,
  currency varchar(3) NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_operation_id)
);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  entry_number text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
  currency varchar(3) NOT NULL,
  description text NOT NULL,
  occurred_at timestamptz NOT NULL,
  reversal_of uuid,
  posted_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, entry_number),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, reversal_of) REFERENCES journal_entries(company_id, id)
);

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  journal_entry_id uuid NOT NULL,
  account_code text NOT NULL,
  debit numeric(20, 6) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(20, 6) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_company_time_idx ON audit_events (company_id, created_at DESC);

CREATE FUNCTION current_company_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;

CREATE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable financial or audit record';
END
$$;

CREATE TRIGGER financial_records_immutable BEFORE UPDATE OR DELETE ON financial_records
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE FUNCTION protect_posted_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'posted journal entries are immutable; create a reversal';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_entries_protect BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION protect_posted_journal();

CREATE FUNCTION protect_posted_journal_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_status text;
BEGIN
  SELECT status INTO entry_status FROM journal_entries WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);
  IF TG_OP = 'DELETE' OR entry_status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'posted journal lines are immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_lines_protect BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION protect_posted_journal_line();

CREATE FUNCTION validate_posted_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE debit_total numeric(20, 6); credit_total numeric(20, 6);
BEGIN
  IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' THEN
    SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
      INTO debit_total, credit_total FROM journal_lines
      WHERE company_id = NEW.company_id AND journal_entry_id = NEW.id;
    IF debit_total = 0 OR debit_total <> credit_total THEN
      RAISE EXCEPTION 'journal entry must be balanced before posting';
    END IF;
    NEW.posted_at = now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_entries_balance BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION validate_posted_journal();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'branches','roles','role_permissions','users','user_roles','user_scopes',
    'sync_operations','sync_changes','financial_records','journal_entries','journal_lines','audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = current_company_id()) WITH CHECK (company_id = current_company_id())',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY platform_isolation ON %I USING (current_setting(''app.platform_access'', true) = ''true'') WITH CHECK (current_setting(''app.platform_access'', true) = ''true'')',
      table_name
    );
  END LOOP;
END
$$;
