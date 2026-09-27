import { Autocomplete, Icon } from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { useMemo, useState } from "react";

/**
 * A Select you can type into. For lists too long to scroll — an organization
 * with a few hundred discount codes — where a plain Select means hunting.
 *
 * Matches anywhere in the label, case-insensitively, so "20" finds every
 * 20%-off code and "vip" finds VIP9 and VIP33. The field shows the chosen
 * option's label until the operator starts typing.
 */
export function SearchableSelect({
  label,
  options,
  value,
  onChange,
  helpText,
  placeholder = "Search…",
}: {
  label: string;
  options: Array<{ label: string; value: string; disabled?: boolean }>;
  value: string;
  onChange: (value: string) => void;
  helpText?: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? "";

  const visible = useMemo(() => {
    const needle = (query ?? "").trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle));
  }, [options, query]);

  return (
    <Autocomplete
      options={visible}
      selected={value ? [value] : [""]}
      onSelect={(selected) => {
        const next = selected[0] ?? "";
        onChange(next);
        setQuery(null); // show the chosen label again
      }}
      emptyState={<div style={{ padding: "var(--p-space-300)" }}>No match for “{query}”.</div>}
      textField={
        <Autocomplete.TextField
          label={label}
          value={query ?? selectedLabel}
          onChange={setQuery}
          onFocus={() => setQuery("")}
          onBlur={() => setQuery(null)}
          prefix={<Icon source={SearchIcon} tone="subdued" />}
          placeholder={placeholder}
          helpText={helpText}
          autoComplete="off"
        />
      }
    />
  );
}
