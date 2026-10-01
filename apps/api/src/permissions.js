export const PERMISSIONS = Object.freeze([
  'company.manage', 'company.approve', 'users.manage', 'roles.manage',
  'catalog.read', 'catalog.manage', 'customers.read', 'customers.manage', 'suppliers.read', 'suppliers.manage',
  'inventory.read', 'inventory.manage',
  'purchasing.read', 'purchasing.create', 'purchasing.approve', 'purchasing.return',
  'sales.read', 'sales.create', 'sales.approve', 'sales.return',
  'sales.discount.override', 'pos.device.manage', 'pos.shift.open', 'pos.shift.close',
  'accounting.read', 'accounting.post', 'employees.read', 'employees.manage',
  'attendance.record', 'attendance.manage', 'overtime.approve', 'leaves.create', 'leaves.manage',
  'payroll.read', 'payroll.prepare', 'payroll.review', 'payroll.approve', 'payroll.pay', 'payroll.adjust', 'representatives.read', 'representatives.manage',
  'representatives.operate', 'representatives.collect', 'representatives.handover', 'representatives.review',
  'sync.use', 'audit.read'
]);

export const ROLE_TEMPLATES = Object.freeze({
  company_admin: PERMISSIONS.filter((permission) => permission !== 'company.approve'),
  accountant: ['accounting.read', 'accounting.post', 'sales.read', 'customers.read', 'suppliers.read', 'payroll.read', 'payroll.review', 'payroll.pay', 'audit.read', 'sync.use'],
  warehouse_keeper: ['catalog.read', 'suppliers.read', 'inventory.read', 'inventory.manage', 'purchasing.read', 'purchasing.create', 'sync.use'],
  cashier: ['catalog.read', 'customers.read', 'customers.manage', 'inventory.read', 'sales.read', 'sales.create', 'sales.approve', 'sales.return', 'pos.shift.open', 'pos.shift.close', 'sync.use'],
  representative: ['catalog.read', 'customers.read', 'inventory.read', 'sales.read', 'sales.create', 'sales.return', 'representatives.read', 'representatives.operate', 'representatives.collect', 'representatives.handover', 'sync.use'],
  representative_supervisor: ['catalog.read', 'customers.read', 'inventory.read', 'inventory.manage', 'sales.read', 'representatives.read', 'representatives.manage', 'representatives.review', 'sync.use'],
  employee: ['employees.read', 'attendance.record', 'leaves.create', 'sync.use'],
  hr: ['employees.read', 'employees.manage', 'attendance.record', 'attendance.manage', 'overtime.approve', 'leaves.create', 'leaves.manage', 'payroll.prepare', 'payroll.read', 'sync.use'],
  auditor: ['catalog.read', 'inventory.read', 'sales.read', 'accounting.read', 'employees.read', 'audit.read']
});
