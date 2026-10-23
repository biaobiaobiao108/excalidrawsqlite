const hashPart = (bytes: Uint8Array, seed: number) => {
  let hash = seed;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** The fingerprint is for repeatable migration requests, not authentication. */
export const getLocalSceneMigrationIdentity = (payload: {
  name: string;
  elements: readonly unknown[];
  appState: Record<string, unknown>;
}) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const fingerprint = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => hashPart(bytes, seed))
    .join("");

  return {
    id: `scene_legacy_${fingerprint}`,
    idempotencyKey: `local-scene-migration-v1-${fingerprint}`,
  };
};
