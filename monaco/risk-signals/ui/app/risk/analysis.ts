import { functions } from "@dynatrace-sdk/app-utils";

import type { ServiceRiskAnalysis, ServiceRiskPayload } from "./analysisContract";
import type { RiskRow } from "./riskContract";

export type { ServiceRiskPayload };

/** Picks the scoring data the analyzeServiceRisk app function needs from a leaderboard row. */
export const toRiskPayload = (row: RiskRow, clusterLabel: string): ServiceRiskPayload => ({
  service: row.service,
  cluster: clusterLabel,
  score: row.score,
  status: row.status,
  primaryDriver: row.primaryDriver,
  trendLast2h: row.trendLast2h,
  blastRadius: row.blastRadius,
  failRateNowPct: row.failRateNowPct,
  failZ: row.failZ,
  p95BaseMs: row.p95BaseMs,
  p95NowMs: row.p95NowMs,
  p95Ratio: row.p95Ratio,
  logErrBase: row.logErrBase,
  logErrNow: row.logErrNow,
  cpuPct: row.cpuPct,
  memGrowthPct: row.memGrowthPct,
  oomKills: row.oomKills,
  hoursSinceChange: row.hoursSinceChange,
  davis: row.davis,
  sErr: row.sErr,
  sLat: row.sLat,
  sSat: row.sSat,
  sChg: row.sChg,
  sDavis: row.sDavis,
  blastMult: row.blastMult,
  coverage: row.coverage,
});

const isAnalysis = (v: unknown): v is ServiceRiskAnalysis =>
  typeof v === "object" && v !== null && typeof (v as { analysis?: unknown }).analysis === "string";

/** Calls the analyzeServiceRisk app function and returns Davis AI's Markdown answer. */
export async function analyzeServiceRisk(payload: ServiceRiskPayload, signal?: AbortSignal): Promise<string> {
  const response = await functions.call("analyzeServiceRisk", { data: payload, abortSignal: signal });
  if (!response.ok) {
    throw new Error(`analyzeServiceRisk failed with HTTP ${response.status}`, { cause: response });
  }
  const body: unknown = await response.json();
  if (!isAnalysis(body)) throw new Error("analyzeServiceRisk returned an unexpected response body");
  return body.analysis;
}
