// /inbox — uncapped list of runs that need operator attention.
//
// Home renders a capped Inbox with a "View all →" link to this page.
// The component is the same; we just drop the limit so every paused /
// quarantined run is visible at once.

import { Inbox } from "../components/Inbox.tsx";

export function InboxPage(): JSX.Element {
  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <Inbox />
    </section>
  );
}
