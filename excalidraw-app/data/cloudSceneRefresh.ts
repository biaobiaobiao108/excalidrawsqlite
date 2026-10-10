type CloudSceneRefreshState = {
  sceneId: string | null;
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
      initial.signature === current.signature
    );
  };
};
