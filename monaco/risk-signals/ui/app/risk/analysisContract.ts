/**
 * Request/response contract of the `analyzeServiceRisk` app function (api/analyzeServiceRisk.function.ts).
 * Lives under ui/ because ui/tsconfig.json restricts rootDir to ui/; the function imports these types from here.
 * Keep this file free of imports so it type-checks in both the browser and the Dynatrace JS runtime.
 */

/** One leaderboard row. Nullable numbers mean "signal not available for this service" (e.g. no traces). */
export interface ServiceRiskPayload {
  service: string;
  /** Cluster label the service runs in; together with `service` it identifies the row */
  cluster: string;
  score: number;
  status: string;
  primaryDriver: string;
  trendLast2h: string;
  blastRadius: string;
  // anomalies and failure rates
  failRateNowPct: number | null;
  failZ: number | null;
  p95BaseMs: number | null;
  p95NowMs: number | null;
  p95Ratio: number | null;
  logErrBase: number;
  logErrNow: number;
  cpuPct: number | null;
  memGrowthPct: number | null;
  oomKills: number;
  hoursSinceChange: number | null;
  davis: string;
  // normalized 0–1 component scores and blast-radius multiplier
  sErr: number | null;
  sLat: number | null;
  sSat: number | null;
  sChg: number | null;
  sDavis: number | null;
  blastMult: number | null;
  coverage: string;
}

export interface ServiceRiskAnalysis {
  /** Davis AI answer, Markdown */
  analysis: string;
  status: "SUCCESSFUL" | "SUCCESSFUL_WITH_WARNINGS" | "FAILED";
}
