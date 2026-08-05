// Presentation-side removal of the `<fragua_output_<sha256>>` boundary tags
// that `${{ outputs.X.f }}` interpolation wraps around a value before it goes
// into an `llm` prompt (see @fragua/core's substitution.ts).
//
// The tags have to exist in the bytes sent to the provider — they are what
// stops an upstream-laundered value from posing as an instruction, and the
// content hash on the closing tag is what makes breaking out a preimage
// problem. They are for the model, not the operator.
//
// The engine assumed a markdown renderer would treat the pair as an unknown
// element and drop it. It cannot: a CommonMark HTML tag name is
// `[A-Za-z][A-Za-z0-9-]*`, and `fragua_output_<hash>` contains underscores, so
// the delimiters never parse as tags at all. They fall through as literal text
// and print a 64-hex-character open and close around every interpolated value.
//
// Widening the assumption is not the fix. A name the parser *does* accept would
// be dropped — that is what happens to a prompt's own `<paths>` placeholder —
// but the pair would then be dropped by a renderer rather than by us, leaving
// nothing to guarantee it. Stripping explicitly keeps the event log the source
// of truth: the tags stay on the message as it was actually sent, and only the
// operator's view is cleaned.

/** Open or close tag of an output envelope. The id is a fixed-length hex
 *  digest, so this is a linear scan with nothing to backtrack over. */
const ENVELOPE_TAG = /<\/?fragua_output_[0-9a-f]{64}>/g;

/** Drop the envelope tags, keeping the value they wrap.
 *
 * Unpaired tags are dropped too: a value truncated mid-render leaves a lone
 * open tag, which is exactly the artefact worth hiding. */
export function stripOutputEnvelopes(text: string): string {
  return text.replace(ENVELOPE_TAG, "");
}
