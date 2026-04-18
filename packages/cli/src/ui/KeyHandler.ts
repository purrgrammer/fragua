// Keypress dispatcher for the TUI.
//
// We model the keybindings as a pure `dispatchKey(input, key, handlers)`
// function so tests can exercise the logic without spinning up Ink's
// `useInput` hook (which requires a real stdin/stdout pair). The Ink
// component calls `dispatchKey` from inside `useInput`.
//
// Key map:
//   s         → onSteer      (open a prompt to submit a steering message)
//   a         → onAbort      (send a cancel control request)
//   q / Esc   → onQuit       (exit the TUI without aborting the run)
//   Ctrl-C    → onQuit       (same as q — quitting is always safe)
//
// The handlers are deliberately thin: the TUI has a mode state machine
// (idle / steering-prompt / confirming-abort) and this module only
// advertises which intent was requested. Mode transitions happen in the
// caller.

export interface KeyHandlers {
  onSteer: () => void;
  onAbort: () => void;
  onQuit: () => void;
}

/** Shape of the `key` object Ink passes to `useInput`. We depend on a
 * small subset to keep the contract portable — if Ink's API shifts we
 * adapt here instead of updating every call site. */
export interface InkKeyLike {
  escape?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  return?: boolean;
  backspace?: boolean;
}

/**
 * Dispatch a single keypress. Returns the name of the handler fired, or
 * `undefined` when the keypress didn't match anything. Uppercase letters
 * are folded to lowercase so a stray Shift doesn't swallow a keybind.
 *
 * Modifier rules: we require NO meta/shift/ctrl (except the Ctrl-C
 * special case) — this avoids stealing the user's terminal shortcuts.
 */
export function dispatchKey(
  input: string,
  key: InkKeyLike,
  handlers: KeyHandlers,
): "steer" | "abort" | "quit" | undefined {
  // Ctrl-C: always quit.
  if (key.ctrl === true && input.toLowerCase() === "c") {
    handlers.onQuit();
    return "quit";
  }
  // Escape: quit.
  if (key.escape === true) {
    handlers.onQuit();
    return "quit";
  }
  // Bare-letter binds — reject when any modifier (other than shift) is
  // held so Ctrl-S / Meta-S don't nuke the user's muscle memory.
  if (key.ctrl === true || key.meta === true) return undefined;
  const letter = input.toLowerCase();
  switch (letter) {
    case "s":
      handlers.onSteer();
      return "steer";
    case "a":
      handlers.onAbort();
      return "abort";
    case "q":
      handlers.onQuit();
      return "quit";
    default:
      return undefined;
  }
}
