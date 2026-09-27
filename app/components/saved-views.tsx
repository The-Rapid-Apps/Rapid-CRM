import {
  BlockStack,
  Button,
  InlineStack,
  Modal,
  Popover,
  Text,
  TextField,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { ConfirmDialog } from "~/components/confirm-dialog";
import type {
  SavedView,
  SavedViewReport,
} from "~/lib/saved-views/saved-view-schemas";

/**
 * "Saved filters" for any report (Mantle's name for them): a dropdown to apply
 * or manage saved views, and a Save button for the view on screen. Each report
 * supplies what a view is (`current`), how to show one (`describe`) and how
 * to open one (`apply`); storage is shared — see saved-views.server.ts.
 */

const ACTION = "/app/saved-views";

interface SavedViewsBase<S> {
  report: SavedViewReport;
  /** The view on screen, as it would be saved. */
  current: S;
  /** Short summary pills for the Save/manage modal. */
  describe: (state: S) => string[];
}

/** Same dialog for saving the view on screen and for managing a saved one
 * (as in Mantle, a saved filter's "…" reopens it pre-filled, showing the
 * settings it was SAVED with, not the live toolbar). */
function SaveViewModal<S>({
  open,
  onClose,
  existing,
  report,
  current,
  describe,
}: SavedViewsBase<S> & {
  open: boolean;
  onClose: () => void;
  existing?: SavedView<S>;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const [name, setName] = useState(existing?.name ?? "");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";
  const error = fetcher.state === "idle" ? fetcher.data?.error : undefined;

  useEffect(() => {
    if (open) setName(existing?.name ?? "");
  }, [open, existing?.name]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !fetcher.data.error) {
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const submit = (fields: Record<string, string>) => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    fetcher.submit(formData, { method: "post", action: ACTION });
  };

  const submitSave = () =>
    submit(
      existing
        ? { intent: "rename", id: existing.id, name: name.trim() }
        : {
            intent: "create",
            report,
            name: name.trim(),
            state: JSON.stringify(current),
          },
    );

  return (
    <Modal open={open} onClose={onClose} title="Save filters">
      <Modal.Section>
        <BlockStack gap="300">
          <TextField
            label="Label"
            labelHidden
            placeholder="Enter a short label"
            value={name}
            onChange={setName}
            autoComplete="off"
            error={error}
          />
          <BlockStack gap="150">
            <Text as="span" variant="bodySm" tone="subdued">
              Filters
            </Text>
            <div
              className="thin-scrollbar"
              style={{ display: "flex", gap: "8px", overflowX: "auto" }}
            >
              {describe(existing ? existing.state : current).map(
                (pill, index) => (
                  <span
                    key={index}
                    className="reports-filter-tag reports-filter-tag--plain"
                  >
                    <span className="reports-filter-tag__label">{pill}</span>
                  </span>
                ),
              )}
            </div>
          </BlockStack>
          <InlineStack align="space-between" blockAlign="center">
            {existing ? (
              <span className="reports-delete-filter-btn">
                <Button
                  variant="primary"
                  tone="critical"
                  loading={isSubmitting}
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  Delete saved filter
                </Button>
              </span>
            ) : (
              <span />
            )}
            <InlineStack gap="200">
              <Button onClick={onClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!name.trim()}
                loading={isSubmitting}
                onClick={submitSave}
              >
                Save filters
              </Button>
            </InlineStack>
          </InlineStack>
        </BlockStack>
      </Modal.Section>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        title="Delete this saved filter?"
        confirmLabel="Delete"
        loading={isSubmitting}
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          if (existing) submit({ intent: "delete", id: existing.id });
        }}
      >
        <Text as="p">This can&apos;t be undone.</Text>
      </ConfirmDialog>
    </Modal>
  );
}

export function SavedViewsPicker<S>({
  views,
  apply,
  reset,
  ...base
}: SavedViewsBase<S> & {
  views: Array<SavedView<S>>;
  apply: (state: S) => void;
  /** Back to the report's defaults; offered at the top of the list. */
  reset: () => void;
}) {
  const [active, setActive] = useState(false);
  const [editing, setEditing] = useState<SavedView<S> | null>(null);

  return (
    <>
      <Popover
        active={active}
        onClose={() => setActive(false)}
        activator={
          <Button disclosure onClick={() => setActive((value) => !value)}>
            Saved filters
          </Button>
        }
      >
        <Popover.Pane fixed>
          <div style={{ padding: "var(--p-space-100)", minWidth: "180px" }}>
            <BlockStack gap="0">
              <Button
                variant="tertiary"
                textAlign="left"
                fullWidth
                size="slim"
                onClick={() => {
                  setActive(false);
                  reset();
                }}
              >
                Reset filters
              </Button>
              <div
                style={{
                  borderTop: "1px solid var(--p-color-border)",
                  margin: "var(--p-space-100) 0",
                }}
              />
              {views.length === 0 ? (
                <div style={{ padding: "var(--p-space-200)" }}>
                  <Text as="span" variant="bodySm" tone="subdued">
                    No saved filters yet
                  </Text>
                </div>
              ) : (
                views.map((view) => (
                  <InlineStack
                    key={view.id}
                    gap="0"
                    blockAlign="center"
                    wrap={false}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Button
                        variant="tertiary"
                        textAlign="left"
                        fullWidth
                        size="slim"
                        onClick={() => {
                          setActive(false);
                          apply(view.state);
                        }}
                      >
                        {view.name}
                      </Button>
                    </div>
                    <Button
                      variant="tertiary"
                      size="slim"
                      accessibilityLabel={`Manage ${view.name}`}
                      onClick={() => {
                        setActive(false);
                        setEditing(view);
                      }}
                    >
                      …
                    </Button>
                  </InlineStack>
                ))
              )}
            </BlockStack>
          </div>
        </Popover.Pane>
      </Popover>
      <SaveViewModal
        {...base}
        open={editing !== null}
        onClose={() => setEditing(null)}
        existing={editing ?? undefined}
      />
    </>
  );
}

export function SaveViewButton<S>(props: SavedViewsBase<S>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Save</Button>
      <SaveViewModal {...props} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
