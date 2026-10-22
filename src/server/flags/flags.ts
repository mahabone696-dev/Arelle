/**
 * Feature flags. Resolution order (first defined wins):
 *   1. per-organization override (FeatureFlagOverride)
 *   2. global DB flag (FeatureFlag)
 *   3. environment default (FEATURE_*)
 */
import { db } from "@/server/db";
import { FEATURE_FLAGS, resolveFlag, type FeatureFlagKey } from "./definitions";

export { FEATURE_FLAGS, resolveFlag, type FeatureFlagKey };

export async function isFeatureEnabled(key: FeatureFlagKey, organizationId?: string): Promise<boolean> {
  // Read the env default directly: flags are used by the worker, which doesn't carry web-only secrets.
  const raw = process.env[FEATURE_FLAGS[key].env];
  const envDefault = raw === "true" || raw === "1";
  const flag = await db.featureFlag.findUnique({
    where: { key },
    select: {
      isEnabled: true,
      overrides: organizationId ? { where: { organizationId }, select: { isEnabled: true } } : false,
    },
  });
  return resolveFlag(envDefault, flag?.isEnabled, flag?.overrides?.[0]?.isEnabled);
}
