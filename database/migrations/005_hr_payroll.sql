SELECT set_config('app.platform_access','true',true);

INSERT INTO permissions(code) VALUES
 ('attendance.record'),('attendance.manage'),('overtime.approve'),('leaves.create'),('leaves.manage'),
 ('payroll.read'),('payroll.review'),('payroll.pay'),('payroll.adjust') ON CONFLICT DO NOTHING;

INSERT INTO roles(company_id,code,name,system)
SELECT id,'employee','employee',true FROM companies ON CONFLICT(company_id,code) DO NOTHING;

INSERT INTO role_permissions(company_id,role_id,permission_code)
SELECT r.company_id,r.id,p.code FROM roles r CROSS JOIN permissions p
WHERE (r.code='company_admin' AND p.code IN ('attendance.record','attendance.manage','overtime.approve','leaves.create','leaves.manage','payroll.read','payroll.review','payroll.pay','payroll.adjust'))
 OR (r.code='hr' AND p.code IN ('attendance.record','attendance.manage','overtime.approve','leaves.create','leaves.manage','payroll.read'))
 OR (r.code='accountant' AND p.code IN ('payroll.read','payroll.review','payroll.pay'))
 OR (r.code='employee' AND p.code IN ('employees.read','attendance.record','leaves.create','sync.use'))
ON CONFLICT DO NOTHING;

CREATE TABLE departments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
 code citext NOT NULL,name text NOT NULL,active boolean NOT NULL DEFAULT true,
 UNIQUE(company_id,id),UNIQUE(company_id,code)
);

CREATE TABLE employees(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),user_id uuid,
 department_id uuid,code citext NOT NULL,full_name text NOT NULL,job_title text NOT NULL,
 hire_date date NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended','terminated')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,code),UNIQUE(company_id,user_id),
 FOREIGN KEY(company_id,user_id) REFERENCES users(company_id,id),FOREIGN KEY(company_id,department_id) REFERENCES departments(company_id,id)
);

CREATE TABLE employee_contracts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),employee_id uuid NOT NULL,
 contract_number text NOT NULL,start_date date NOT NULL,end_date date,basic_salary numeric(20,6) NOT NULL CHECK(basic_salary>=0),
 currency char(3) NOT NULL,pay_frequency text NOT NULL DEFAULT 'monthly' CHECK(pay_frequency='monthly'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','ended')),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,contract_number),FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),
 CHECK(end_date IS NULL OR end_date>=start_date)
);
CREATE UNIQUE INDEX one_active_contract_per_employee ON employee_contracts(company_id,employee_id) WHERE status='active';

CREATE TABLE employee_recurring_components(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),employee_id uuid NOT NULL,
 code citext NOT NULL,name text NOT NULL,component_type text NOT NULL CHECK(component_type IN('allowance','deduction')),
 amount numeric(20,6) NOT NULL CHECK(amount>=0),active boolean NOT NULL DEFAULT true,
 UNIQUE(company_id,id),UNIQUE(company_id,employee_id,code),FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id)
);

CREATE TABLE employee_advances(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),employee_id uuid NOT NULL,
 advance_number text NOT NULL,original_amount numeric(20,6) NOT NULL CHECK(original_amount>0),
 remaining_amount numeric(20,6) NOT NULL CHECK(remaining_amount>=0),installment_amount numeric(20,6) NOT NULL CHECK(installment_amount>0),
 currency char(3) NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN('active','settled')),
 granted_at date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,advance_number),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),CHECK(remaining_amount<=original_amount)
);

CREATE TABLE work_shifts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),code citext NOT NULL,name text NOT NULL,
 start_time time NOT NULL,end_time time NOT NULL,break_minutes integer NOT NULL DEFAULT 0 CHECK(break_minutes>=0),
 grace_minutes integer NOT NULL DEFAULT 0 CHECK(grace_minutes>=0),active boolean NOT NULL DEFAULT true,
 UNIQUE(company_id,id),UNIQUE(company_id,code)
);
CREATE TABLE employee_shift_assignments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),employee_id uuid NOT NULL,shift_id uuid NOT NULL,
 effective_from date NOT NULL,effective_to date,UNIQUE(company_id,id),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),FOREIGN KEY(company_id,shift_id) REFERENCES work_shifts(company_id,id),
 CHECK(effective_to IS NULL OR effective_to>=effective_from)
);

