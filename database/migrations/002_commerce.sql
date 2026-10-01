SELECT set_config('app.platform_access', 'true', true);

CREATE TABLE units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code citext NOT NULL,
  name text NOT NULL,
  decimal_places smallint NOT NULL DEFAULT 3 CHECK (decimal_places BETWEEN 0 AND 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

INSERT INTO permissions(code) VALUES
  ('purchasing.read'), ('purchasing.create'), ('purchasing.approve'), ('purchasing.return'),
  ('customers.read'), ('customers.manage'), ('suppliers.read'), ('suppliers.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(company_id, role_id, permission_code)
SELECT r.company_id, r.id, p.code
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'company_admin'
  AND p.code IN ('purchasing.read','purchasing.create','purchasing.approve','purchasing.return',
                 'customers.read','customers.manage','suppliers.read','suppliers.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(company_id, role_id, permission_code)
SELECT r.company_id, r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE (r.code = 'cashier' AND p.code IN ('customers.read','customers.manage','sales.approve'))
   OR (r.code = 'warehouse_keeper' AND p.code = 'suppliers.read')
   OR (r.code = 'accountant' AND p.code IN ('customers.read','suppliers.read'))
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(company_id, role_id, permission_code)
SELECT r.company_id, r.id, p.code
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'warehouse_keeper'
  AND p.code IN ('purchasing.read','purchasing.create')
ON CONFLICT DO NOTHING;

CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  sku citext NOT NULL,
  name text NOT NULL,
  base_unit_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sku),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, base_unit_id) REFERENCES units(company_id, id)
);

CREATE TABLE item_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  item_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  conversion_factor numeric(20, 6) NOT NULL CHECK (conversion_factor > 0),
  is_base boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, item_id, unit_id),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, id),
  CHECK (NOT is_base OR conversion_factor = 1)
);

CREATE UNIQUE INDEX item_units_one_base ON item_units (company_id, item_id) WHERE is_base;

CREATE TABLE prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  item_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  price_type text NOT NULL CHECK (price_type IN ('sale', 'purchase')),
  currency varchar(3) NOT NULL,
  amount numeric(20, 6) NOT NULL CHECK (amount >= 0),
  active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, item_id, unit_id, price_type, currency, valid_from),
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code citext NOT NULL,
  name text NOT NULL,
  phone text,
  credit_limit numeric(20, 6) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code citext NOT NULL,
  name text NOT NULL,
  phone text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid,
  code citext NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'vehicle', 'pos')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id)
);

CREATE TABLE stock_balances (
  company_id uuid NOT NULL REFERENCES companies(id),
  warehouse_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(20, 6) NOT NULL DEFAULT 0,
  average_cost numeric(20, 6) NOT NULL DEFAULT 0 CHECK (average_cost >= 0),
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, warehouse_id, item_id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses(company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id)
);

CREATE TABLE commerce_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  document_type text NOT NULL CHECK (document_type IN ('purchase', 'sale', 'purchase_return', 'sale_return')),
  document_number text NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  warehouse_id uuid NOT NULL,
  customer_id uuid,
  supplier_id uuid,
  original_document_id uuid,
  currency varchar(3) NOT NULL,
  subtotal numeric(20, 6) NOT NULL CHECK (subtotal >= 0),
  paid_amount numeric(20, 6) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  due_amount numeric(20, 6) NOT NULL DEFAULT 0 CHECK (due_amount >= 0),
  operation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, document_type, document_number),
  UNIQUE (company_id, operation_id),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses(company_id, id),
  FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id),
  FOREIGN KEY (company_id, supplier_id) REFERENCES suppliers(company_id, id),
  FOREIGN KEY (company_id, original_document_id) REFERENCES commerce_documents(company_id, id),
  CHECK (
    (document_type IN ('sale', 'sale_return') AND supplier_id IS NULL) OR
    (document_type IN ('purchase', 'purchase_return') AND customer_id IS NULL)
  ),
  CHECK (
    (document_type IN ('purchase_return', 'sale_return') AND original_document_id IS NOT NULL) OR
    (document_type IN ('purchase', 'sale') AND original_document_id IS NULL)
  ),
  CHECK (subtotal = paid_amount + due_amount)
);

CREATE TABLE commerce_document_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  document_id uuid NOT NULL,
  item_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  original_line_id uuid,
  quantity numeric(20, 6) NOT NULL CHECK (quantity > 0),
  conversion_factor numeric(20, 6) NOT NULL CHECK (conversion_factor > 0),
  base_quantity numeric(20, 6) NOT NULL CHECK (base_quantity > 0),
  unit_price numeric(20, 6) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(20, 6) NOT NULL CHECK (line_total >= 0),
  unit_cost numeric(20, 6) NOT NULL CHECK (unit_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES commerce_documents(company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, id),
  FOREIGN KEY (company_id, original_line_id) REFERENCES commerce_document_lines(company_id, id),
  CHECK (base_quantity = round(quantity * conversion_factor, 6)),
  CHECK (line_total = round(quantity * unit_price, 6))
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  document_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('cash', 'bank', 'card')),
  amount numeric(20, 6) NOT NULL CHECK (amount > 0),
  reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, document_id) REFERENCES commerce_documents(company_id, id)
);

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  document_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  movement_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, document_id),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES commerce_documents(company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses(company_id, id)
);

CREATE TABLE stock_movement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  movement_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity_delta numeric(20, 6) NOT NULL CHECK (quantity_delta <> 0),
  unit_cost numeric(20, 6) NOT NULL CHECK (unit_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, movement_id) REFERENCES stock_movements(company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id)
);

CREATE TABLE server_outbox (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (company_id, event_id)
);

CREATE FUNCTION protect_posted_commerce() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'posted commerce records are immutable; create a return or reversal';
END
$$;

CREATE TRIGGER commerce_documents_immutable BEFORE UPDATE OR DELETE ON commerce_documents FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();
CREATE TRIGGER commerce_lines_immutable BEFORE UPDATE OR DELETE ON commerce_document_lines FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();
CREATE TRIGGER stock_movement_lines_immutable BEFORE UPDATE OR DELETE ON stock_movement_lines FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'units','items','item_units','prices','customers','suppliers','warehouses','stock_balances',
    'commerce_documents','commerce_document_lines','payments','stock_movements','stock_movement_lines','server_outbox'
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
