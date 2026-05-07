import { Link } from "react-router-dom";
import { encodeProjectId } from "../lib/projectId.ts";

export interface ProjectLinkProps {
  cwd: string;
  variant?: "plain" | "text" | "mono";
  className?: string;
  "data-testid"?: string;
  title?: string;
  children?: React.ReactNode;
}

export function ProjectLink({
  cwd,
  variant = "plain",
  className,
  "data-testid": testId,
  title,
  children,
}: ProjectLinkProps): JSX.Element {
  const to = `/projects/${encodeProjectId(cwd)}`;
  const content = children ?? basename(cwd);

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

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
