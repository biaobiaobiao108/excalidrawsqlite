export type DeviceMemoryTier = "low" | "unknown" | "standard";

const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod|Mobile/i;

/**
 * Classifies only what the browser reliably exposes. Safari and Firefox may
 * omit `navigator.deviceMemory`, so callers should give that unknown tier a
 * bounded middle budget instead of assuming a high-memory device.
 */
export const getDeviceMemoryTier = (
  deviceMemory?: number,
  userAgent = "",
): DeviceMemoryTier => {
  if (
    MOBILE_USER_AGENT.test(userAgent) ||
    (typeof deviceMemory === "number" && deviceMemory <= 4)
  ) {
    return "low";
  }

  if (typeof deviceMemory === "number" && Number.isFinite(deviceMemory)) {
    return "standard";
  }

  return "unknown";
};
