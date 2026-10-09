import { CodeBlock, CodeBlockFilename, CodeBlockHeader, CodeBlockTitle } from "@/components/ai-elements/code-block";
import { type OutputProducer, prettyJson } from "@/lib/output-tags";

/** One value that substitution interpolated into a prompt, shown as what it
 * is: a labelled JSON block when the value is a record or array, a labelled
 * text block otherwise. The label names the producing step and field when the
 * run's emitted outputs contain the same bytes; an unmatched value is a run
 * input. */
export function OutputValueBlock({
  value,
  producer,
  testid,
}: {
  value: string;
  producer: OutputProducer | undefined;
  testid: string;
}): JSX.Element {
  const label = producer ? `outputs · ${producer.nodeId}.${producer.path}` : "input";
  const json = prettyJson(value);
  if (json !== null) {
    return (
      <CodeBlock code={json} language="json" data-testid={testid} data-producer={label} className="my-2">
        <CodeBlockHeader>
          <CodeBlockTitle>
            <CodeBlockFilename>{label}</CodeBlockFilename>
          </CodeBlockTitle>
        </CodeBlockHeader>
      </CodeBlock>
    );
  }
  return (
    <div
      data-testid={testid}
      data-producer={label}
      className="my-2 flex flex-col gap-1 rounded-sw-card border border-sw-border bg-sw-surface px-3 py-2"
    >
      <span className="font-mono text-sw-xs text-sw-muted uppercase tracking-[0.06em]">{label}</span>
      <pre className="whitespace-pre-wrap break-words font-mono text-sw-sm text-sw-text">{value}</pre>
    </div>
  );
}
