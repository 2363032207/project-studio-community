export type User = { id: string; email: string; display_name: string; role: 'admin' | 'user' };
export type Project = { id: string; project_key: string; name: string; description: string; member_role: string };
export type Version = { id: string; name: string; status: string; start_date: string | null; release_date: string | null };
export type WorkItem = { id: string; code: string; kind: 'requirement' | 'bug'; title: string; description: string; status: string; priority: string; assignee_name?: string; version_name?: string };
export type TestCase = { id: string; code: string; title: string; module: string; priority: string; preconditions: string; steps: string; expected_result: string; status: string };
export type Member = { id: string; email: string; display_name: string; role: 'owner' | 'member' | 'viewer'; created_at: string };
export type DirectoryUser = { id: string; email: string; display_name: string };
export type Dashboard = { work_items: { kind: string; status: string; count: number }[]; test_cases: { status: string; count: number }[]; versions: { status: string; count: number }[]; recent: { id: number; action: string; entity_type: string; actor_name: string; created_at: string }[] };

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
