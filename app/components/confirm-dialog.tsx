import { Modal } from "@shopify/polaris";
import type { ReactNode } from "react";

/**
 * Shared confirmation modal for a destructive/critical action. Deliberately
 * just the modal shell — the trigger and submission mechanism (bare `Form`,
 * `useSubmit`, `ActionList` item, fetcher) differ per call site, and forcing
 * those into one generic component would be riskier than it's worth.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  loading,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      primaryAction={{
        content: confirmLabel,
        destructive,
        loading,
        onAction: onConfirm,
      }}
      secondaryActions={[{ content: cancelLabel, onAction: onClose }]}
    >
      <Modal.Section>{children}</Modal.Section>
    </Modal>
  );
}
