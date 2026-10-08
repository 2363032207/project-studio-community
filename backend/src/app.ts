import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { createToken, hashPassword, tokenHash, verifyPassword } from './auth.js';
import { Database } from './database.js';
import { registerExtendedRoutes } from './extended.js';

export type CurrentUser = { id: string; email: string; display_name: string; role: 'admin' | 'user' };
declare module 'fastify' { interface FastifyRequest { currentUser: CurrentUser | null } }

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const uuid = z.string().uuid();
const projectInput = z.object({
  project_key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_-]{1,19}$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
});
const versionInput = z.object({
  name: z.string().trim().min(1).max(120),
  status: z.enum(['planned', 'active', 'released', 'archived']).default('planned'),
  start_date: z.string().date().nullable().optional(),
  release_date: z.string().date().nullable().optional(),
  objective: z.string().max(20_000).default(''),
  release_notes: z.string().max(50_000).default(''),
});
const itemInput = z.object({
  kind: z.enum(['requirement', 'bug']),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100_000).default(''),
  status: z.enum(['open', 'planned', 'in_progress', 'blocked', 'resolved', 'closed']).default('open'),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
  assignee_id: uuid.nullable().optional(),
  version_id: uuid.nullable().optional(),
  planned_start: z.string().date().nullable().optional(),
  planned_end: z.string().date().nullable().optional(),
  parent_id: uuid.nullable().optional(),
  acceptance_criteria: z.string().max(50_000).default(''),
  severity: z.enum(['critical', 'major', 'minor', 'trivial']).nullable().optional(),
  environment: z.string().max(120).default(''),
  reproduction_steps: z.string().max(100_000).default(''),
  actual_result: z.string().max(100_000).default(''),
  expected_result: z.string().max(100_000).default(''),
  estimate_points: z.coerce.number().int().min(0).max(1000).nullable().optional(),
});
const caseInput = z.object({
  title: z.string().trim().min(1).max(300),
  module: z.string().trim().min(1).max(120).default('General'),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  preconditions: z.string().max(50_000).default(''),
  steps: z.string().trim().min(1).max(100_000),
  expected_result: z.string().trim().min(1).max(100_000),
  status: z.enum(['draft', 'ready', 'deprecated']).default('draft'),
  suite_id: uuid.nullable().optional(),
  case_type: z.enum(['functional', 'integration', 'regression', 'performance', 'security', 'usability']).default('functional'),
  automation_status: z.enum(['manual', 'candidate', 'automated']).default('manual'),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
});

function requireUser(request: FastifyRequest): CurrentUser {
  if (!request.currentUser) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录');
  return request.currentUser;
}

