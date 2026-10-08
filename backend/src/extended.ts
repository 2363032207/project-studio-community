import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from './database.js';
import { HttpError, type CurrentUser } from './app.js';

type Context = {
  audit: (actorId: string, action: string, entityType: string, entityId: string | null, projectId: string | null, payload?: object) => Promise<void>;
  projectRole: (request: FastifyRequest, projectId: string, write?: boolean) => Promise<string>;
};

const uuid = z.string().uuid();
const projectParams = z.object({ projectId: uuid });
const entityParams = z.object({ projectId: uuid, id: uuid });
const milestoneInput = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().max(20_000).default(''),
  status: z.enum(['planned', 'in_progress', 'completed', 'at_risk']).default('planned'),
  due_date: z.string().date().nullable().optional(),
  progress: z.coerce.number().int().min(0).max(100).default(0),
  owner_id: uuid.nullable().optional(),
});
const scheduleInput = z.object({
  title: z.string().trim().min(1).max(240),
  schedule_type: z.enum(['task', 'review', 'release', 'test']).default('task'),
  status: z.enum(['planned', 'in_progress', 'completed', 'blocked']).default('planned'),
  start_date: z.string().date(),
  end_date: z.string().date(),
  owner_id: uuid.nullable().optional(),
  related_item_id: uuid.nullable().optional(),
}).refine((value) => value.end_date >= value.start_date, { message: '结束日期不能早于开始日期' });
const suiteInput = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(20_000).default(''),
});
const planInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(''),
  status: z.enum(['draft', 'active', 'completed', 'archived']).default('draft'),
  environment: z.string().trim().min(1).max(120).default('Staging'),
  version_id: uuid.nullable().optional(),
  owner_id: uuid.nullable().optional(),
  start_date: z.string().date().nullable().optional(),
  end_date: z.string().date().nullable().optional(),
}).refine((value) => !value.start_date || !value.end_date || value.end_date >= value.start_date, { message: '结束日期不能早于开始日期' });

function user(request: FastifyRequest): CurrentUser {
  if (!request.currentUser) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录');
  return request.currentUser;
}

