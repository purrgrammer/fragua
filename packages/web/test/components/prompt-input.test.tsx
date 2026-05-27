// Layout regression test for the PromptInput submit button.
//
// Bug: in the default composition (textarea + footer + submit) the footer
// inherited InputGroupAddon's block-end variant, which applies px-3 / pb-2 —
// 12px horizontal vs 8px bottom inset. Visually the submit icon at the
// bottom-right ended up further from the right edge than from the bottom.
//
// Expectation: the footer renders the submit at the bottom-right of the
// input, with equal horizontal and bottom inset from the corner.

import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "../../src/components/ai-elements/prompt-input.tsx";
import { useDom } from "../setup.ts";

describe("PromptInput submit positioning", () => {
  useDom();
  afterEach(() => cleanup());

  it("places the submit at the bottom-right of the input with equal x/y inset from the corner", () => {
    const { container } = render(
      <PromptInput onSubmit={() => {}} data-testid="form">
        <PromptInputTextarea aria-label="Message" />
        <PromptInputFooter data-testid="footer">
          <PromptInputSubmit data-testid="submit" />
        </PromptInputFooter>
      </PromptInput>,
    );

    const footer = within(container).getByTestId("footer");
    const submit = within(container).getByTestId("submit");

    // Submit is the last (rightmost) interactive child of the footer.
    expect(footer.contains(submit)).toBe(true);
    expect(footer.lastElementChild).toBe(submit);

    // Equal inset: pull the explicit padding tokens off the footer and
    // assert the horizontal and bottom values reference the same spacing
    // step. We accept either px-* or matching pr-*/pl-*.
    const cls = footer.className;

    const pb = cls.match(/(?:^|\s)pb-\[var\(--sw-space-(\d)\)\]/)?.[1];
    const px = cls.match(/(?:^|\s)px-\[var\(--sw-space-(\d)\)\]/)?.[1];
    const pr = cls.match(/(?:^|\s)pr-\[var\(--sw-space-(\d)\)\]/)?.[1];

    if (!pb) throw new Error(`expected a pb-[var(--sw-space-N)] token, got className: ${cls}`);

    const horizontal = px ?? pr;
    if (!horizontal)
      throw new Error(`expected a horizontal padding token (px-* or pr-*) on the footer, got className: ${cls}`);

    expect(horizontal, `horizontal inset (${horizontal}) must equal bottom inset (${pb})`).toBe(pb);
  });

  it("submit aligns to the right when it is the only footer child (no PromptInputTools)", () => {
    const { container } = render(
      <PromptInput onSubmit={() => {}} data-testid="form">
        <PromptInputTextarea aria-label="Message" />
        <PromptInputFooter data-testid="footer">
          <PromptInputSubmit data-testid="submit" />
        </PromptInputFooter>
      </PromptInput>,
    );

    const submit = within(container).getByTestId("submit");

    // ml-auto on the submit pushes it to the footer's right edge under flex,
    // independent of whether a PromptInputTools spacer sits to its left.
    expect(submit.className).toMatch(/(?:^|\s)ml-auto(?:\s|$)/);
  });
});
