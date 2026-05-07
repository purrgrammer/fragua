import { Link } from "react-router-dom";
import { Badge } from "./ui/badge.tsx";

export interface WorkflowLinkProps {
  name: string;
  cwd?: string;
  label?: string;
  variant?: "plain" | "text" | "badge";
  className?: string;
  "data-testid"?: string;
  title?: string;
  children?: React.ReactNode;
}

export function WorkflowLink({
  name,
  cwd,
  label,
  variant = "plain",
  className,
  "data-testid": testId,
  title,
  children,
}: WorkflowLinkProps): JSX.Element {
  const to = `/workflows/${encodeURIComponent(name)}${cwd !== undefined ? `?cwd=${encodeURIComponent(cwd)}` : ""}`;
  const content = children ?? label ?? name;

  if (variant === "badge") {
    return (
      <Link to={to} title={title} data-testid={testId} className={`inline-flex max-w-full ${className ?? ""}`}>
        <Badge variant="muted" className="max-w-full truncate hover:underline">
          {content}
        </Badge>
      </Link>
    );
  }

  const variantClass = variant === "text" ? "truncate text-xs text-sw-muted hover:text-sw-text hover:underline" : "";

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
