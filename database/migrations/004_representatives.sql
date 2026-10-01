SELECT set_config('app.platform_access', 'true', true);

INSERT INTO permissions(code) VALUES
  ('representatives.read'), ('representatives.operate'), ('representatives.collect'),
  ('representatives.handover'), ('representatives.review')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(company_id, role_id, permission_code)
SELECT r.company_id, r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE (r.code = 'company_admin' AND p.code LIKE 'representatives.%')
   OR (r.code = 'representative' AND p.code IN ('representatives.read','representatives.operate','representatives.collect','representatives.handover'))
   OR (r.code = 'representative_supervisor' AND p.code IN ('representatives.read','representatives.manage','representatives.review','inventory.manage'))
ON CONFLICT DO NOTHING;

CREATE TABLE representatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL,
  vehicle_warehouse_id uuid NOT NULL,
  code citext NOT NULL,
  name text NOT NULL,
  device_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id), UNIQUE(company_id,user_id), UNIQUE(company_id,code),
  FOREIGN KEY(company_id,user_id) REFERENCES users(company_id,id),
  FOREIGN KEY(company_id,vehicle_warehouse_id) REFERENCES warehouses(company_id,id)
);

CREATE TABLE representative_customers (
  company_id uuid NOT NULL REFERENCES companies(id),
  representative_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  visit_order integer NOT NULL DEFAULT 0 CHECK(visit_order >= 0),
  credit_limit numeric(20,6) CHECK(credit_limit >= 0),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(company_id,representative_id,customer_id),
  FOREIGN KEY(company_id,representative_id) REFERENCES representatives(company_id,id),
  FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id)
);

CREATE TABLE representative_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  representative_id uuid NOT NULL, code citext NOT NULL, name text NOT NULL,
  route_date date, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id), UNIQUE(company_id,code),
  FOREIGN KEY(company_id,representative_id) REFERENCES representatives(company_id,id)
);

CREATE TABLE representative_route_stops (
  company_id uuid NOT NULL REFERENCES companies(id), route_id uuid NOT NULL,
  customer_id uuid NOT NULL, stop_order integer NOT NULL CHECK(stop_order > 0), note text,
  PRIMARY KEY(company_id,route_id,customer_id), UNIQUE(company_id,route_id,stop_order),
  FOREIGN KEY(company_id,route_id) REFERENCES representative_routes(company_id,id),
  FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id)
);

CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  representative_id uuid, source_warehouse_id uuid NOT NULL, destination_warehouse_id uuid NOT NULL,
  transfer_number text NOT NULL, status text NOT NULL DEFAULT 'posted' CHECK(status='posted'),
  operation_id uuid NOT NULL, occurred_at timestamptz NOT NULL, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id), UNIQUE(company_id,transfer_number), UNIQUE(company_id,operation_id),
  FOREIGN KEY(company_id,representative_id) REFERENCES representatives(company_id,id),
  FOREIGN KEY(company_id,source_warehouse_id) REFERENCES warehouses(company_id,id),
  FOREIGN KEY(company_id,destination_warehouse_id) REFERENCES warehouses(company_id,id),
  CHECK(source_warehouse_id <> destination_warehouse_id)
);

CREATE TABLE stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  transfer_id uuid NOT NULL, item_id uuid NOT NULL, quantity numeric(20,6) NOT NULL CHECK(quantity>0),
  unit_cost numeric(20,6) NOT NULL CHECK(unit_cost>=0), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id), UNIQUE(company_id,transfer_id,item_id),
  FOREIGN KEY(company_id,transfer_id) REFERENCES stock_transfers(company_id,id),
  FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id)
);

CREATE TABLE representative_orders (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), representative_id uuid NOT NULL,
  customer_id uuid NOT NULL, order_number text NOT NULL, currency char(3) NOT NULL,
  total numeric(20,6) NOT NULL CHECK(total>=0), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','converted')),
  operation_id uuid NOT NULL, sale_document_id uuid, occurred_at timestamptz NOT NULL, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id), UNIQUE(company_id,order_number), UNIQUE(company_id,operation_id),
  FOREIGN KEY(company_id,representative_id) REFERENCES representatives(company_id,id),
  FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),
  FOREIGN KEY(company_id,sale_document_id) REFERENCES commerce_documents(company_id,id)
);

CREATE TABLE representative_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), order_id uuid NOT NULL,
  item_id uuid NOT NULL, unit_id uuid NOT NULL, quantity numeric(20,6) NOT NULL CHECK(quantity>0),
  unit_price numeric(20,6) NOT NULL CHECK(unit_price>=0), line_total numeric(20,6) NOT NULL CHECK(line_total>=0),
  UNIQUE(company_id,id), FOREIGN KEY(company_id,order_id) REFERENCES representative_orders(company_id,id),
  FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id), FOREIGN KEY(company_id,unit_id) REFERENCES units(company_id,id)
);

ALTER TABLE commerce_documents ADD COLUMN representative_id uuid,
  ADD CONSTRAINT commerce_representative_fk FOREIGN KEY(company_id,representative_id) REFERENCES representatives(company_id,id);

