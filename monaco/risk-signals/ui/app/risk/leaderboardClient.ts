import { functions } from "@dynatrace-sdk/app-utils";

import type { RiskLeaderboard, RiskParams } from "./riskContract";

/** Shallow shape check of the function response; the function builds it from the typed contract. */
const isLeaderboard = (v: unknown): v is RiskLeaderboard => {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Partial<Record<keyof RiskLeaderboard, unknown>>;
  return Array.isArray(b.rows) && Array.isArray(b.clusters) && typeof b.computedAt === "string";
};

/**
 * Calls the computeRiskLeaderboard app function, which runs every signal query and the scoring on AppEngine.
 * Aborting cancels the HTTP call; queries the function already started still run to completion server-side.
 */
export async function fetchRiskLeaderboard(params: RiskParams, signal?: AbortSignal): Promise<RiskLeaderboard> {
  const response = await functions.call("computeRiskLeaderboard", { data: params, abortSignal: signal });
  if (!response.ok) {
    // The body carries the function's error (invalid params, failed DQL), so surface it to the user.
    const text = await response.text().catch(() => "");
    throw new Error(`computeRiskLeaderboard failed with HTTP ${response.status}: ${text}`, { cause: response });
  }
  const body: unknown = await response.json();
  if (!isLeaderboard(body)) throw new Error("computeRiskLeaderboard returned an unexpected response body");
  return body;
}