export function registerExtendedRoutes(app: FastifyInstance, database: Database, context: Context): void {
  app.get('/api/projects/:projectId/milestones', async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId);
    const result = await database.pool.query(
      `SELECT m.*,u.display_name AS owner_name FROM milestones m
       LEFT JOIN users u ON u.id=m.owner_id WHERE m.project_id=$1
       ORDER BY m.due_date NULLS LAST,m.created_at DESC`, [projectId],
    );
    return { items: result.rows };
  });

  app.post('/api/projects/:projectId/milestones', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    const body = milestoneInput.parse(request.body);
    const result = await database.pool.query(
      `INSERT INTO milestones(project_id,title,description,status,due_date,progress,owner_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [projectId, body.title, body.description, body.status, body.due_date ?? null, body.progress, body.owner_id ?? null, user(request).id],
    );
    await context.audit(user(request).id, 'created', 'milestone', result.rows[0].id, projectId, { title: body.title });
    return reply.code(201).send(result.rows[0]);
  });

  app.patch('/api/projects/:projectId/milestones/:id', async (request) => {
    const { projectId, id } = entityParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    const body = milestoneInput.partial().parse(request.body);
    const current = await database.pool.query('SELECT * FROM milestones WHERE id=$1 AND project_id=$2', [id, projectId]);
    if (!current.rowCount) throw new HttpError(404, 'NOT_FOUND', '里程碑不存在');
    const value = { ...current.rows[0], ...body };
    const result = await database.pool.query(
      `UPDATE milestones SET title=$3,description=$4,status=$5,due_date=$6,progress=$7,owner_id=$8,updated_at=now()
       WHERE id=$1 AND project_id=$2 RETURNING *`,
      [id, projectId, value.title, value.description, value.status, value.due_date, value.progress, value.owner_id],
    );
    await context.audit(user(request).id, 'updated', 'milestone', id, projectId, body);
    return result.rows[0];
  });

  app.delete('/api/projects/:projectId/milestones/:id', async (request, reply) => {
    const { projectId, id } = entityParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    await database.pool.query('DELETE FROM milestones WHERE id=$1 AND project_id=$2', [id, projectId]);
    await context.audit(user(request).id, 'deleted', 'milestone', id, projectId);
    return reply.code(204).send();
  });

  app.get('/api/projects/:projectId/schedules', async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId);
    const result = await database.pool.query(
      `SELECT s.*,u.display_name AS owner_name,w.code AS related_code FROM schedules s
       LEFT JOIN users u ON u.id=s.owner_id LEFT JOIN work_items w ON w.id=s.related_item_id
       WHERE s.project_id=$1 ORDER BY s.start_date,s.end_date`, [projectId],
    );
    return { items: result.rows };
  });

  app.post('/api/projects/:projectId/schedules', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    const body = scheduleInput.parse(request.body);
    const result = await database.pool.query(
      `INSERT INTO schedules(project_id,title,schedule_type,status,start_date,end_date,owner_id,related_item_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [projectId, body.title, body.schedule_type, body.status, body.start_date, body.end_date, body.owner_id ?? null, body.related_item_id ?? null, user(request).id],
    );
    await context.audit(user(request).id, 'created', 'schedule', result.rows[0].id, projectId, { title: body.title });
    return reply.code(201).send(result.rows[0]);
  });

  app.patch('/api/projects/:projectId/schedules/:id', async (request) => {
    const { projectId, id } = entityParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    const body = scheduleInput.partial().parse(request.body);
    const current = await database.pool.query('SELECT * FROM schedules WHERE id=$1 AND project_id=$2', [id, projectId]);
    if (!current.rowCount) throw new HttpError(404, 'NOT_FOUND', '排期不存在');
    const value = { ...current.rows[0], ...body };
    if (String(value.end_date) < String(value.start_date)) throw new HttpError(422, 'DATE_RANGE_INVALID', '结束日期不能早于开始日期');
    const result = await database.pool.query(
      `UPDATE schedules SET title=$3,schedule_type=$4,status=$5,start_date=$6,end_date=$7,owner_id=$8,related_item_id=$9,updated_at=now()
       WHERE id=$1 AND project_id=$2 RETURNING *`,
      [id, projectId, value.title, value.schedule_type, value.status, value.start_date, value.end_date, value.owner_id, value.related_item_id],
    );
    await context.audit(user(request).id, 'updated', 'schedule', id, projectId, body);
    return result.rows[0];
  });

  app.delete('/api/projects/:projectId/schedules/:id', async (request, reply) => {
    const { projectId, id } = entityParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    await database.pool.query('DELETE FROM schedules WHERE id=$1 AND project_id=$2', [id, projectId]);
    await context.audit(user(request).id, 'deleted', 'schedule', id, projectId);
    return reply.code(204).send();
  });

  app.get('/api/projects/:projectId/test-suites', async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId);
    const result = await database.pool.query(
      `SELECT s.*,count(c.id)::int AS case_count FROM test_suites s
       LEFT JOIN test_cases c ON c.suite_id=s.id WHERE s.project_id=$1
       GROUP BY s.id ORDER BY s.name`, [projectId],
    );
    return { items: result.rows };
  });

  app.post('/api/projects/:projectId/test-suites', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    const body = suiteInput.parse(request.body);
    const result = await database.pool.query(
      `INSERT INTO test_suites(project_id,name,description,created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [projectId, body.name, body.description, user(request).id],
    );
    await context.audit(user(request).id, 'created', 'test_suite', result.rows[0].id, projectId, { name: body.name });
    return reply.code(201).send(result.rows[0]);
  });

  app.delete('/api/projects/:projectId/test-suites/:id', async (request, reply) => {
    const { projectId, id } = entityParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    await database.pool.query('DELETE FROM test_suites WHERE id=$1 AND project_id=$2', [id, projectId]);
    await context.audit(user(request).id, 'deleted', 'test_suite', id, projectId);
    return reply.code(204).send();
  });

  app.get('/api/projects/:projectId/test-plans', async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId);
    const result = await database.pool.query(
      `SELECT p.*,v.name AS version_name,u.display_name AS owner_name,
       count(pc.test_case_id)::int AS case_count,
       count(*) FILTER (WHERE pc.result='passed')::int AS passed_count,
       count(*) FILTER (WHERE pc.result='failed')::int AS failed_count,
       count(*) FILTER (WHERE pc.result='blocked')::int AS blocked_count
       FROM test_plans p LEFT JOIN versions v ON v.id=p.version_id LEFT JOIN users u ON u.id=p.owner_id
       LEFT JOIN test_plan_cases pc ON pc.plan_id=p.id WHERE p.project_id=$1
       GROUP BY p.id,v.name,u.display_name ORDER BY p.updated_at DESC`, [projectId],
    );
    return { items: result.rows };
  });

  app.post('/api/projects/:projectId/test-plans', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    const body = planInput.parse(request.body);
    const result = await database.pool.query(
      `INSERT INTO test_plans(project_id,name,description,status,environment,version_id,owner_id,start_date,end_date,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [projectId, body.name, body.description, body.status, body.environment, body.version_id ?? null, body.owner_id ?? null, body.start_date ?? null, body.end_date ?? null, user(request).id],
    );
    await context.audit(user(request).id, 'created', 'test_plan', result.rows[0].id, projectId, { name: body.name });
    return reply.code(201).send(result.rows[0]);
  });

  app.patch('/api/projects/:projectId/test-plans/:id', async (request) => {
    const { projectId, id } = entityParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    const body = planInput.partial().parse(request.body);
    const current = await database.pool.query('SELECT * FROM test_plans WHERE id=$1 AND project_id=$2', [id, projectId]);
    if (!current.rowCount) throw new HttpError(404, 'NOT_FOUND', '测试计划不存在');
    const value = { ...current.rows[0], ...body };
    const result = await database.pool.query(
      `UPDATE test_plans SET name=$3,description=$4,status=$5,environment=$6,version_id=$7,owner_id=$8,start_date=$9,end_date=$10,updated_at=now()
       WHERE id=$1 AND project_id=$2 RETURNING *`,
      [id, projectId, value.name, value.description, value.status, value.environment, value.version_id, value.owner_id, value.start_date, value.end_date],
    );
    await context.audit(user(request).id, 'updated', 'test_plan', id, projectId, body);
    return result.rows[0];
  });

  app.get('/api/projects/:projectId/test-plans/:id', async (request) => {
    const { projectId, id } = entityParams.parse(request.params);
    await context.projectRole(request, projectId);
    const plan = await database.pool.query('SELECT * FROM test_plans WHERE id=$1 AND project_id=$2', [id, projectId]);
    if (!plan.rowCount) throw new HttpError(404, 'NOT_FOUND', '测试计划不存在');
    const cases = await database.pool.query(
      `SELECT c.*,pc.result,pc.note,pc.executed_at,u.display_name AS executor_name
       FROM test_plan_cases pc JOIN test_cases c ON c.id=pc.test_case_id
       LEFT JOIN users u ON u.id=pc.executor_id WHERE pc.plan_id=$1 ORDER BY c.code`, [id],
    );
    return { ...plan.rows[0], cases: cases.rows };
  });

  app.post('/api/projects/:projectId/test-plans/:id/cases', async (request) => {
    const { projectId, id } = entityParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    const body = z.object({ test_case_ids: z.array(uuid).min(1).max(500) }).parse(request.body);
    for (const caseId of body.test_case_ids) {
      await database.pool.query(
        `INSERT INTO test_plan_cases(plan_id,test_case_id)
         SELECT $1,c.id FROM test_cases c JOIN test_plans p ON p.id=$1
         WHERE c.id=$2 AND c.project_id=$3 AND p.project_id=$3 ON CONFLICT DO NOTHING`, [id, caseId, projectId],
      );
    }
    await context.audit(user(request).id, 'cases_added', 'test_plan', id, projectId, { count: body.test_case_ids.length });
    return { ok: true };
  });

  app.patch('/api/projects/:projectId/test-plans/:planId/cases/:caseId', async (request) => {
    const { projectId, planId, caseId } = z.object({ projectId: uuid, planId: uuid, caseId: uuid }).parse(request.params);
    await context.projectRole(request, projectId, true);
    const body = z.object({ result: z.enum(['not_run', 'passed', 'failed', 'blocked', 'skipped']), note: z.string().max(20_000).default('') }).parse(request.body);
    const result = await database.pool.query(
      `UPDATE test_plan_cases pc SET result=$3::varchar,note=$4,executor_id=$5,executed_at=CASE WHEN $3::varchar='not_run' THEN NULL ELSE now() END
       FROM test_plans p WHERE pc.plan_id=$1 AND pc.test_case_id=$2 AND p.id=pc.plan_id AND p.project_id=$6 RETURNING pc.*`,
      [planId, caseId, body.result, body.note, user(request).id, projectId],
    );
    if (!result.rowCount) throw new HttpError(404, 'NOT_FOUND', '计划中不存在该用例');
    await context.audit(user(request).id, 'executed', 'test_case', caseId, projectId, { plan_id: planId, result: body.result });
    return result.rows[0];
  });

  app.delete('/api/projects/:projectId/test-plans/:id', async (request, reply) => {
    const { projectId, id } = entityParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    await database.pool.query('DELETE FROM test_plans WHERE id=$1 AND project_id=$2', [id, projectId]);
    await context.audit(user(request).id, 'deleted', 'test_plan', id, projectId);
    return reply.code(204).send();
  });

  app.put('/api/projects/:projectId/test-cases/:id/requirements', async (request) => {
    const { projectId, id } = entityParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    const body = z.object({ requirement_ids: z.array(uuid).max(100) }).parse(request.body);
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM test_case_requirements WHERE test_case_id=$1', [id]);
      for (const requirementId of body.requirement_ids) {
        await client.query(
          `INSERT INTO test_case_requirements(test_case_id,requirement_id)
           SELECT c.id,r.id FROM test_cases c,work_items r
           WHERE c.id=$1 AND c.project_id=$3 AND r.id=$2 AND r.project_id=$3 AND r.kind='requirement'`,
          [id, requirementId, projectId],
        );
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await context.audit(user(request).id, 'requirements_linked', 'test_case', id, projectId, { count: body.requirement_ids.length });
    return { ok: true };
  });

  app.get('/api/projects/:projectId/coverage', async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId);
    const result = await database.pool.query(
      `SELECT r.id,r.code,r.title,r.status,r.priority,count(DISTINCT x.test_case_id)::int AS case_count,
       count(DISTINCT pc.test_case_id) FILTER (WHERE pc.result='passed')::int AS passed_count
       FROM work_items r LEFT JOIN test_case_requirements x ON x.requirement_id=r.id
       LEFT JOIN test_plan_cases pc ON pc.test_case_id=x.test_case_id
       WHERE r.project_id=$1 AND r.kind='requirement'
       GROUP BY r.id ORDER BY r.updated_at DESC`, [projectId],
    );
    return { items: result.rows };
  });

  app.get('/api/projects/:projectId/reports', async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId);
    const [items, cases, execution, coverage, overdue, milestones] = await Promise.all([
      database.pool.query(`SELECT kind,status,count(*)::int AS count FROM work_items WHERE project_id=$1 GROUP BY kind,status`, [projectId]),
      database.pool.query(`SELECT status,count(*)::int AS count FROM test_cases WHERE project_id=$1 GROUP BY status`, [projectId]),
      database.pool.query(`SELECT pc.result,count(*)::int AS count FROM test_plan_cases pc JOIN test_plans p ON p.id=pc.plan_id WHERE p.project_id=$1 GROUP BY pc.result`, [projectId]),
      database.pool.query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE EXISTS (SELECT 1 FROM test_case_requirements x WHERE x.requirement_id=w.id))::int AS covered FROM work_items w WHERE project_id=$1 AND kind='requirement'`, [projectId]),
      database.pool.query(`SELECT count(*)::int AS count FROM work_items WHERE project_id=$1 AND planned_end<current_date AND status NOT IN ('resolved','closed')`, [projectId]),
      database.pool.query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE status='completed')::int AS completed,count(*) FILTER (WHERE status='at_risk')::int AS at_risk FROM milestones WHERE project_id=$1`, [projectId]),
    ]);
    return { work_items: items.rows, test_cases: cases.rows, execution: execution.rows, coverage: coverage.rows[0], overdue: overdue.rows[0]?.count ?? 0, milestones: milestones.rows[0] };
  });

  app.get('/api/projects/:projectId/audit', async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId);
    const result = await database.pool.query(
      `SELECT a.*,u.display_name AS actor_name FROM audit_events a JOIN users u ON u.id=a.actor_id
       WHERE a.project_id=$1 ORDER BY a.created_at DESC LIMIT 100`, [projectId],
    );
    return { items: result.rows };
  });

  app.post('/api/projects/:projectId/demo-seed', async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    await context.projectRole(request, projectId, true);
    const existing = await database.pool.query<{ count: number }>(
      `SELECT (SELECT count(*) FROM work_items WHERE project_id=$1)+(SELECT count(*) FROM test_cases WHERE project_id=$1) AS count`, [projectId],
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0) throw new HttpError(409, 'DEMO_DATA_EXISTS', '项目已有业务数据，不能重复填充演示内容');
    const actor = user(request).id;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const version = await client.query<{ id: string }>(
        `INSERT INTO versions(project_id,name,status,start_date,release_date,objective,created_at)
         VALUES ($1,'1.0 Preview','active',current_date-interval '14 days',current_date+interval '21 days','完成核心协作流程并验证交付质量',now()) RETURNING id`, [projectId],
      );
      const requirementRows: { id: string }[] = [];
      for (const [title, description, priority, days] of [
        ['账号登录与会话恢复', '支持安全登录、退出以及过期会话处理。', 'high', 5],
        ['项目工作台筛选', '支持按状态、负责人和关键字筛选工作项。', 'medium', 10],
        ['版本发布检查清单', '在版本发布前汇总未完成事项和质量指标。', 'high', 18],
        ['质量报告导出', '汇总覆盖率、执行结果和遗留问题。', 'medium', 24],
      ] as const) {
        const next = await client.query<{ value: string }>(`SELECT nextval('requirement_code_seq')::text AS value`);
        const code = `REQ-${String(next.rows[0]?.value).padStart(5, '0')}`;
        const row = await client.query<{ id: string }>(
          `INSERT INTO work_items(project_id,code,kind,title,description,status,priority,version_id,planned_start,planned_end,acceptance_criteria,estimate_points,created_by)
           VALUES ($1,$2,'requirement',$3,$4,'in_progress',$5,$6,current_date-interval '3 days',current_date+($7::int),'功能可用；权限校验正确；关键操作有审计记录。',5,$8) RETURNING id`,
          [projectId, code, title, description, priority, version.rows[0]?.id, days, actor],
        );
        requirementRows.push(row.rows[0]!);
      }
      for (const [title, severity, environment] of [
        ['筛选条件重置后列表未立即刷新', 'major', 'Staging'],
        ['窄屏下表格操作按钮被遮挡', 'minor', 'Preview'],
        ['重复提交时缺少明确提示', 'minor', 'Development'],
      ] as const) {
        const next = await client.query<{ value: string }>(`SELECT nextval('bug_code_seq')::text AS value`);
        const code = `BUG-${String(next.rows[0]?.value).padStart(5, '0')}`;
        await client.query(
          `INSERT INTO work_items(project_id,code,kind,title,description,status,priority,severity,environment,reproduction_steps,expected_result,actual_result,version_id,created_by)
           VALUES ($1,$2,'bug',$3,'演示用虚构问题。','open','medium',$4,$5,'1. 打开示例页面\n2. 执行对应操作','界面及时反馈且状态一致','出现演示描述中的异常',$6,$7)`,
          [projectId, code, title, severity, environment, version.rows[0]?.id, actor],
        );
      }
      const suiteA = await client.query<{ id: string }>(`INSERT INTO test_suites(project_id,name,description,created_by) VALUES ($1,'核心流程','覆盖账号、项目与工作项主流程',$2) RETURNING id`, [projectId, actor]);
      const suiteB = await client.query<{ id: string }>(`INSERT INTO test_suites(project_id,name,description,created_by) VALUES ($1,'发布回归','版本发布前的通用回归集合',$2) RETURNING id`, [projectId, actor]);
      const caseRows: { id: string }[] = [];
      const caseData = [
        ['有效账号成功登录','账号与权限','high',suiteA.rows[0]?.id,'functional','automated'],
        ['错误密码登录被拒绝','账号与权限','high',suiteA.rows[0]?.id,'security','automated'],
        ['按状态筛选需求列表','需求管理','medium',suiteA.rows[0]?.id,'functional','candidate'],
        ['创建并更新问题状态','问题管理','high',suiteA.rows[0]?.id,'integration','candidate'],
        ['发布前检查未关闭问题','版本管理','high',suiteB.rows[0]?.id,'regression','manual'],
        ['质量报告统计口径一致','质量报告','medium',suiteB.rows[0]?.id,'integration','manual'],
      ] as const;
      for (const [title, module, priority, suiteId, caseType, automation] of caseData) {
        const next = await client.query<{ value: string }>(`SELECT nextval('case_code_seq')::text AS value`);
        const code = `TC-${String(next.rows[0]?.value).padStart(5, '0')}`;
        const row = await client.query<{ id: string }>(
          `INSERT INTO test_cases(project_id,code,title,module,priority,preconditions,steps,expected_result,status,suite_id,case_type,automation_status,tags,created_by)
           VALUES ($1,$2,$3,$4,$5,'已准备独立演示环境','1. 准备测试数据\n2. 执行操作\n3. 记录结果','结果符合需求且无额外错误','ready',$6,$7,$8,ARRAY['demo','core'],$9) RETURNING id`,
          [projectId, code, title, module, priority, suiteId, caseType, automation, actor],
        );
        caseRows.push(row.rows[0]!);
      }
      for (let index = 0; index < Math.min(requirementRows.length, caseRows.length); index++) {
        await client.query('INSERT INTO test_case_requirements(test_case_id,requirement_id) VALUES ($1,$2)', [caseRows[index]?.id, requirementRows[index]?.id]);
      }
      await client.query(
        `INSERT INTO milestones(project_id,title,description,status,due_date,progress,created_by) VALUES
         ($1,'功能冻结','停止新增范围，集中完成缺陷修复。','in_progress',current_date+interval '10 days',65,$2),
         ($1,'候选版本','完成核心流程验收。','planned',current_date+interval '17 days',30,$2),
         ($1,'正式发布','完成发布检查并归档结果。','planned',current_date+interval '24 days',10,$2)`, [projectId, actor],
      );
      await client.query(
        `INSERT INTO schedules(project_id,title,schedule_type,status,start_date,end_date,created_by) VALUES
         ($1,'核心功能开发','task','in_progress',current_date-interval '7 days',current_date+interval '5 days',$2),
         ($1,'测试用例评审','review','planned',current_date+interval '3 days',current_date+interval '4 days',$2),
         ($1,'全量回归测试','test','planned',current_date+interval '8 days',current_date+interval '14 days',$2),
         ($1,'版本发布','release','planned',current_date+interval '21 days',current_date+interval '21 days',$2)`, [projectId, actor],
      );
      const plan = await client.query<{ id: string }>(
        `INSERT INTO test_plans(project_id,name,description,status,environment,version_id,start_date,end_date,created_by)
         VALUES ($1,'1.0 Preview 回归计划','覆盖核心流程与发布检查。','active','Staging',$2,current_date,current_date+interval '14 days',$3) RETURNING id`,
        [projectId, version.rows[0]?.id, actor],
      );
      for (let index = 0; index < caseRows.length; index++) {
        const result = index === 0 ? 'passed' : index === 1 ? 'failed' : index === 2 ? 'blocked' : 'not_run';
        await client.query(
          `INSERT INTO test_plan_cases(plan_id,test_case_id,result,executor_id,executed_at)
           VALUES ($1,$2,$3::varchar,CASE WHEN $3::text='not_run' THEN NULL ELSE $4::uuid END,CASE WHEN $3::text='not_run' THEN NULL ELSE now() END)`,
          [plan.rows[0]?.id, caseRows[index]?.id, result, actor],
        );
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await context.audit(actor, 'demo_seeded', 'project', projectId, projectId, { source: 'generic_fictional_data' });
    return reply.code(201).send({ ok: true });
  });
}
