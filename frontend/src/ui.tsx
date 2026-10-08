import type { ReactNode } from 'react';

export const labels: Record<string, string> = {
  open: '待处理', planned: '已计划', in_progress: '进行中', blocked: '已阻塞', resolved: '已解决', closed: '已关闭',
  active: '进行中', released: '已发布', archived: '已归档', draft: '草稿', ready: '可执行', deprecated: '已废弃',
  completed: '已完成', at_risk: '有风险', passed: '通过', failed: '失败', not_run: '未执行', skipped: '跳过',
  functional: '功能', integration: '集成', regression: '回归', performance: '性能', security: '安全', usability: '易用性',
  manual: '手工', candidate: '可自动化', automated: '已自动化', critical: '致命', major: '严重', minor: '一般', trivial: '轻微',
  task: '任务', review: '评审', release: '发布', test: '测试',
};

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></header>
      {children}
    </section>
  </div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <span>{eyebrow}</span>}<h2>{title}</h2><p>{description}</p></div>{actions && <div className="heading-actions">{actions}</div>}</div>;
}

export function StatusBadge({ value }: { value: string | null | undefined }) {
  return <span className={`status status-${value ?? 'none'}`}>{labels[value ?? ''] ?? value ?? '未设置'}</span>;
}

export function ProgressBar({ value }: { value: number }) {
  return <div className="progress"><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }}/></div>;
}

export function Empty({ title, description }: { title: string; description?: string }) {
  return <div className="empty"><strong>{title}</strong>{description && <p>{description}</p>}</div>;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '未设置';
  return new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString();
}
