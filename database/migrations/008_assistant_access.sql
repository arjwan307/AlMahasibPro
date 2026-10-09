INSERT INTO permissions(code) VALUES ('assistant.use') ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(company_id, role_id, permission_code)
SELECT company_id, id, 'assistant.use'
FROM roles
WHERE company_id IS NOT NULL
  AND code IN (
    'company_admin','accountant','warehouse_keeper','cashier','representative',
    'representative_supervisor','wholesale_representative','retail_representative',
    'wholesale_manager','general_manager','employee','hr','auditor'
  )
ON CONFLICT DO NOTHING;
