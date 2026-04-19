import type { ToolDescriptor, ToolRegistry } from "./types.ts";

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();

  register<A, R>(desc: ToolDescriptor<A, R>): void {
    if (this.tools.has(desc.name)) {
      throw new Error(`tool already registered: ${desc.name}`);
    }
    this.tools.set(desc.name, desc as ToolDescriptor);
  }

  get<A = unknown, R = unknown>(name: string): ToolDescriptor<A, R> {
    const desc = this.tools.get(name);
    if (desc == null) throw new Error(`unknown tool: ${name}`);
    return desc as ToolDescriptor<A, R>;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): string[] {
    return Array.from(this.tools.keys()).sort();
  }
}
