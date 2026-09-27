import { ActionList, Button, Labelled, Popover } from "@shopify/polaris";
import { useState } from "react";
import { appMonogramDataUri } from "./app-identity";

/**
 * An app filter that shows each app's icon.
 *
 * A `Select` cannot: it renders a native `<select>`, whose `<option>` elements
 * are text-only in every browser. So this is a `Popover` + `ActionList`, whose
 * items take an `image` — the only Polaris control that puts a picture next to
 * a choice without hand-rolling a listbox.
 *
 * It keeps a hidden input so the surrounding filter form still submits the same
 * `appId` field it always did. That is what makes this a drop-in for the
 * `Select` it replaces: the form, the loader and the URL contract are unchanged.
 */
export function AppPicker({
  label = "App",
  labelHidden = false,
  name = "appId",
  value,
  onChange,
  apps,
  allLabel = "All apps",
  /**
   * Whether "All apps" is offered. False where the page is meaningless without
   * a specific app — a report scoped to one app's charges, say — so that an
   * empty value is not presentable in the first place.
   */
  allowAll = true,
}: {
  label?: string;
  labelHidden?: boolean;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  apps: Array<{ id: string; name: string; logoUrl?: string | null }>;
  allLabel?: string;
  allowAll?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = apps.find((app) => app.id === value) ?? null;

  const choose = (next: string) => {
    setOpen(false);
    onChange(next);
  };

  return (
    <Labelled id={`${name}-picker`} label={label} labelHidden={labelHidden}>
      <input type="hidden" name={name} value={value} />
      <Popover
        active={open}
        onClose={() => setOpen(false)}
        /* NOT `fullWidth`: that sizes the menu to the ACTIVATOR, which is right
           in a filter bar and wrong wherever the activator is a small inline
           button — the Discounts header one squeezed a long app name onto
           three lines and grew a horizontal scrollbar. The menu sizes to its
           content instead, with a floor below. */
        activator={
          <Button
            fullWidth
            textAlign="left"
            disclosure
            onClick={() => setOpen((current) => !current)}
          >
            {selected?.name ?? (allowAll ? allLabel : "Choose an app")}
          </Button>
        }
      >
        {/* A floor rather than a fixed width, so the menu still grows for a
            long app name but never collapses to the width of a tiny
            activator. */}
        <div style={{ minWidth: 240 }}>
        <ActionList
          actionRole="menuitem"
          items={[
            ...(allowAll
              ? [
                  {
                    content: allLabel,
                    active: value === "",
                    onAction: () => choose(""),
                  },
                ]
              : []),
            ...apps.map((app) => ({
              content: app.name,
              active: app.id === value,
              /* ActionList renders this as a CSS background, so it takes a
                 URL and not a component — hence a generated monogram rather
                 than the `Avatar` fallback used everywhere else. Always set,
                 because an item without an image does not reserve the space and
                 its label ends up shifted left of its neighbours'. */
              image: app.logoUrl ?? appMonogramDataUri(app.name),
              onAction: () => choose(app.id),
            })),
          ]}
        />
        </div>
      </Popover>
    </Labelled>
  );
}
