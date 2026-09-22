import React, { lazy, Suspense } from "react";

const LazyDialog = lazy(async () => {
  const { OverwriteConfirmDialog } = await import(
    "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirm"
  );
  const Dialog = () => (
    <OverwriteConfirmDialog>
      <OverwriteConfirmDialog.Actions.ExportToImage />
      <OverwriteConfirmDialog.Actions.SaveToDisk />
    </OverwriteConfirmDialog>
  );
  return { default: Dialog };
});

export const LazyOverwriteConfirmDialog = () => (
  <Suspense fallback={null}>
    <LazyDialog />
  </Suspense>
);
