// InboxRow — renders nothing for a runStatus with no attention metadata.
//
// REASON_META only covers the attention substatuses; a row whose runStatus
// is absent (schema loosened) or unmapped must fall through to `null` so the
// inbox never renders an unlabelled row.

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test } from "vitest";
import { InboxRow } from "../../src/components/Inbox.tsx";
import type { RunSummary } from "../../src/lib/api.ts";
import { summaryRow } from "../helpers/fixtures.ts";

describe("InboxRow", () => {
  afterEach(() => cleanup());

  test("returns null when the row's runStatus is omitted", () => {
    const { runStatus: _drop, ...rest } = summaryRow({ runId: "no-status", status: "paused" });
    const row = rest as RunSummary;
    const { container } = render(
      <MemoryRouter>
        <InboxRow row={row} reduce={true} />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="inbox-run-no-status"]')).toBeNull();
  });

  test("returns null for a runStatus with no attention metadata", () => {
    const row = summaryRow({ runId: "running-row", status: "running", runStatus: "running" });
    const { container } = render(
      <MemoryRouter>
        <InboxRow row={row} reduce={true} />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="inbox-run-running-row"]')).toBeNull();
  });
});