CREATE TABLE customer_debt_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), customer_id uuid NOT NULL,
  representative_id uuid, document_id uuid, operation_id uuid NOT NULL, movement_type text NOT NULL CHECK(movement_type IN ('sale','sale_return','collection')),
  amount numeric(20,6) NOT NULL CHECK(amount<>0), currency char(3) NOT NULL, occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,operation_id,movement_type),
  FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),
  FOREIGN KEY(company_id,representative_id) REFERENCES representatives(company_id,id),
  FOREIGN KEY(company_id,document_id) REFERENCES commerce_documents(company_id,id)
);

INSERT INTO customer_debt_movements(company_id,customer_id,document_id,operation_id,movement_type,amount,currency,occurred_at)
SELECT company_id,customer_id,id,operation_id,
  CASE WHEN document_type='sale' THEN 'sale' ELSE 'sale_return' END,
  CASE WHEN document_type='sale' THEN due_amount ELSE -due_amount END,currency,occurred_at
FROM commerce_documents WHERE customer_id IS NOT NULL AND due_amount>0 AND document_type IN ('sale','sale_return')
ON CONFLICT DO NOTHING;

CREATE TABLE representative_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), representative_id uuid NOT NULL,
  customer_id uuid NOT NULL, receipt_number text NOT NULL, amount numeric(20,6) NOT NULL CHECK(amount>0), currency char(3) NOT NULL,
  operation_id uuid NOT NULL, occurred_at timestamptz NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id), UNIQUE(company_id,receipt_number), UNIQUE(company_id,operation_id),
  FOREIGN KEY(company_id,representative_id) REFERENCES representatives(company_id,id),
  FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id)
);

CREATE TABLE representative_custody_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), representative_id uuid NOT NULL,
  operation_id uuid NOT NULL, movement_type text NOT NULL CHECK(movement_type IN ('sale_cash','return_cash','collection','cash_handover')),
  amount numeric(20,6) NOT NULL CHECK(amount<>0), currency char(3) NOT NULL, reference_type text NOT NULL, reference_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,operation_id,movement_type), FOREIGN KEY(company_id,representative_id) REFERENCES representatives(company_id,id)
);

CREATE TABLE representative_handovers (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), representative_id uuid NOT NULL,
  destination_warehouse_id uuid NOT NULL, handover_number text NOT NULL,
  expected_cash numeric(20,6) NOT NULL CHECK(expected_cash>=0), submitted_cash numeric(20,6) NOT NULL CHECK(submitted_cash>=0),
  reviewed_cash numeric(20,6), cash_variance numeric(20,6), currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','reviewed')),
  submit_operation_id uuid NOT NULL, review_operation_id uuid, submitted_at timestamptz NOT NULL, reviewed_at timestamptz,
  submitted_by uuid NOT NULL, reviewed_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id), UNIQUE(company_id,handover_number), UNIQUE(company_id,submit_operation_id), UNIQUE(company_id,review_operation_id),
  FOREIGN KEY(company_id,representative_id) REFERENCES representatives(company_id,id),
  FOREIGN KEY(company_id,destination_warehouse_id) REFERENCES warehouses(company_id,id)
);

CREATE TABLE representative_handover_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), handover_id uuid NOT NULL,
  item_id uuid NOT NULL, quantity numeric(20,6) NOT NULL CHECK(quantity>0),
  UNIQUE(company_id,id), UNIQUE(company_id,handover_id,item_id),
  FOREIGN KEY(company_id,handover_id) REFERENCES representative_handovers(company_id,id),
  FOREIGN KEY(company_id,item_id) REFERENCES items(company_id,id)
);

CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), user_id uuid NOT NULL,
  device_id text NOT NULL, operation_id uuid NOT NULL, code text NOT NULL, message text, resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,operation_id),
  FOREIGN KEY(company_id,user_id) REFERENCES users(company_id,id)
);

CREATE TRIGGER stock_transfers_immutable BEFORE UPDATE OR DELETE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();
CREATE TRIGGER stock_transfer_lines_immutable BEFORE UPDATE OR DELETE ON stock_transfer_lines FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();
CREATE TRIGGER debt_movements_immutable BEFORE UPDATE OR DELETE ON customer_debt_movements FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();
CREATE TRIGGER collections_immutable BEFORE UPDATE OR DELETE ON representative_collections FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();
CREATE TRIGGER custody_movements_immutable BEFORE UPDATE OR DELETE ON representative_custody_movements FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'representatives','representative_customers','representative_routes','representative_route_stops',
    'stock_transfers','stock_transfer_lines','representative_orders','representative_order_lines',
    'customer_debt_movements','representative_collections','representative_custody_movements',
    'representative_handovers','representative_handover_lines','sync_conflicts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (company_id=current_company_id()) WITH CHECK (company_id=current_company_id())',table_name);
    EXECUTE format('CREATE POLICY platform_isolation ON %I USING (current_setting(''app.platform_access'',true)=''true'') WITH CHECK (current_setting(''app.platform_access'',true)=''true'')',table_name);
  END LOOP;
END $$;
