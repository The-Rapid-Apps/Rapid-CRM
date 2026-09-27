/**
 * `navigator.clipboard` needs a secure context (HTTPS or localhost) — this
 * app's dev server is reached over a plain-HTTP network IP, so it falls back
 * to `execCommand("copy")`. That check must stay synchronous: deciding from
 * a `.catch()` runs after the user-gesture context needed by `execCommand`
 * has already lapsed.
 */
export function copyToClipboard(text: string): void {
  if (window.isSecureContext && navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
    return;
  }
  execCommandCopy(text);
}

function execCommandCopy(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  // A Polaris `Modal`'s focus trap yanks focus back to its own boundary the
  // instant it sees focus land on an element it doesn't recognize — exactly
  // this dynamically-inserted textarea — silently undoing `.select()` below
  // even though `execCommand` still reports success. Stopping `focusin` here
  // keeps the trap's document-level listener from ever seeing it.
  textarea.addEventListener("focusin", (e) => e.stopPropagation());
  const container = document.activeElement?.parentElement ?? document.body;
  container.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    document.execCommand("copy");
  } finally {
    container.removeChild(textarea);
  }
}