CREATE TABLE attendance_events(
 id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES companies(id),employee_id uuid NOT NULL,
 event_type text NOT NULL CHECK(event_type IN('check_in','check_out')),event_time timestamptz NOT NULL,
 source text NOT NULL DEFAULT 'web' CHECK(source IN('web','mobile','terminal','manual')),
 operation_id uuid NOT NULL,device_id text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,operation_id),FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id)
);

CREATE TABLE overtime_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),employee_id uuid NOT NULL,
 work_date date NOT NULL,minutes integer NOT NULL CHECK(minutes>0),multiplier numeric(9,6) NOT NULL CHECK(multiplier>0),reason text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
 requested_by uuid NOT NULL,approved_by uuid,approved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id)
);

CREATE TABLE leave_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),employee_id uuid NOT NULL,
 leave_type text NOT NULL,start_date date NOT NULL,end_date date NOT NULL,paid boolean NOT NULL DEFAULT true,reason text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
 requested_by uuid NOT NULL,approved_by uuid,approved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),CHECK(end_date>=start_date)
);

CREATE TABLE payroll_settings(
 company_id uuid PRIMARY KEY REFERENCES companies(id),working_days_per_month integer NOT NULL DEFAULT 30 CHECK(working_days_per_month BETWEEN 1 AND 31),
 daily_hours numeric(9,6) NOT NULL DEFAULT 8 CHECK(daily_hours>0),default_overtime_multiplier numeric(9,6) NOT NULL DEFAULT 1.5 CHECK(default_overtime_multiplier>0),
 deduct_absence boolean NOT NULL DEFAULT false,attendance_required boolean NOT NULL DEFAULT false,
 updated_by uuid,updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payroll_cycles(
 id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES companies(id),cycle_code citext NOT NULL,period_start date NOT NULL,period_end date NOT NULL,
 currency char(3) NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','reviewed','approved','paid')),
 total_gross numeric(20,6) NOT NULL DEFAULT 0,total_deductions numeric(20,6) NOT NULL DEFAULT 0,total_net numeric(20,6) NOT NULL DEFAULT 0,
 calculation_snapshot jsonb NOT NULL DEFAULT '{}',created_by uuid NOT NULL,reviewed_by uuid,approved_by uuid,paid_by uuid,
 reviewed_at timestamptz,approved_at timestamptz,paid_at timestamptz,approve_operation_id uuid,pay_operation_id uuid,
 accrual_journal_id uuid,payment_journal_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,cycle_code),UNIQUE(company_id,approve_operation_id),UNIQUE(company_id,pay_operation_id),CHECK(period_end>=period_start)
);

CREATE TABLE payroll_lines(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),cycle_id uuid NOT NULL,employee_id uuid NOT NULL,
 contract_id uuid NOT NULL,basic_salary numeric(20,6) NOT NULL,base_earned numeric(20,6) NOT NULL,allowances numeric(20,6) NOT NULL,
 overtime_amount numeric(20,6) NOT NULL,absence_deduction numeric(20,6) NOT NULL,recurring_deductions numeric(20,6) NOT NULL,
 advance_deduction numeric(20,6) NOT NULL,gross_amount numeric(20,6) NOT NULL,total_deductions numeric(20,6) NOT NULL,net_amount numeric(20,6) NOT NULL CHECK(net_amount>=0),
 attendance_days integer NOT NULL,absence_days integer NOT NULL,overtime_minutes integer NOT NULL,snapshot jsonb NOT NULL,
 UNIQUE(company_id,id),UNIQUE(company_id,cycle_id,employee_id),FOREIGN KEY(company_id,cycle_id) REFERENCES payroll_cycles(company_id,id),
 FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id),FOREIGN KEY(company_id,contract_id) REFERENCES employee_contracts(company_id,id)
);

