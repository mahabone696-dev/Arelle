/**
 * Feature flags. Resolution order (first defined wins):
 *   1. per-organization override (FeatureFlagOverride)
 *   2. global DB flag (FeatureFlag)
 *   3. environment default (FEATURE_*)
 */
import { db } from "@/server/db";
import { getEnv } from "@/server/env";
import { FEATURE_FLAGS, resolveFlag, type FeatureFlagKey } from "./definitions";

export { FEATURE_FLAGS, resolveFlag, type FeatureFlagKey };

export async function isFeatureEnabled(key: FeatureFlagKey, organizationId?: string): Promise<boolean> {
  const envDefault = getEnv()[FEATURE_FLAGS[key].env];
  const flag = await db.featureFlag.findUnique({
    where: { key },
    select: {
      isEnabled: true,
      overrides: organizationId ? { where: { organizationId }, select: { isEnabled: true } } : false,
    },
  });
  return resolveFlag(envDefault, flag?.isEnabled, flag?.overrides?.[0]?.isEnabled);
}
