/**
 * Google's four-colour "G", inline.
 *
 * Not an <img>: a sign-in button whose logo can 404 is worse than one with no
 * logo, and this needs no second request. `aria-hidden` because the button
 * already says "Continue with Google" — announcing the mark as well would read
 * the word twice to a screen reader.
 *
 * The white tile is drawn INSIDE the svg, via a padded viewBox, rather than as
 * a wrapping element: Polaris types `Button`'s children as `string`, so markup
 * around the label is not an option, and the `icon` slot takes a bare
 * component. It earns its place anyway — Google's guidance puts the
 * four-colour mark on a light surface, and its blue quadrant muddies against
 * the button's purple fill.
 */
export function GoogleGlyph() {
  return (
    <svg viewBox="-8 -8 64 64" aria-hidden="true" focusable="false">
      <rect x="-8" y="-8" width="64" height="64" rx="12" fill="#ffffff" />
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
