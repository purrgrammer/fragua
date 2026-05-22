import { Link } from "react-router-dom";

export interface ProjectLinkProps {
  /** Project IDENTITY (`project_id`) — the URL-safe wire identity. */
  projectId: string;
  /** Display label. Defaults to the project id when no `name`/children given. */
  name?: string;
  variant?: "plain" | "text" | "mono";
  className?: string;
  "data-testid"?: string;
  title?: string;
  children?: React.ReactNode;
}

export function ProjectLink({
  projectId,
  name,
  variant = "plain",
  className,
  "data-testid": testId,
  title,
  children,
}: ProjectLinkProps): JSX.Element {
  const to = `/projects/${projectId}`;
  const content = children ?? name ?? projectId;

  const variantClass =
    variant === "text"
      ? "truncate text-xs text-sw-muted hover:text-sw-text hover:underline"
      : variant === "mono"
        ? "font-mono text-xs text-sw-muted transition-colors duration-[var(--sw-duration-hover)] hover:text-sw-text hover:underline"
        : "";

  return (
    <Link
      to={to}
      title={title}
      data-testid={testId}
      className={[variantClass, className].filter(Boolean).join(" ") || undefined}
    >
      {content}
    </Link>
  );
}
