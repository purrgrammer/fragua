import type { ToolDescriptor, ToolRegistry } from "./types.ts";

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();
  private readonly visible: ReadonlySet<string> | null;

  constructor(visible?: Iterable<string> | null) {
    this.visible = visible == null ? null : new Set(visible);
  }

  register<A, R>(desc: ToolDescriptor<A, R>): void {
    if (this.visible !== null) {
      throw new Error("cannot register on a narrowed ToolRegistry view");
    }
    if (this.tools.has(desc.name)) {
      throw new Error(`tool already registered: ${desc.name}`);
    }
    this.tools.set(desc.name, desc as ToolDescriptor);
  }

  get<A = unknown, R = unknown>(name: string): ToolDescriptor<A, R> {
    if (this.visible !== null && !this.visible.has(name)) {
      throw new Error(`unknown tool: ${name}`);
    }
    const desc = this.tools.get(name);
    if (desc == null) throw new Error(`unknown tool: ${name}`);
    return desc as ToolDescriptor<A, R>;
  }

  has(name: string): boolean {
    if (this.visible !== null && !this.visible.has(name)) return false;
    return this.tools.has(name);
  }

  list(): string[] {
    const all = Array.from(this.tools.keys());
    const filtered = this.visible === null ? all : all.filter((n) => this.visible!.has(n));
    return filtered.sort();
  }

  select(opts: { allow?: readonly string[]; deny?: readonly string[] }): ToolRegistry {
    const base = this.visible ?? new Set(this.tools.keys());
    const allow = opts.allow != null ? new Set(opts.allow) : null;
    const deny = opts.deny != null ? new Set(opts.deny) : null;
    const picked: string[] = [];
    for (const name of base) {
      if (allow != null && !allow.has(name)) continue;
      if (deny?.has(name)) continue;
      picked.push(name);
    }
    const narrowed = new InMemoryToolRegistry(picked);
    // Share the underlying descriptor map so the narrowed view sees the
    // same registrations without re-registering.
    (narrowed as unknown as { tools: Map<string, ToolDescriptor> }).tools = this.tools;
    return narrowed;
  }
}
