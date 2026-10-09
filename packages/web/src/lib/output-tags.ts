const OUTPUT_TAG = /<(\/?)fragua_output_[0-9a-f]{64}>/g;

/** Unwrap `<fragua_output_<sha256>>…</fragua_output_<sha256>>` boundary tags so
 * a substituted prompt reads as the value it carries. The tags exist for the
 * model (the system prompt marks them as data, not instructions); a person
 * reading the conversation only wants the content. */
export function stripOutputTags(text: string): string {
  return text.replace(OUTPUT_TAG, "");
}