CREATE TABLE payroll_line_components(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),payroll_line_id uuid NOT NULL,
 component_type text NOT NULL CHECK(component_type IN('base','allowance','overtime','absence','deduction','advance')),
 code text NOT NULL,name text NOT NULL,amount numeric(20,6) NOT NULL CHECK(amount>=0),source_id uuid,
 UNIQUE(company_id,id),FOREIGN KEY(company_id,payroll_line_id) REFERENCES payroll_lines(company_id,id)
);

CREATE TABLE payroll_payments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),cycle_id uuid NOT NULL,
 payment_number text NOT NULL,amount numeric(20,6) NOT NULL CHECK(amount>0),currency char(3) NOT NULL,
 operation_id uuid NOT NULL,paid_at timestamptz NOT NULL,paid_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,cycle_id),UNIQUE(company_id,payment_number),UNIQUE(company_id,operation_id),
 FOREIGN KEY(company_id,cycle_id) REFERENCES payroll_cycles(company_id,id)
);

CREATE TABLE payroll_adjustments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),cycle_id uuid NOT NULL,employee_id uuid NOT NULL,
 adjustment_number text NOT NULL,adjustment_type text NOT NULL CHECK(adjustment_type IN('earning','deduction')),
 amount numeric(20,6) NOT NULL CHECK(amount>0),currency char(3) NOT NULL,reason text NOT NULL,
 operation_id uuid NOT NULL,journal_entry_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,adjustment_number),UNIQUE(company_id,operation_id),
 FOREIGN KEY(company_id,cycle_id) REFERENCES payroll_cycles(company_id,id),FOREIGN KEY(company_id,employee_id) REFERENCES employees(company_id,id)
);

CREATE FUNCTION protect_payroll_cycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'payroll cycles cannot be deleted'; END IF;
 IF OLD.status IN('approved','paid') THEN
   IF OLD.status='approved' AND NEW.status='paid' AND
      (OLD.total_gross,OLD.total_deductions,OLD.total_net,OLD.period_start,OLD.period_end)=(NEW.total_gross,NEW.total_deductions,NEW.total_net,NEW.period_start,NEW.period_end)
   THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'approved payroll cycle is locked; create an adjustment';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_cycles_lock BEFORE UPDATE OR DELETE ON payroll_cycles FOR EACH ROW EXECUTE FUNCTION protect_payroll_cycle();

CREATE FUNCTION protect_locked_payroll_line() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE cycle_status text; BEGIN
 SELECT status INTO cycle_status FROM payroll_cycles WHERE company_id=OLD.company_id AND id=OLD.cycle_id;
 IF cycle_status IN('approved','paid') THEN RAISE EXCEPTION 'approved payroll lines are locked'; END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER payroll_lines_lock BEFORE UPDATE OR DELETE ON payroll_lines FOR EACH ROW EXECUTE FUNCTION protect_locked_payroll_line();
CREATE TRIGGER attendance_events_immutable BEFORE UPDATE OR DELETE ON attendance_events FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();
CREATE TRIGGER payroll_payments_immutable BEFORE UPDATE OR DELETE ON payroll_payments FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();
CREATE TRIGGER payroll_adjustments_immutable BEFORE UPDATE OR DELETE ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION protect_posted_commerce();

DO $$ DECLARE table_name text; BEGIN FOREACH table_name IN ARRAY ARRAY[
 'departments','employees','employee_contracts','employee_recurring_components','employee_advances','work_shifts','employee_shift_assignments',
 'attendance_events','overtime_requests','leave_requests','payroll_settings','payroll_cycles','payroll_lines','payroll_line_components','payroll_payments','payroll_adjustments'
] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=current_company_id()) WITH CHECK(company_id=current_company_id())',table_name);
 EXECUTE format('CREATE POLICY platform_isolation ON %I USING(current_setting(''app.platform_access'',true)=''true'') WITH CHECK(current_setting(''app.platform_access'',true)=''true'')',table_name);
END LOOP; END $$;
