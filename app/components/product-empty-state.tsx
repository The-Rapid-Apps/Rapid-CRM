import { BlockStack, Button, Icon, InlineStack, Text } from "@shopify/polaris";
import type { ComponentProps } from "react";

type EmptyStateAction = {
  content: string;
  url?: string;
  onAction?: () => void;
};

type ProductEmptyStateProps = {
  title: string;
  description: string;
  icon: ComponentProps<typeof Icon>["source"];
  action?: EmptyStateAction;
  /** An escape route beside the primary call to action — for empty states you
   * can reach by filtering, where the useful next step may be to widen the
   * filter rather than create something. */
  secondaryAction?: EmptyStateAction;
};

export function ProductEmptyState({
  title,
  description,
  icon,
  action,
  secondaryAction,
}: ProductEmptyStateProps) {
  return (
    <div className="product-empty-state">
      <BlockStack gap="300" inlineAlign="center">
        <div className="product-empty-state__icon" aria-hidden="true">
          <Icon source={icon} tone="subdued" />
        </div>
        <BlockStack gap="100" inlineAlign="center">
          <Text as="h3" variant="headingMd" alignment="center">
            {title}
          </Text>
          <Text as="p" tone="subdued" alignment="center">
            {description}
          </Text>
        </BlockStack>
        {action || secondaryAction ? (
          <InlineStack align="center" gap="200">
            {action ? (
              <Button
                variant="primary"
                url={action.url}
                onClick={action.onAction}
              >
                {action.content}
              </Button>
            ) : null}
            {secondaryAction ? (
              <Button
                url={secondaryAction.url}
                onClick={secondaryAction.onAction}
              >
                {secondaryAction.content}
              </Button>
            ) : null}
          </InlineStack>
        ) : null}
      </BlockStack>
    </div>
  );
}
