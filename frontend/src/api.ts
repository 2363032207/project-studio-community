export type User = { id: string; email: string; display_name: string; role: 'admin' | 'user' };
export type Project = { id: string; project_key: string; name: string; description: string; member_role: string };
export type Version = { id: string; name: string; status: string; start_date: string | null; release_date: string | null; objective: string; release_notes: string };
export type WorkItem = { id: string; code: string; kind: 'requirement' | 'bug'; title: string; description: string; status: string; priority: string; assignee_id?: string | null; assignee_name?: string; version_id?: string | null; version_name?: string; planned_start?: string | null; planned_end?: string | null; acceptance_criteria?: string; severity?: string | null; environment?: string; reproduction_steps?: string; actual_result?: string; expected_result?: string; estimate_points?: number | null };
export type TestCase = { id: string; code: string; title: string; module: string; priority: string; preconditions: string; steps: string; expected_result: string; status: string; suite_id?: string | null; suite_name?: string | null; case_type: string; automation_status: string; tags: string[]; requirement_ids?: string[]; requirement_codes?: string[]; result?: string; note?: string };
export type Member = { id: string; email: string; display_name: string; role: 'owner' | 'member' | 'viewer'; created_at: string };
export type DirectoryUser = { id: string; email: string; display_name: string };
export type Dashboard = { work_items: { kind: string; status: string; count: number }[]; test_cases: { status: string; count: number }[]; versions: { status: string; count: number }[]; recent: { id: number; action: string; entity_type: string; actor_name: string; created_at: string }[] };
export type Milestone = { id: string; title: string; description: string; status: string; due_date: string | null; progress: number; owner_id?: string | null; owner_name?: string | null };
export type Schedule = { id: string; title: string; schedule_type: string; status: string; start_date: string; end_date: string; owner_id?: string | null; owner_name?: string | null; related_code?: string | null };
export type TestSuite = { id: string; name: string; description: string; case_count: number };
export type TestPlan = { id: string; name: string; description: string; status: string; environment: string; version_id?: string | null; version_name?: string | null; owner_id?: string | null; owner_name?: string | null; start_date?: string | null; end_date?: string | null; case_count: number; passed_count: number; failed_count: number; blocked_count: number; cases?: TestCase[] };
export type CoverageItem = { id: string; code: string; title: string; status: string; priority: string; case_count: number; passed_count: number };
export type QualityReport = { work_items: { kind: string; status: string; count: number }[]; test_cases: { status: string; count: number }[]; execution: { result: string; count: number }[]; coverage: { total: number; covered: number }; overdue: number; milestones: { total: number; completed: number; at_risk: number } };

const TOKEN_KEY = 'project-studio-token';
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  if (response.status === 401) tokenStore.clear();
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
    throw new Error(body.message ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
