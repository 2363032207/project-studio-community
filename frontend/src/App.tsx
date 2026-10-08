import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, tokenStore, type Project, type User } from './api';
import { AuditLog, Milestones, Overview, Reports, SchedulePage, Team, TestCases, TestPlans, Versions, WorkItems } from './pages';
import { Modal } from './ui';

type Tab = 'overview' | 'requirements' | 'bugs' | 'versions' | 'milestones' | 'schedules' | 'cases' | 'plans' | 'reports' | 'team' | 'audit';
const validTabs = new Set<Tab>(['overview','requirements','bugs','versions','milestones','schedules','cases','plans','reports','team','audit']);
const navigation: { title: string; items: { key: Tab; label: string; icon: string }[] }[] = [
  { title: '项目协作', items: [
    { key: 'overview', label: '项目总览', icon: '⌂' }, { key: 'requirements', label: '需求管理', icon: '◇' },
    { key: 'bugs', label: '问题管理', icon: '!' }, { key: 'versions', label: '版本管理', icon: '▣' },
  ] },
  { title: '计划与交付', items: [
    { key: 'milestones', label: '里程碑', icon: '⚑' }, { key: 'schedules', label: '进度安排', icon: '≋' },
  ] },
  { title: '质量管理', items: [
    { key: 'cases', label: '测试用例', icon: '✓' }, { key: 'plans', label: '测试计划', icon: '▷' },
    { key: 'reports', label: '质量报告', icon: '▥' },
  ] },
  { title: '项目设置', items: [
    { key: 'team', label: '项目团队', icon: '◉' }, { key: 'audit', label: '审计记录', icon: '↻' },
  ] },
];

function tabFromHash(): Tab {
  const value = window.location.hash.replace(/^#/, '') as Tab;
  return validTabs.has(value) ? value : 'overview';
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); const data = new FormData(event.currentTarget);
    try { const result = await api<{ token: string; user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) }); tokenStore.set(result.token); onLogin(result.user); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); }
    finally { setBusy(false); }
  };
  return <main className="login-shell"><section className="login-card"><div className="brand-lockup"><div className="brand-mark">PS</div><div><strong>Project Studio</strong><span>Community Edition</span></div></div><p className="eyebrow">SELF-HOSTED PROJECT & QUALITY PLATFORM</p><h1>让项目范围、交付与质量<br/>在一个工作台中闭环</h1><p className="muted">通用、可自托管，不依赖任何公司内部系统。</p><form onSubmit={submit} className="stack"><label>邮箱<input name="email" type="email" autoComplete="username" required placeholder="admin@example.com"/></label><label>密码<input name="password" type="password" autoComplete="current-password" required/></label>{error&&<p className="error">{error}</p>}<button className="primary login-button" disabled={busy}>{busy?'登录中…':'进入工作台'}</button></form><footer>PostgreSQL 持久化 · 完整审计 · 权限隔离</footer></section><section className="login-visual"><div className="visual-orb"><span>需求</span><span>版本</span><span>质量</span><b>PS</b><span>排期</span><span>问题</span><span>团队</span></div><h2>从想法到发布，保持信息一致</h2><p>需求、问题、排期、测试计划与报告相互关联。</p></section></main>;
}

