ALTER TABLE versions ADD COLUMN IF NOT EXISTS objective text NOT NULL DEFAULT '';
ALTER TABLE versions ADD COLUMN IF NOT EXISTS release_notes text NOT NULL DEFAULT '';

ALTER TABLE work_items ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES work_items(id) ON DELETE SET NULL;
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS acceptance_criteria text NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS severity varchar(20) CHECK (severity IN ('critical', 'major', 'minor', 'trivial'));
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS environment varchar(120) NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS reproduction_steps text NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS actual_result text NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS expected_result text NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS estimate_points integer CHECK (estimate_points IS NULL OR estimate_points BETWEEN 0 AND 1000);

CREATE TABLE IF NOT EXISTS test_suites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);

ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS suite_id uuid REFERENCES test_suites(id) ON DELETE SET NULL;
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS case_type varchar(30) NOT NULL DEFAULT 'functional' CHECK (case_type IN ('functional', 'integration', 'regression', 'performance', 'security', 'usability'));
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS automation_status varchar(30) NOT NULL DEFAULT 'manual' CHECK (automation_status IN ('manual', 'candidate', 'automated'));
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title varchar(240) NOT NULL,
  description text NOT NULL DEFAULT '',
  status varchar(30) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'at_risk')),
  due_date date,
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS milestones_project_due_idx ON milestones(project_id, due_date);

CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title varchar(240) NOT NULL,
  schedule_type varchar(30) NOT NULL DEFAULT 'task' CHECK (schedule_type IN ('task', 'review', 'release', 'test')),
  status varchar(30) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'blocked')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  related_item_id uuid REFERENCES work_items(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS schedules_project_dates_idx ON schedules(project_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS test_case_requirements (
  test_case_id uuid NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  requirement_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(test_case_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS test_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  description text NOT NULL DEFAULT '',
  status varchar(30) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'archived')),
  environment varchar(120) NOT NULL DEFAULT 'Staging',
  version_id uuid REFERENCES versions(id) ON DELETE SET NULL,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  start_date date,
  end_date date,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS test_plan_cases (
  plan_id uuid NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  test_case_id uuid NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  result varchar(30) NOT NULL DEFAULT 'not_run' CHECK (result IN ('not_run', 'passed', 'failed', 'blocked', 'skipped')),
  note text NOT NULL DEFAULT '',
  executor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  executed_at timestamptz,
  PRIMARY KEY(plan_id, test_case_id)
);
CREATE INDEX IF NOT EXISTS test_plans_project_idx ON test_plans(project_id, status, updated_at DESC);
