import { useState } from "react";

/**
 * Form state for a filter control that the URL can also change.
 *
 * These pages keep their filters in local state because the form only applies
 * on submit — you pick an app, then press Apply. `useState(filters.appId)`
 * alone is wrong for that, though: the initialiser runs once, and switching
 * app from the sidebar is a client-side navigation that re-runs the loader
 * WITHOUT remounting the page. The list updated, the control did not, and the
 * App dropdown sat there naming an app whose customers were no longer on
 * screen.
 *
 * This is React's documented "adjusting state when a prop changes" pattern:
 * compare against the last value seen from the loader and reset during render,
 * so there is no effect and no intermediate paint showing the stale value.
 *
 * Typing is unaffected — the reset only fires when the value FROM THE LOADER
 * changes, not on every render, so edits in progress are never clobbered.
 */
export function useFilterState<T>(fromLoader: T): [T, (next: T) => void] {
  const [value, setValue] = useState(fromLoader);
  const [lastFromLoader, setLastFromLoader] = useState(fromLoader);

  if (fromLoader !== lastFromLoader) {
    setLastFromLoader(fromLoader);
    setValue(fromLoader);
  }

  return [value, setValue];
}