export function App() {
  const [user,setUser]=useState<User|null>(null); const [projects,setProjects]=useState<Project[]>([]); const [projectId,setProjectId]=useState(''); const [tab,setTabState]=useState<Tab>(tabFromHash()); const [showProject,setShowProject]=useState(false); const [error,setError]=useState('');
  const loadProjects=useCallback(async()=>{const result=await api<{items:Project[]}>('/api/projects');setProjects(result.items);setProjectId((current)=>current||result.items[0]?.id||'');},[]);
  useEffect(()=>{if(!tokenStore.get())return;api<{user:User}>('/api/me').then((result)=>{setUser(result.user);return loadProjects();}).catch(()=>tokenStore.clear());},[loadProjects]);
  useEffect(()=>{if(user)void loadProjects();},[user,loadProjects]);
  useEffect(()=>{const handler=()=>setTabState(tabFromHash());window.addEventListener('hashchange',handler);return()=>window.removeEventListener('hashchange',handler);},[]);
  const setTab=(next:Tab)=>{setTabState(next);window.location.hash=next;};
  const currentProject=useMemo(()=>projects.find((project)=>project.id===projectId),[projects,projectId]);
  const createProject=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setError('');const data=new FormData(event.currentTarget);try{const project=await api<Project>('/api/projects',{method:'POST',body:JSON.stringify({project_key:data.get('project_key'),name:data.get('name'),description:data.get('description')})});setShowProject(false);await loadProjects();setProjectId(project.id);setTab('overview');}catch(reason){setError(reason instanceof Error?reason.message:'创建失败');}};
  const logout=async()=>{await api('/api/auth/logout',{method:'POST'}).catch(()=>undefined);tokenStore.clear();setUser(null);setProjects([]);};
  if(!user)return <Login onLogin={setUser}/>;
  const content = !projectId ? null : tab==='overview'?<Overview projectId={projectId}/>:tab==='requirements'?<WorkItems projectId={projectId} kind="requirement"/>:tab==='bugs'?<WorkItems projectId={projectId} kind="bug"/>:tab==='versions'?<Versions projectId={projectId}/>:tab==='milestones'?<Milestones projectId={projectId}/>:tab==='schedules'?<SchedulePage projectId={projectId}/>:tab==='cases'?<TestCases projectId={projectId}/>:tab==='plans'?<TestPlans projectId={projectId}/>:tab==='reports'?<Reports projectId={projectId}/>:tab==='team'?<Team projectId={projectId} currentUser={user}/>:<AuditLog projectId={projectId}/>;
  return <div className="app-shell"><aside className="sidebar"><div className="sidebar-brand"><div className="brand-mark small">PS</div><div><strong>Project Studio</strong><small>Community</small></div></div><label className="project-select"><span>当前项目</span><select value={projectId} onChange={(event)=>{setProjectId(event.target.value);setTab('overview');}}><option value="">请选择项目</option>{projects.map((project)=><option key={project.id} value={project.id}>{project.project_key} · {project.name}</option>)}</select></label><button className="create-project" onClick={()=>setShowProject(true)}>＋ 创建项目</button><nav>{navigation.map((group)=><section key={group.title}><h4>{group.title}</h4>{group.items.map((item)=><button key={item.key} className={tab===item.key?'active':''} onClick={()=>setTab(item.key)}><span>{item.icon}</span>{item.label}</button>)}</section>)}</nav><div className="sidebar-user"><span className="avatar">{user.display_name.slice(0,1).toUpperCase()}</span><div><strong>{user.display_name}</strong><small>{user.email}</small></div><button className="icon-button" onClick={()=>void logout()} title="退出登录">↗</button></div></aside><main className="content"><header className="topbar"><div><p className="eyebrow">{currentProject?.project_key??'NO PROJECT'}</p><h1>{currentProject?.name??'开始使用 Project Studio'}</h1></div><div className="topbar-actions"><span className="environment-pill"><i/>本地演示环境</span><span className="privacy-pill">通用版 · 虚构数据</span></div></header>{!projectId?<section className="welcome"><span>PROJECT STUDIO</span><h2>创建第一个项目</h2><p>项目建好后即可管理需求、问题、版本、排期、测试用例和质量报告。</p><button className="primary" onClick={()=>setShowProject(true)}>创建项目</button></section>:<div className="workspace">{content}</div>}</main>{showProject&&<Modal title="创建项目" onClose={()=>setShowProject(false)}><form className="stack" onSubmit={(event)=>void createProject(event)}><label>项目编号<input name="project_key" required placeholder="DEMO" pattern="[A-Za-z][A-Za-z0-9_-]{1,19}"/></label><label>项目名称<input name="name" required placeholder="示例项目"/></label><label>项目说明<textarea name="description" rows={4}/></label>{error&&<p className="error">{error}</p>}<div className="actions"><button type="button" onClick={()=>setShowProject(false)}>取消</button><button className="primary">创建项目</button></div></form></Modal>}</div>;
}
