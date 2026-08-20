import { Inbox, Search } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  actions,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {actions !== undefined && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder = "Search",
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}) {
  return (
    <label className="search-field">
      <Search aria-hidden="true" />
      <span className="sr-only">{placeholder}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

export function EmptyState({ title, detail }: { readonly title: string; readonly detail?: string }) {
  return (
    <div className="empty-state">
      <Inbox aria-hidden="true" />
      <strong>{title}</strong>
      {detail !== undefined && <span>{detail}</span>}
    </div>
  );
}

export function StatusBadge({ status }: { readonly status: "canon" | "draft" }) {
  return <span className={`status-badge status-badge--${status}`}>{status}</span>;
}
