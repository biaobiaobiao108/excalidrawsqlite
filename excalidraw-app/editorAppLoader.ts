type EditorAppModule = typeof import("./EditorApp");

export const createEditorAppLoader = (
  importEditorApp: () => Promise<EditorAppModule>,
) => {
  let loadPromise: Promise<EditorAppModule> | null = null;

  return () => {
    if (!loadPromise) {
      const pending = importEditorApp();
      let wrapped: Promise<EditorAppModule>;
      wrapped = pending.catch((error) => {
        if (loadPromise === wrapped) {
          loadPromise = null;
        }
        throw error;
      });
      loadPromise = wrapped;
    }
    return loadPromise;
  };
};

export const loadEditorApp = createEditorAppLoader(() => import("./EditorApp"));
