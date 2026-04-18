// shadcn/ui — Table primitives. Thin wrappers over semantic `<table>`
// elements; responsive horizontal scroll is handled by the outer wrapper.
//
// Skill citations (.agents/skills/design/SKILL.md):
//  - Typography §"sm 12 — Default body": dropped explicit `text-sm` so
//    tables inherit the 12px global body size rather than Tailwind's 14px
//    `sm`. Hierarchy comes from weight/case, not size jumps.
//  - Typography §"`UPPERCASE` with ~0.06em letter-spacing for section
//    labels and column headers": `<TableHead>` becomes uppercase 11px
//    with tracking, weight 500. No size jump from body.
//  - Typography §"1.0 for dense numeric tables": rows use `leading-tight`
//    to compress vertical rhythm; cells stay aligned via `align-middle`.
//  - Spacing §"4px base. These steps only — no arbitrary px": replaced
//    `h-10` (40px, off the 2/4/8/12/16/24/32 ladder) with token padding
//    `py-2` (8px) on the head cell.
//  - Color §"Background shade for hierarchy → hairline": removed
//    `data-[state=selected]:bg-muted` — selection is not currently used
//    here, and a bg-shade selection state would violate the hairline rule
//    if reintroduced.
//  - Motion §"Hover on hot rows. Omit hover animation on list rows users
//    traverse hundreds of times per session" + §"linear only for constant
//    motion — never for color": dropped `hover:bg-muted/50` and
//    `transition-colors` from `<TableRow>`. Tables are hot lists.
//  - Borders §"1px only": `border-b` retains the 1px hairline between
//    rows; nothing else carries weight.

import { forwardRef } from "react";
import { cn } from "../../lib/cn.ts";

export const Table = forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table ref={ref} className={cn("w-full caption-bottom", className)} {...props} />
    </div>
  ),
);
Table.displayName = "Table";

export const TableHeader = forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />,
);
TableHeader.displayName = "TableHeader";

export const TableBody = forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  ),
);
TableBody.displayName = "TableBody";

export const TableRow = forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => <tr ref={ref} className={cn("border-b leading-tight", className)} {...props} />,
);
TableRow.displayName = "TableRow";

export const TableHead = forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "px-2 py-2 text-left align-middle text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";

export const TableCell = forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("p-2 align-middle [&:has([role=checkbox])]:pr-0", className)} {...props} />
  ),
);
TableCell.displayName = "TableCell";
