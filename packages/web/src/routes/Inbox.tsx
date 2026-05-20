// /inbox — uncapped list of runs that need operator attention,
// plus a "Recoverable work" section for terminal runs awaiting
// a worktree-inbox operator action.
//
// Home renders a capped Inbox with a "View all →" link to this page.
// The paused/quarantined Inbox component is unchanged; WorktreeInbox
// is a separate titled section below it.

import { Inbox } from "../components/Inbox.tsx";
import { WorktreeInbox } from "../components/WorktreeInbox.tsx";

export function InboxPage(): JSX.Element {
  return (
    <section className="flex w-full min-w-0 flex-col gap-6">
      <Inbox />
      <WorktreeInbox />
    </section>
  );
}
