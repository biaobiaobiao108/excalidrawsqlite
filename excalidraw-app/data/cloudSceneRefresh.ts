type CloudSceneRefreshState = {
  sceneId: string | null;
  revision?: number;
  signature: string;
  hasPending: boolean;
};

/** Capture before fetching; recheck immediately before replacing the canvas. */
export const createCloudSceneRefreshGuard = (
  readState: () => CloudSceneRefreshState,
) => {
  const initial = readState();
  return () => {
    const current = readState();
    return (
      !initial.hasPending &&
      !current.hasPending &&
      initial.sceneId === current.sceneId &&
      initial.revision === current.revision &&
      initial.signature === current.signature
    );
  };
};
