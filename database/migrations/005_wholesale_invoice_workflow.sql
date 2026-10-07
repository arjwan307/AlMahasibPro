SELECT set_config('app.platform_access', 'true', true);

INSERT INTO permissions(code) VALUES
  ('sales.wholesale.submit'), ('sales.retail.submit'), ('sales.wholesale.review'),
  ('sales.wholesale.finalize'), ('sales.invoice.template.manage')
ON CONFLICT DO NOTHING;

INSERT INTO roles(company_id, code, name, system)
SELECT c.id, role.code, role.name, true
FROM companies c
CROSS JOIN (VALUES
  ('wholesale_representative', 'مندوب مبيعات جملة'),
  ('retail_representative', 'مندوب مبيعات مفرد'),
  ('wholesale_manager', 'مدير مبيعات الجملة'),
  ('general_manager', 'المدير العام')
) AS role(code, name)
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO role_permissions(company_id, role_id, permission_code)
SELECT r.company_id, r.id, p.code
FROM roles r
JOIN permissions p ON p.code = ANY(CASE r.code
  WHEN 'company_admin' THEN ARRAY[
    'sales.wholesale.submit','sales.retail.submit','sales.wholesale.review','sales.wholesale.finalize','sales.invoice.template.manage'
  ]::text[]
  WHEN 'wholesale_representative' THEN ARRAY['catalog.read','customers.read','inventory.read','sales.read','sales.create','sales.wholesale.submit','sync.use']::text[]
  WHEN 'retail_representative' THEN ARRAY['catalog.read','customers.read','inventory.read','sales.read','sales.create','sales.retail.submit','sync.use']::text[]
  WHEN 'wholesale_manager' THEN ARRAY['catalog.read','customers.read','inventory.read','sales.read','sales.approve','sales.wholesale.review','sync.use']::text[]
  WHEN 'general_manager' THEN ARRAY['catalog.read','customers.read','inventory.read','sales.read','sales.approve','sales.wholesale.finalize','sales.invoice.template.manage','sync.use']::text[]
  ELSE ARRAY[]::text[]
END)
WHERE r.code IN ('company_admin','wholesale_representative','retail_representative','wholesale_manager','general_manager')
ON CONFLICT DO NOTHING;
