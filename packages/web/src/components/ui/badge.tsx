// shadcn/ui — Badge. Stateless pill with cva variants. Extended with two
// swarm-specific tones (success / warning) that aren't in the stock
// shadcn copy, because status pills are a recurring need in this app.

import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        // Status-family variants: deliberately match the health badge in
        // App.tsx so list rows and the header feel like one system.
        success: "border-emerald-300 bg-emerald-100 text-emerald-800",
        warning: "border-amber-300 bg-amber-100 text-amber-800",
        info: "border-violet-300 bg-violet-100 text-violet-800",
        muted: "border-slate-300 bg-slate-100 text-slate-700",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
