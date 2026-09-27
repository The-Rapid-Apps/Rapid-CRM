import { Tooltip } from "@shopify/polaris";
import { InfoIcon } from "@shopify/polaris-icons";

/**
 * An info icon that explains something on hover or focus. It can take the
 * place of page subtitles, passed as a Page's `titleMetadata`, so the
 * explanation stays one hover away without a line of copy under every title.
 */
export function InfoTooltip({ content }: { content: string }) {
  return (
    <Tooltip content={content}>
      <span
        role="img"
        aria-label={content}
        tabIndex={0}
        style={{ display: "inline-flex", verticalAlign: "middle", cursor: "help" }}
      >
        <InfoIcon width={16} height={16} fill="currentColor" />
      </span>
    </Tooltip>
  );
}
