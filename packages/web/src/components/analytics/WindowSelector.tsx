// Time-window dropdown for /analytics. Single Select for every
// viewport — keeps the chrome quiet in the page header and avoids the
// segmented bar growing wider than the title slot at narrow widths.

import { WINDOWS, type WindowKey } from "@/lib/analytics";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";

export interface WindowSelectorProps {
  value: WindowKey;
  onChange: (next: WindowKey) => void;
}

export function WindowSelector({ value, onChange }: WindowSelectorProps): JSX.Element {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as WindowKey)}>
      <SelectTrigger className="w-[10rem]" aria-label="Time window" data-testid="window-selector">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {WINDOWS.map((w) => (
          <SelectItem key={w.key} value={w.key} data-testid={`window-${w.key}`}>
            {w.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
