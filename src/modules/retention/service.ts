import { createDataLifecycleService, type LifecycleRepository, type LifecycleService } from "../data-lifecycle/index.ts";
import type { RetentionSettingsPort } from "./settings-ports.ts";
import type { Clock } from "../../shared/index.ts";

export interface RetentionServiceOptions { readonly clock?: Clock; readonly settings?: RetentionSettingsPort; }

/** Retention is the scheduled facade; mutations remain in data-lifecycle. */
export function createRetentionService(repository: LifecycleRepository, options: RetentionServiceOptions = {}): LifecycleService {
  return createDataLifecycleService(repository, { clock: options.clock, policyProvider: options.settings });
}

