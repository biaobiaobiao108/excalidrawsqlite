import { Tabs as RadixTabs } from "radix-ui";

export const TTDDialogTabTrigger = ({
  children,
  tab,
  ...rest
}: {
  children: React.ReactNode;
  tab: string;
} & Omit<
  React.ComponentPropsWithoutRef<typeof RadixTabs.Trigger>,
  "value"
>) => {
  return (
    <RadixTabs.Trigger value={tab} className="ttd-dialog-tab-trigger" {...rest}>
      {children}
    </RadixTabs.Trigger>
  );
};
TTDDialogTabTrigger.displayName = "TTDDialogTabTrigger";