export async function buildApp(config: Config, database = new Database(config.databaseUrl)): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
  app.decorateRequest('currentUser', null);

  const audit = async (actorId: string, action: string, entityType: string, entityId: string | null, projectId: string | null, payload: object = {}) => {
    await database.pool.query(
      'INSERT INTO audit_events(project_id,actor_id,action,entity_type,entity_id,payload) VALUES ($1,$2,$3,$4,$5,$6)',
      [projectId, actorId, action, entityType, entityId, payload],
    );
  };

  const projectRole = async (request: FastifyRequest, projectId: string, write = false): Promise<string> => {
    const user = requireUser(request);
    if (user.role === 'admin') return 'admin';
    const result = await database.pool.query<{ role: string }>(
      'SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, user.id],
    );
    const role = result.rows[0]?.role;
    if (!role) throw new HttpError(403, 'PROJECT_ACCESS_DENIED', '没有该项目的访问权限');
    if (write && role === 'viewer') throw new HttpError(403, 'PROJECT_WRITE_DENIED', '当前项目角色为只读');
    return role;
  };

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0];
    if (!path?.startsWith('/api/') || ['/api/health', '/api/auth/login'].includes(path)) return;
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const hash = tokenHash(header.slice(7), config.secret);
    const result = await database.pool.query<CurrentUser>(
      `SELECT u.id,u.email,u.display_name,u.role
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash],
    );
    request.currentUser = result.rows[0] ?? null;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof ZodError) return reply.code(422).send({ code: 'VALIDATION_ERROR', message: '输入内容不符合要求', details: error.issues });
    const dbCode = (error as { code?: string }).code;
    if (dbCode === '23505') return reply.code(409).send({ code: 'DUPLICATE', message: '编号或名称已经存在' });
    if (dbCode === '23503') return reply.code(409).send({ code: 'REFERENCE_CONFLICT', message: '该数据仍被其他记录引用' });
    request.log.error(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务暂时不可用' });
  });

  app.get('/api/health', async () => {
    await database.pool.query('SELECT 1');
    return { status: 'ok', version: '1.0.0' };
  });

  app.post('/api/auth/login', async (request) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1).max(128) }).parse(request.body);
    const result = await database.pool.query<CurrentUser & { password_hash: string }>(
      'SELECT id,email,display_name,role,password_hash FROM users WHERE lower(email)=lower($1)', [body.email],
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(body.password, user.password_hash)) throw new HttpError(401, 'LOGIN_FAILED', '邮箱或密码错误');
    const token = createToken();
    await database.pool.query('DELETE FROM sessions WHERE expires_at<=now()');
    await database.pool.query(
      `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '7 days')`,
      [tokenHash(token, config.secret), user.id],
    );
    const { password_hash: _passwordHash, ...safeUser } = user;
    return { token, user: safeUser };
  });

  app.post('/api/auth/logout', async (request) => {
    requireUser(request);
    const token = request.headers.authorization?.slice(7) ?? '';
    await database.pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token, config.secret)]);
    return { ok: true };
  });

  app.get('/api/me', async (request) => ({ user: requireUser(request) }));

  app.get('/api/users', async (request) => {
    const user = requireUser(request);
    if (user.role !== 'admin') throw new HttpError(403, 'ADMIN_REQUIRED', '仅管理员可以查看账号清单');
    const result = await database.pool.query('SELECT id,email,display_name,role,created_at FROM users ORDER BY display_name');
    return { items: result.rows };
  });

  app.post('/api/users', async (request, reply) => {
    const user = requireUser(request);
    if (user.role !== 'admin') throw new HttpError(403, 'ADMIN_REQUIRED', '仅管理员可以创建账号');
    const body = z.object({
      email: z.string().email().transform((value) => value.toLowerCase()),
      display_name: z.string().trim().min(1).max(120),
      password: z.string().min(12).max(128),
      role: z.enum(['admin', 'user']).default('user'),
    }).parse(request.body);
    const result = await database.pool.query(
      `INSERT INTO users(email,display_name,password_hash,role) VALUES ($1,$2,$3,$4)
       RETURNING id,email,display_name,role,created_at`,
      [body.email, body.display_name, hashPassword(body.password), body.role],
    );
    return reply.code(201).send(result.rows[0]);
  });

  app.get('/api/directory', async (request) => {
    requireUser(request);
    const result = await database.pool.query('SELECT id,email,display_name FROM users ORDER BY display_name');
    return { items: result.rows };
  });

  app.get('/api/projects', async (request) => {
    const user = requireUser(request);
    const result = await database.pool.query(
      `SELECT p.*,coalesce(pm.role,'admin') AS member_role
       FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$1
       WHERE $2='admin' OR pm.user_id IS NOT NULL ORDER BY p.updated_at DESC`, [user.id, user.role],
    );
    return { items: result.rows };
  });

  app.post('/api/projects', async (request, reply) => {
    const user = requireUser(request);
    const body = projectInput.parse(request.body);
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(
        `INSERT INTO projects(project_key,name,description,created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [body.project_key, body.name, body.description, user.id],
      );
      const project = created.rows[0];
      await client.query('INSERT INTO project_members(project_id,user_id,role) VALUES ($1,$2,$3)', [project.id, user.id, 'owner']);
      await client.query(
        'INSERT INTO audit_events(project_id,actor_id,action,entity_type,entity_id,payload) VALUES ($1,$2,$3,$4,$5,$6)',
        [project.id, user.id, 'created', 'project', project.id, {}],
      );
      await client.query('COMMIT');
      return reply.code(201).send(project);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });

  app.patch('/api/projects/:projectId', async (request) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    const role = await projectRole(request, projectId, true);
    if (!['admin', 'owner'].includes(role)) throw new HttpError(403, 'OWNER_REQUIRED', '仅项目负责人可以修改项目');
    const body = projectInput.partial().parse(request.body);
    const current = await database.pool.query('SELECT * FROM projects WHERE id=$1', [projectId]);
    if (!current.rowCount) throw new HttpError(404, 'NOT_FOUND', '项目不存在');
    const value = { ...current.rows[0], ...body };
    const result = await database.pool.query(
      `UPDATE projects SET project_key=$2,name=$3,description=$4,updated_at=now() WHERE id=$1 RETURNING *`,
      [projectId, value.project_key, value.name, value.description],
    );
    await audit(requireUser(request).id, 'updated', 'project', projectId, projectId, body);
    return result.rows[0];
  });

  app.delete('/api/projects/:projectId', async (request, reply) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    const role = await projectRole(request, projectId, true);
    if (!['admin', 'owner'].includes(role)) throw new HttpError(403, 'OWNER_REQUIRED', '仅项目负责人可以删除项目');
    await database.pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
    return reply.code(204).send();
  });

  app.get('/api/projects/:projectId/members', async (request) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    await projectRole(request, projectId);
    const result = await database.pool.query(
      `SELECT u.id,u.email,u.display_name,pm.role,pm.created_at FROM project_members pm
       JOIN users u ON u.id=pm.user_id WHERE pm.project_id=$1 ORDER BY pm.role,u.display_name`, [projectId],
    );
    return { items: result.rows };
  });

  app.put('/api/projects/:projectId/members/:userId', async (request) => {
    const { projectId, userId } = z.object({ projectId: uuid, userId: uuid }).parse(request.params);
    const role = await projectRole(request, projectId, true);
    if (!['admin', 'owner'].includes(role)) throw new HttpError(403, 'OWNER_REQUIRED', '仅项目负责人可以管理成员');
    const body = z.object({ role: z.enum(['owner', 'member', 'viewer']) }).parse(request.body);
    const result = await database.pool.query(
      `INSERT INTO project_members(project_id,user_id,role) VALUES ($1,$2,$3)
       ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role RETURNING *`, [projectId, userId, body.role],
    );
    await audit(requireUser(request).id, 'member_upserted', 'project_member', userId, projectId, body);
    return result.rows[0];
  });

  app.delete('/api/projects/:projectId/members/:userId', async (request, reply) => {
    const { projectId, userId } = z.object({ projectId: uuid, userId: uuid }).parse(request.params);
    const role = await projectRole(request, projectId, true);
    if (!['admin', 'owner'].includes(role)) throw new HttpError(403, 'OWNER_REQUIRED', '仅项目负责人可以管理成员');
    const owners = await database.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM project_members WHERE project_id=$1 AND role='owner'`, [projectId]);
    const target = await database.pool.query<{ role: string }>('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, userId]);
    if (target.rows[0]?.role === 'owner' && owners.rows[0]?.count === 1) throw new HttpError(409, 'LAST_OWNER', '项目必须保留至少一名负责人');
    await database.pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, userId]);
    await audit(requireUser(request).id, 'member_removed', 'project_member', userId, projectId);
    return reply.code(204).send();
  });

  app.get('/api/projects/:projectId/dashboard', async (request) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    await projectRole(request, projectId);
    const [items, cases, versions, recent] = await Promise.all([
      database.pool.query(`SELECT kind,status,count(*)::int AS count FROM work_items WHERE project_id=$1 GROUP BY kind,status`, [projectId]),
      database.pool.query(`SELECT status,count(*)::int AS count FROM test_cases WHERE project_id=$1 GROUP BY status`, [projectId]),
      database.pool.query(`SELECT status,count(*)::int AS count FROM versions WHERE project_id=$1 GROUP BY status`, [projectId]),
      database.pool.query(`SELECT a.*,u.display_name AS actor_name FROM audit_events a JOIN users u ON u.id=a.actor_id WHERE a.project_id=$1 ORDER BY a.created_at DESC LIMIT 12`, [projectId]),
    ]);
    return { work_items: items.rows, test_cases: cases.rows, versions: versions.rows, recent: recent.rows };
  });

  app.get('/api/projects/:projectId/versions', async (request) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    await projectRole(request, projectId);
    const result = await database.pool.query('SELECT * FROM versions WHERE project_id=$1 ORDER BY release_date NULLS LAST,created_at DESC', [projectId]);
    return { items: result.rows };
  });

  app.post('/api/projects/:projectId/versions', async (request, reply) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    await projectRole(request, projectId, true);
    const body = versionInput.parse(request.body);
    const result = await database.pool.query(
      `INSERT INTO versions(project_id,name,status,start_date,release_date,objective,release_notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [projectId, body.name, body.status, body.start_date ?? null, body.release_date ?? null, body.objective, body.release_notes],
    );
    await audit(requireUser(request).id, 'created', 'version', result.rows[0].id, projectId, body);
    return reply.code(201).send(result.rows[0]);
  });

  app.patch('/api/projects/:projectId/versions/:id', async (request) => {
    const { projectId, id } = z.object({ projectId: uuid, id: uuid }).parse(request.params);
    await projectRole(request, projectId, true);
    const body = versionInput.partial().parse(request.body);
    const current = await database.pool.query('SELECT * FROM versions WHERE id=$1 AND project_id=$2', [id, projectId]);
    if (!current.rowCount) throw new HttpError(404, 'NOT_FOUND', '版本不存在');
    const value = { ...current.rows[0], ...body };
    const result = await database.pool.query(
      `UPDATE versions SET name=$3,status=$4,start_date=$5,release_date=$6,objective=$7,release_notes=$8,updated_at=now() WHERE id=$1 AND project_id=$2 RETURNING *`,
      [id, projectId, value.name, value.status, value.start_date, value.release_date, value.objective, value.release_notes],
    );
    await audit(requireUser(request).id, 'updated', 'version', id, projectId, body);
    return result.rows[0];
  });

  app.delete('/api/projects/:projectId/versions/:id', async (request, reply) => {
    const { projectId, id } = z.object({ projectId: uuid, id: uuid }).parse(request.params);
    await projectRole(request, projectId, true);
    await database.pool.query('DELETE FROM versions WHERE id=$1 AND project_id=$2', [id, projectId]);
    await audit(requireUser(request).id, 'deleted', 'version', id, projectId);
    return reply.code(204).send();
  });

  app.get('/api/projects/:projectId/items', async (request) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    const query = z.object({ kind: z.enum(['requirement', 'bug']).optional(), status: z.string().max(30).optional(), q: z.string().max(200).optional() }).parse(request.query);
    await projectRole(request, projectId);
    const values: unknown[] = [projectId];
    const conditions = ['w.project_id=$1'];
    if (query.kind) { values.push(query.kind); conditions.push(`w.kind=$${values.length}`); }
    if (query.status) { values.push(query.status); conditions.push(`w.status=$${values.length}`); }
    if (query.q) { values.push(`%${query.q}%`); conditions.push(`(w.title ILIKE $${values.length} OR w.code ILIKE $${values.length})`); }
    const result = await database.pool.query(
      `SELECT w.*,u.display_name AS assignee_name,v.name AS version_name FROM work_items w
       LEFT JOIN users u ON u.id=w.assignee_id LEFT JOIN versions v ON v.id=w.version_id
       WHERE ${conditions.join(' AND ')} ORDER BY w.updated_at DESC`, values,
    );
    return { items: result.rows };
  });

  app.post('/api/projects/:projectId/items', async (request, reply) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    await projectRole(request, projectId, true);
    const body = itemInput.parse(request.body);
    const sequence = body.kind === 'bug' ? 'bug_code_seq' : 'requirement_code_seq';
    const prefix = body.kind === 'bug' ? 'BUG' : 'REQ';
    const next = await database.pool.query<{ value: string }>(`SELECT nextval('${sequence}')::text AS value`);
    const code = `${prefix}-${String(next.rows[0]?.value).padStart(5, '0')}`;
    const result = await database.pool.query(
      `INSERT INTO work_items(project_id,code,kind,title,description,status,priority,assignee_id,version_id,planned_start,planned_end,parent_id,acceptance_criteria,severity,environment,reproduction_steps,actual_result,expected_result,estimate_points,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [projectId, code, body.kind, body.title, body.description, body.status, body.priority, body.assignee_id ?? null, body.version_id ?? null, body.planned_start ?? null, body.planned_end ?? null, body.parent_id ?? null, body.acceptance_criteria, body.severity ?? null, body.environment, body.reproduction_steps, body.actual_result, body.expected_result, body.estimate_points ?? null, requireUser(request).id],
    );
    await audit(requireUser(request).id, 'created', body.kind, result.rows[0].id, projectId, { code, title: body.title });
    return reply.code(201).send(result.rows[0]);
  });

  app.patch('/api/projects/:projectId/items/:id', async (request) => {
    const { projectId, id } = z.object({ projectId: uuid, id: uuid }).parse(request.params);
    await projectRole(request, projectId, true);
    const body = itemInput.partial().parse(request.body);
    const current = await database.pool.query('SELECT * FROM work_items WHERE id=$1 AND project_id=$2', [id, projectId]);
    if (!current.rowCount) throw new HttpError(404, 'NOT_FOUND', '工作项不存在');
    const value = { ...current.rows[0], ...body };
    const result = await database.pool.query(
      `UPDATE work_items SET title=$3,description=$4,status=$5,priority=$6,assignee_id=$7,version_id=$8,planned_start=$9,planned_end=$10,parent_id=$11,acceptance_criteria=$12,severity=$13,environment=$14,reproduction_steps=$15,actual_result=$16,expected_result=$17,estimate_points=$18,updated_at=now()
       WHERE id=$1 AND project_id=$2 RETURNING *`,
      [id, projectId, value.title, value.description, value.status, value.priority, value.assignee_id, value.version_id, value.planned_start, value.planned_end, value.parent_id, value.acceptance_criteria, value.severity, value.environment, value.reproduction_steps, value.actual_result, value.expected_result, value.estimate_points],
    );
    await audit(requireUser(request).id, 'updated', value.kind, id, projectId, body);
    return result.rows[0];
  });

  app.delete('/api/projects/:projectId/items/:id', async (request, reply) => {
    const { projectId, id } = z.object({ projectId: uuid, id: uuid }).parse(request.params);
    await projectRole(request, projectId, true);
    const deleted = await database.pool.query('DELETE FROM work_items WHERE id=$1 AND project_id=$2 RETURNING kind,code', [id, projectId]);
    if (!deleted.rowCount) throw new HttpError(404, 'NOT_FOUND', '工作项不存在');
    await audit(requireUser(request).id, 'deleted', deleted.rows[0].kind, id, projectId, { code: deleted.rows[0].code });
    return reply.code(204).send();
  });

  app.get('/api/projects/:projectId/test-cases', async (request) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    await projectRole(request, projectId);
    const result = await database.pool.query(
      `SELECT c.*,s.name AS suite_name,coalesce(array_agg(r.id) FILTER (WHERE r.id IS NOT NULL),'{}') AS requirement_ids,
       coalesce(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL),'{}') AS requirement_codes
       FROM test_cases c LEFT JOIN test_suites s ON s.id=c.suite_id
       LEFT JOIN test_case_requirements x ON x.test_case_id=c.id LEFT JOIN work_items r ON r.id=x.requirement_id
       WHERE c.project_id=$1 GROUP BY c.id,s.name ORDER BY c.updated_at DESC`, [projectId],
    );
    return { items: result.rows };
  });

  app.post('/api/projects/:projectId/test-cases', async (request, reply) => {
    const { projectId } = z.object({ projectId: uuid }).parse(request.params);
    await projectRole(request, projectId, true);
    const body = caseInput.parse(request.body);
    const next = await database.pool.query<{ value: string }>(`SELECT nextval('case_code_seq')::text AS value`);
    const code = `TC-${String(next.rows[0]?.value).padStart(5, '0')}`;
    const result = await database.pool.query(
      `INSERT INTO test_cases(project_id,code,title,module,priority,preconditions,steps,expected_result,status,suite_id,case_type,automation_status,tags,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [projectId, code, body.title, body.module, body.priority, body.preconditions, body.steps, body.expected_result, body.status, body.suite_id ?? null, body.case_type, body.automation_status, body.tags, requireUser(request).id],
    );
    await audit(requireUser(request).id, 'created', 'test_case', result.rows[0].id, projectId, { code, title: body.title });
    return reply.code(201).send(result.rows[0]);
  });

  app.patch('/api/projects/:projectId/test-cases/:id', async (request) => {
    const { projectId, id } = z.object({ projectId: uuid, id: uuid }).parse(request.params);
    await projectRole(request, projectId, true);
    const body = caseInput.partial().parse(request.body);
    const current = await database.pool.query('SELECT * FROM test_cases WHERE id=$1 AND project_id=$2', [id, projectId]);
    if (!current.rowCount) throw new HttpError(404, 'NOT_FOUND', '测试用例不存在');
    const value = { ...current.rows[0], ...body };
    const result = await database.pool.query(
      `UPDATE test_cases SET title=$3,module=$4,priority=$5,preconditions=$6,steps=$7,expected_result=$8,status=$9,suite_id=$10,case_type=$11,automation_status=$12,tags=$13,updated_at=now()
       WHERE id=$1 AND project_id=$2 RETURNING *`,
      [id, projectId, value.title, value.module, value.priority, value.preconditions, value.steps, value.expected_result, value.status, value.suite_id, value.case_type, value.automation_status, value.tags],
    );
    await audit(requireUser(request).id, 'updated', 'test_case', id, projectId, body);
    return result.rows[0];
  });

  app.delete('/api/projects/:projectId/test-cases/:id', async (request, reply) => {
    const { projectId, id } = z.object({ projectId: uuid, id: uuid }).parse(request.params);
    await projectRole(request, projectId, true);
    await database.pool.query('DELETE FROM test_cases WHERE id=$1 AND project_id=$2', [id, projectId]);
    await audit(requireUser(request).id, 'deleted', 'test_case', id, projectId);
    return reply.code(204).send();
  });

  registerExtendedRoutes(app, database, { audit, projectRole });
  app.addHook('onClose', async () => database.close());
  return app;
}

export async function initialize(database: Database, config: Config): Promise<void> {
  await database.migrate();
  const existing = await database.pool.query('SELECT id FROM users WHERE lower(email)=lower($1)', [config.adminEmail]);
  if (!existing.rowCount) {
    await database.pool.query(
      `INSERT INTO users(email,display_name,password_hash,role) VALUES ($1,$2,$3,'admin')`,
      [config.adminEmail, 'Administrator', hashPassword(config.adminPassword)],
    );
  }
}
