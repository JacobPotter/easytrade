import { validateRiskParams, type RiskLeaderboard, type RiskParams } from "../ui/app/risk/riskContract";

import { computeRiskLeaderboard } from "./risk/engine";

export type { RiskLeaderboard, RiskParams };

/** Upper bound on selected clusters; keeps the generated DQL filter small. */
const MAX_CLUSTERS = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Narrows the untyped function payload to RiskParams; throws with the first problem.
 * Exported for tests; pure, no I/O. Cluster uids are quoted later by clusterCondition, never interpolated raw.
 */
export function parseRiskParams(payload: unknown): RiskParams {
  if (!isRecord(payload) || Array.isArray(payload)) {
    throw new Error("Invalid payload: expected an object with clusters, lookbackHours and currentHours");
  }
  const { clusters, lookbackHours, currentHours } = payload;
  if (!Array.isArray(clusters) || !clusters.every((c): c is string => typeof c === "string")) {
    throw new Error("Invalid payload: 'clusters' must be an array of strings");
  }
  if (clusters.length > MAX_CLUSTERS) {
    throw new Error(`Invalid payload: 'clusters' must list at most ${MAX_CLUSTERS} clusters`);
  }
  if (!isFiniteNumber(lookbackHours) || !isFiniteNumber(currentHours)) {
    throw new Error("Invalid payload: 'lookbackHours' and 'currentHours' must be finite numbers");
  }
  const params: RiskParams = { clusters, lookbackHours, currentHours };
  const invalid = validateRiskParams(params);
  if (invalid) throw new Error(`Invalid payload: ${invalid}`);
  return params;
}

// dt-app requires the handler to be the default export of `api/<name>.function.ts`
// (exception to the repo's named-exports rule).
export default async function (payload: unknown): Promise<RiskLeaderboard> {
  return computeRiskLeaderboard(parseRiskParams(payload));
}
