import { Button, Toast } from "@shopify/polaris";
import { useState, type ComponentProps } from "react";
import { copyToClipboard } from "~/lib/clipboard";

/**
 * A Polaris `Button` that copies `value` to the clipboard and confirms it
 * with a Toast — every "Copy link"/"Copy review link"/icon-only copy button
 * in the app should use this instead of calling `copyToClipboard` directly,
 * so the confirmation stays consistent everywhere one is added.
 */
export function CopyButton({
  value,
  toastMessage = "Copied to clipboard",
  children,
  ...buttonProps
}: {
  value: string;
  toastMessage?: string;
} & Omit<ComponentProps<typeof Button>, "onClick">) {
  const [showToast, setShowToast] = useState(false);

  return (
    <>
      <Button
        {...buttonProps}
        onClick={() => {
          copyToClipboard(value);
          setShowToast(true);
        }}
      >
        {children}
      </Button>
      {showToast ? (
        <Toast
          content={toastMessage}
          duration={2000}
          onDismiss={() => setShowToast(false)}
        />
      ) : null}
    </>
  );
}
