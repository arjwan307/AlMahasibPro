SELECT set_config('app.platform_access', 'true', true);

INSERT INTO permissions(code) VALUES
  ('sales.discount.override'), ('pos.device.manage'), ('pos.shift.open'), ('pos.shift.close')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(company_id, role_id, permission_code)
SELECT r.company_id, r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE (r.code = 'company_admin' AND p.code IN ('sales.discount.override','pos.device.manage','pos.shift.open','pos.shift.close'))
   OR (r.code = 'cashier' AND p.code IN ('pos.shift.open','pos.shift.close'))
ON CONFLICT DO NOTHING;

CREATE TABLE item_barcodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  item_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  barcode text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, barcode),
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, id)
);

CREATE TABLE pos_devices (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid,
  warehouse_id uuid NOT NULL,
  code citext NOT NULL,
  name text NOT NULL,
  interface_mode text NOT NULL CHECK (interface_mode IN ('restaurant','market','enterprise')),
  offline_enabled boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses(company_id, id)
);

CREATE TABLE pos_discount_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  device_id uuid,
  max_discount_percent numeric(9, 6) NOT NULL DEFAULT 0 CHECK (max_discount_percent BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, device_id),
  FOREIGN KEY (company_id, device_id) REFERENCES pos_devices(company_id, id)
);
CREATE UNIQUE INDEX pos_discount_policy_company_default ON pos_discount_policies(company_id) WHERE device_id IS NULL;

CREATE TABLE pos_shifts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  device_id uuid NOT NULL,
  opened_by uuid NOT NULL,
  closed_by uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted_pending_sync','closed')),
  opening_float numeric(20, 6) NOT NULL CHECK (opening_float >= 0),
  expected_cash numeric(20, 6),
  counted_cash numeric(20, 6),
  variance numeric(20, 6),
  opened_at timestamptz NOT NULL,
  close_submitted_at timestamptz,
  closed_at timestamptz,
  open_operation_id uuid NOT NULL,
  close_operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, open_operation_id),
  UNIQUE (company_id, close_operation_id),
  FOREIGN KEY (company_id, device_id) REFERENCES pos_devices(company_id, id),
  CHECK ((status = 'open' AND counted_cash IS NULL AND variance IS NULL) OR status <> 'open')
);
CREATE UNIQUE INDEX pos_one_open_shift_per_device ON pos_shifts(company_id, device_id) WHERE status IN ('open','submitted_pending_sync');

CREATE TABLE offline_allocations (
  company_id uuid NOT NULL REFERENCES companies(id),
  device_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  item_id uuid NOT NULL,
  allocated_quantity numeric(20, 6) NOT NULL CHECK (allocated_quantity >= 0),
  consumed_quantity numeric(20, 6) NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
  version bigint NOT NULL DEFAULT 0,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, device_id, item_id),
  FOREIGN KEY (company_id, device_id) REFERENCES pos_devices(company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses(company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id),
  CHECK (consumed_quantity <= allocated_quantity)
);

ALTER TABLE commerce_documents
  ADD COLUMN gross_amount numeric(20, 6),
  ADD COLUMN discount_amount numeric(20, 6) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  ADD COLUMN pos_shift_id uuid,
  ADD COLUMN interface_mode text CHECK (interface_mode IN ('restaurant','market','enterprise')),
  ADD COLUMN order_context jsonb NOT NULL DEFAULT '{}',
  ADD CONSTRAINT commerce_gross_discount_check CHECK (
    (gross_amount IS NULL AND discount_amount = 0) OR
    (gross_amount IS NOT NULL AND gross_amount >= discount_amount AND subtotal = gross_amount - discount_amount)
  ),
  ADD CONSTRAINT commerce_pos_shift_fk FOREIGN KEY (company_id, pos_shift_id) REFERENCES pos_shifts(company_id, id);

CREATE TABLE pos_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  document_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  receipt_number text NOT NULL,
  print_count integer NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  receipt_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, receipt_number),
  UNIQUE (company_id, document_id),
  FOREIGN KEY (company_id, document_id) REFERENCES commerce_documents(company_id, id),
  FOREIGN KEY (company_id, shift_id) REFERENCES pos_shifts(company_id, id)
);

CREATE FUNCTION protect_closed_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'closed' THEN
    RAISE EXCEPTION 'closed shifts are immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pos_shifts_protect BEFORE UPDATE OR DELETE ON pos_shifts FOR EACH ROW EXECUTE FUNCTION protect_closed_shift();
CREATE TRIGGER pos_receipts_immutable BEFORE UPDATE OR DELETE ON pos_receipts FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'item_barcodes','pos_devices','pos_discount_policies','pos_shifts','offline_allocations','pos_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = current_company_id()) WITH CHECK (company_id = current_company_id())', table_name
    );
    EXECUTE format(
      'CREATE POLICY platform_isolation ON %I USING (current_setting(''app.platform_access'', true) = ''true'') WITH CHECK (current_setting(''app.platform_access'', true) = ''true'')', table_name
    );
  END LOOP;
END
$$;
