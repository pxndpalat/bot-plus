import type { RetentionPolicy } from "../settings/types.ts";

/** Settings required by retention jobs; it deliberately exposes no secrets or admin data. */
export interface RetentionSettingsPort {
  getRetentionPolicy(groupId: string): Promise<RetentionPolicy | null>;
}
