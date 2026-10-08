import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { api, tokenStore, type Dashboard, type DirectoryUser, type Member, type Project, type TestCase, type User, type Version, type WorkItem } from './api';

type Tab = 'overview' | 'requirements' | 'bugs' | 'versions' | 'cases' | 'team';

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<{ token: string; user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) });
      tokenStore.set(result.token); onLogin(result.user);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); } finally { setBusy(false); }
  };
  return <main className="login-shell">
    <section className="login-card">
      <div className="brand-mark">PS</div>
      <p className="eyebrow">PROJECT STUDIO COMMUNITY</p>
      <h1>项目与测试管理</h1>
      <p className="muted">通用、可自托管，不包含任何公司项目或内部集成。</p>
      <form onSubmit={submit} className="stack">
        <label>邮箱<input name="email" type="email" autoComplete="username" required placeholder="admin@example.com" /></label>
        <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
      </form>
    </section>
  </main>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></header>
      {children}
    </section>
  </div>;
}

const statusText: Record<string, string> = { open: '待处理', planned: '已计划', in_progress: '进行中', blocked: '已阻塞', resolved: '已解决', closed: '已关闭', active: '进行中', released: '已发布', archived: '已归档', draft: '草稿', ready: '可执行', deprecated: '已废弃' };

function Overview({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Dashboard | null>(null);
  useEffect(() => { api<Dashboard>(`/api/projects/${projectId}/dashboard`).then(setData); }, [projectId]);
  if (!data) return <div className="empty">正在加载项目概况…</div>;
  const sum = (rows: { count: number }[]) => rows.reduce((total, row) => total + row.count, 0);
  return <>
    <div className="metric-grid">
      <article className="metric"><span>需求</span><strong>{sum(data.work_items.filter((x) => x.kind === 'requirement'))}</strong></article>
      <article className="metric"><span>Bug</span><strong>{sum(data.work_items.filter((x) => x.kind === 'bug'))}</strong></article>
      <article className="metric"><span>测试用例</span><strong>{sum(data.test_cases)}</strong></article>
      <article className="metric"><span>版本</span><strong>{sum(data.versions)}</strong></article>
    </div>
    <section className="panel"><div className="panel-title"><h2>最近活动</h2></div>
      {data.recent.length ? <ul className="activity-list">{data.recent.map((event) => <li key={event.id}><span className="activity-dot"/><div><strong>{event.actor_name}</strong> {event.action} {event.entity_type}<small>{new Date(event.created_at).toLocaleString()}</small></div></li>)}</ul> : <div className="empty">还没有活动记录</div>}
    </section>
  </>;
}

function WorkItems({ projectId, kind }: { projectId: string; kind: 'requirement' | 'bug' }) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api<{ items: WorkItem[] }>(`/api/projects/${projectId}/items?kind=${kind}`).then((r) => setItems(r.items)).catch((e: Error) => setError(e.message)), [projectId, kind]);
  useEffect(() => { void load(); }, [load]);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    await api(`/api/projects/${projectId}/items`, { method: 'POST', body: JSON.stringify({ kind, title: data.get('title'), description: data.get('description'), priority: data.get('priority') }) });
    setShowCreate(false); await load();
  };
  const setStatus = async (item: WorkItem, status: string) => { await api(`/api/projects/${projectId}/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); };
  const remove = async (item: WorkItem) => { if (!confirm(`确认删除 ${item.code}？`)) return; await api(`/api/projects/${projectId}/items/${item.id}`, { method: 'DELETE' }); await load(); };
  const title = kind === 'bug' ? 'Bug 管理' : '需求管理';
  return <section className="panel">
    <div className="panel-title"><div><h2>{title}</h2><p>编号由系统自动生成，所有修改保存在 PostgreSQL。</p></div><button className="primary" onClick={() => setShowCreate(true)}>+ 新建{kind === 'bug' ? ' Bug' : '需求'}</button></div>
    {error && <p className="error">{error}</p>}
    <div className="table-wrap"><table><thead><tr><th>编号</th><th>标题</th><th>优先级</th><th>状态</th><th>负责人</th><th>版本</th><th></th></tr></thead><tbody>
      {items.map((item) => <tr key={item.id}><td><span className="code">{item.code}</span></td><td><strong>{item.title}</strong><small>{item.description || '暂无描述'}</small></td><td><span className={`priority ${item.priority}`}>{item.priority}</span></td><td><select value={item.status} onChange={(e) => void setStatus(item, e.target.value)}><option value="open">待处理</option><option value="planned">已计划</option><option value="in_progress">进行中</option><option value="blocked">已阻塞</option><option value="resolved">已解决</option><option value="closed">已关闭</option></select></td><td>{item.assignee_name ?? '未分配'}</td><td>{item.version_name ?? '未关联'}</td><td><button className="danger-link" onClick={() => void remove(item)}>删除</button></td></tr>)}
      {!items.length && <tr><td colSpan={7}><div className="empty">暂无数据，创建第一条记录吧</div></td></tr>}
    </tbody></table></div>
    {showCreate && <Modal title={`新建${kind === 'bug' ? ' Bug' : '需求'}`} onClose={() => setShowCreate(false)}><form className="stack" onSubmit={(e) => void create(e)}><label>标题<input name="title" required maxLength={300}/></label><label>描述<textarea name="description" rows={5}/></label><label>优先级<select name="priority" defaultValue="medium"><option value="urgent">紧急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label><div className="actions"><button type="button" onClick={() => setShowCreate(false)}>取消</button><button className="primary">创建</button></div></form></Modal>}
  </section>;
}

function Versions({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<Version[]>([]); const [open, setOpen] = useState(false);
  const load = useCallback(() => api<{ items: Version[] }>(`/api/projects/${projectId}/versions`).then((r) => setItems(r.items)), [projectId]);
  useEffect(() => { void load(); }, [load]);
  const create = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); await api(`/api/projects/${projectId}/versions`, { method: 'POST', body: JSON.stringify({ name: data.get('name'), status: data.get('status'), start_date: data.get('start_date') || null, release_date: data.get('release_date') || null }) }); setOpen(false); await load(); };
  const remove = async (item: Version) => { if (!confirm(`确认删除版本 ${item.name}？`)) return; await api(`/api/projects/${projectId}/versions/${item.id}`, { method: 'DELETE' }); await load(); };
  return <section className="panel"><div className="panel-title"><div><h2>版本管理</h2><p>维护版本范围与发布时间。</p></div><button className="primary" onClick={() => setOpen(true)}>+ 新建版本</button></div>
    <div className="card-grid">{items.map((item) => <article className="version-card" key={item.id}><div><span className="badge">{statusText[item.status] ?? item.status}</span><button className="danger-link" onClick={() => void remove(item)}>删除</button></div><h3>{item.name}</h3><p>{item.start_date ?? '未设开始日期'} → {item.release_date ?? '未设发布日期'}</p></article>)}{!items.length && <div className="empty">暂无版本</div>}</div>
    {open && <Modal title="新建版本" onClose={() => setOpen(false)}><form className="stack" onSubmit={(e) => void create(e)}><label>版本名称<input name="name" required/></label><label>状态<select name="status"><option value="planned">已计划</option><option value="active">进行中</option><option value="released">已发布</option></select></label><div className="two-cols"><label>开始日期<input name="start_date" type="date"/></label><label>发布日期<input name="release_date" type="date"/></label></div><div className="actions"><button type="button" onClick={() => setOpen(false)}>取消</button><button className="primary">创建</button></div></form></Modal>}
  </section>;
}

function Cases({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<TestCase[]>([]); const [open, setOpen] = useState(false);
  const load = useCallback(() => api<{ items: TestCase[] }>(`/api/projects/${projectId}/test-cases`).then((r) => setItems(r.items)), [projectId]);
  useEffect(() => { void load(); }, [load]);
  const create = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); await api(`/api/projects/${projectId}/test-cases`, { method: 'POST', body: JSON.stringify(Object.fromEntries(data.entries())) }); setOpen(false); await load(); };
  const remove = async (item: TestCase) => { if (!confirm(`确认删除用例 ${item.code}？`)) return; await api(`/api/projects/${projectId}/test-cases/${item.id}`, { method: 'DELETE' }); await load(); };
  return <section className="panel"><div className="panel-title"><div><h2>测试用例</h2><p>记录前置条件、步骤和预期结果。</p></div><button className="primary" onClick={() => setOpen(true)}>+ 新建用例</button></div>
    <div className="table-wrap"><table><thead><tr><th>编号</th><th>模块 / 标题</th><th>优先级</th><th>状态</th><th>预期结果</th><th></th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><span className="code">{item.code}</span></td><td><small>{item.module}</small><strong>{item.title}</strong></td><td>{item.priority}</td><td><span className="badge">{statusText[item.status] ?? item.status}</span></td><td>{item.expected_result}</td><td><button className="danger-link" onClick={() => void remove(item)}>删除</button></td></tr>)}{!items.length && <tr><td colSpan={6}><div className="empty">暂无测试用例</div></td></tr>}</tbody></table></div>
    {open && <Modal title="新建测试用例" onClose={() => setOpen(false)}><form className="stack" onSubmit={(e) => void create(e)}><label>标题<input name="title" required/></label><div className="two-cols"><label>模块<input name="module" defaultValue="General" required/></label><label>优先级<select name="priority"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label></div><label>前置条件<textarea name="preconditions" rows={2}/></label><label>测试步骤<textarea name="steps" rows={4} required placeholder={'1. 打开页面\n2. 执行操作'}/></label><label>预期结果<textarea name="expected_result" rows={3} required/></label><input type="hidden" name="status" value="draft"/><div className="actions"><button type="button" onClick={() => setOpen(false)}>取消</button><button className="primary">创建</button></div></form></Modal>}
  </section>;
}

function Team({ projectId, currentUser }: { projectId: string; currentUser: User }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [showAccount, setShowAccount] = useState(false);
  const load = useCallback(async () => {
    const [memberResult, directoryResult] = await Promise.all([
      api<{ items: Member[] }>(`/api/projects/${projectId}/members`),
      api<{ items: DirectoryUser[] }>('/api/directory'),
    ]);
    setMembers(memberResult.items); setDirectory(directoryResult.items);
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  const available = directory.filter((user) => !members.some((member) => member.id === user.id));
  const add = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const userId = String(data.get('user_id')); if (!userId) return; await api(`/api/projects/${projectId}/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role: data.get('role') }) }); await load(); };
  const createAccount = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); await api('/api/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(data.entries())) }); setShowAccount(false); await load(); };
  const remove = async (member: Member) => { if (!confirm(`确认移除 ${member.display_name}？`)) return; await api(`/api/projects/${projectId}/members/${member.id}`, { method: 'DELETE' }); await load(); };
  return <section className="panel"><div className="panel-title"><div><h2>项目团队</h2><p>为成员分配负责人、成员或只读角色。</p></div>{currentUser.role === 'admin' && <button onClick={() => setShowAccount(true)}>+ 创建账号</button>}</div>
    <form className="inline-form" onSubmit={(e) => void add(e)}><select name="user_id" required defaultValue=""><option value="" disabled>选择已有账号</option>{available.map((user) => <option key={user.id} value={user.id}>{user.display_name} · {user.email}</option>)}</select><select name="role" defaultValue="member"><option value="owner">负责人</option><option value="member">成员</option><option value="viewer">只读</option></select><button className="primary">添加成员</button></form>
    <div className="table-wrap"><table><thead><tr><th>姓名</th><th>邮箱</th><th>项目角色</th><th>加入时间</th><th></th></tr></thead><tbody>{members.map((member) => <tr key={member.id}><td><strong>{member.display_name}</strong></td><td>{member.email}</td><td><span className="badge">{member.role}</span></td><td>{new Date(member.created_at).toLocaleDateString()}</td><td><button className="danger-link" onClick={() => void remove(member)}>移除</button></td></tr>)}</tbody></table></div>
    {showAccount && <Modal title="创建账号" onClose={() => setShowAccount(false)}><form className="stack" onSubmit={(e) => void createAccount(e)}><label>姓名<input name="display_name" required/></label><label>邮箱<input name="email" type="email" required/></label><label>初始密码<input name="password" type="password" minLength={12} required/></label><label>系统角色<select name="role"><option value="user">普通用户</option><option value="admin">管理员</option></select></label><div className="actions"><button type="button" onClick={() => setShowAccount(false)}>取消</button><button className="primary">创建账号</button></div></form></Modal>}
  </section>;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [showProject, setShowProject] = useState(false);
  const [error, setError] = useState('');
  const loadProjects = useCallback(async () => { const result = await api<{ items: Project[] }>('/api/projects'); setProjects(result.items); setProjectId((current) => current || result.items[0]?.id || ''); }, []);
  useEffect(() => { if (!tokenStore.get()) return; api<{ user: User }>('/api/me').then((r) => { setUser(r.user); return loadProjects(); }).catch(() => tokenStore.clear()); }, [loadProjects]);
  useEffect(() => { if (user) void loadProjects(); }, [user, loadProjects]);
  const currentProject = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);
  const createProject = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setError(''); const data = new FormData(event.currentTarget); try { const project = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ project_key: data.get('project_key'), name: data.get('name'), description: data.get('description') }) }); setShowProject(false); await loadProjects(); setProjectId(project.id); } catch (reason) { setError(reason instanceof Error ? reason.message : '创建失败'); } };
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); tokenStore.clear(); setUser(null); setProjects([]); };
  if (!user) return <Login onLogin={setUser}/>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand"><div className="brand-mark small">PS</div><div><strong>Project Studio</strong><small>Community</small></div></div>
      <label className="project-select">当前项目<select value={projectId} onChange={(e) => { setProjectId(e.target.value); setTab('overview'); }}><option value="">请选择</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.project_key} · {project.name}</option>)}</select></label>
      <button className="create-project" onClick={() => setShowProject(true)}>+ 创建项目</button>
      <nav>{([['overview', '总览'], ['requirements', '需求'], ['bugs', 'Bug'], ['versions', '版本'], ['cases', '测试用例'], ['team', '项目团队']] as [Tab, string][]).map(([key, label]) => <button className={tab === key ? 'active' : ''} onClick={() => setTab(key)} key={key}>{label}</button>)}</nav>
      <div className="sidebar-user"><span className="avatar">{user.display_name.slice(0, 1).toUpperCase()}</span><div><strong>{user.display_name}</strong><small>{user.email}</small></div><button className="icon-button" onClick={() => void logout()} title="退出">↗</button></div>
    </aside>
    <main className="content"><header className="topbar"><div><p className="eyebrow">{currentProject?.project_key ?? 'NO PROJECT'}</p><h1>{currentProject?.name ?? '开始使用 Project Studio'}</h1></div><span className="privacy-pill">通用版 · 无公司数据</span></header>
      {!projectId ? <section className="welcome"><h2>创建第一个项目</h2><p>项目建好后即可管理需求、Bug、版本和测试用例。</p><button className="primary" onClick={() => setShowProject(true)}>创建项目</button></section> : <div className="workspace">{tab === 'overview' && <Overview projectId={projectId}/>} {tab === 'requirements' && <WorkItems projectId={projectId} kind="requirement"/>} {tab === 'bugs' && <WorkItems projectId={projectId} kind="bug"/>} {tab === 'versions' && <Versions projectId={projectId}/>} {tab === 'cases' && <Cases projectId={projectId}/>} {tab === 'team' && <Team projectId={projectId} currentUser={user}/>}</div>}
    </main>
    {showProject && <Modal title="创建项目" onClose={() => setShowProject(false)}><form className="stack" onSubmit={(e) => void createProject(e)}><label>项目编号<input name="project_key" required placeholder="DEMO" pattern="[A-Za-z][A-Za-z0-9_-]{1,19}"/></label><label>项目名称<input name="name" required placeholder="示例项目"/></label><label>项目说明<textarea name="description" rows={4}/></label>{error && <p className="error">{error}</p>}<div className="actions"><button type="button" onClick={() => setShowProject(false)}>取消</button><button className="primary">创建</button></div></form></Modal>}
  </div>;
}
