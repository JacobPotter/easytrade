/**
 * Request/response contract of the `computeRiskLeaderboard` app function (api/computeRiskLeaderboard.function.ts),
 * plus the risk model config both sides read. The engine itself lives in api/risk/engine.ts and cannot be imported
 * from ui/ (ui/tsconfig.json restricts rootDir to ui/), so the scoring code never ships in the browser bundle.
 * Keep this file free of imports so it type-checks in both the browser and the Dynatrace JS runtime.
 */

/** db.system value on client spans -> workload that serves it */
const DB_WORKLOADS: Readonly<Record<string, string | undefined>> = { mssql: "easytrade-db" };

export const RISK_CONFIG = {
  namespace: "easytrade",
  lookbackHours: 24, // default baseline window (baseline + current)
  currentHours: 2, // default compare window: most recent slice compared against the rest
  maxLookbackHours: 48, // largest window preset ("Slow regression"); caps the Grail scan of a direct function call
  bucketMinutes: 15,
  traceWindowMinutes: 30, // trace share + service-ID mapping
  oomHistoryDays: 7, // across all clusters (workload names carry over)
  weights: { sat: 0.2, err: 0.25, lat: 0.2, chg: 0.15, davis: 0.2 },
  changeDecayHours: 6,
  infraProblemWeight: 0.25, // active problem on the host/cluster a service runs on
  exclude: ["easytrade-loadgen"],
  entrypoints: ["easytrade-frontendreverseproxy"],
  dbWorkloads: DB_WORKLOADS,
  // Calls Dynatrace cannot trace (verified in src/): async queue + untraced Go caller
  extraEdges: [
    ["easytrade-aggregator-service", "easytrade-offerservice"],
    ["easytrade-pricing-service", "easytrade-rabbitmq"],
    ["easytrade-rabbitmq", "easytrade-calculationservice"],
  ],
} as const satisfies {
  exclude: readonly string[];
  entrypoints: readonly string[];
  extraEdges: readonly (readonly [string, string])[];
  [k: string]: unknown;
};

/** User-selectable scope of a scoring run. This is the request body of `computeRiskLeaderboard`. */
export interface RiskParams {
  /** k8s.cluster.uid values to score; empty = every cluster with data in the window */
  clusters: readonly string[];
  /** Baseline window in hours, including the compare window (default 24) */
  lookbackHours: number;
  /** Compare window in hours: the most recent slice scored against the baseline (default 2) */
  currentHours: number;
}

export const DEFAULT_RISK_PARAMS: RiskParams = {
  clusters: [],
  lookbackHours: RISK_CONFIG.lookbackHours,
  currentHours: RISK_CONFIG.currentHours,
};

/** DQL condition selecting the given clusters; empty = any cluster. Uids are quoted, never interpolated raw. */
export function clusterCondition(clusters: readonly string[]): string {
  return clusters.length
    ? `in(k8s.cluster.uid, array(${clusters.map((c) => JSON.stringify(c)).join(", ")}))`
    : "isNotNull(k8s.cluster.uid)";
}

/**
 * Validates the windows: whole 15-min buckets, compare at least 1h (trend needs ≥ 4 points) and ≤ half the
 * baseline, baseline at most `maxLookbackHours`. Returns the first problem, or null if the params are valid.
 */
export function validateRiskParams(p: RiskParams): string | null {
  const bucketH = RISK_CONFIG.bucketMinutes / 60;
  if (!Number.isFinite(p.lookbackHours) || !Number.isFinite(p.currentHours)) return "Windows must be numbers.";
  if (p.currentHours < 1) return "Compare window must be at least 1h.";
  if (p.currentHours * 2 > p.lookbackHours) return "Compare window must be at most half the baseline window.";
  if (p.lookbackHours > RISK_CONFIG.maxLookbackHours) {
    return `Baseline window must be at most ${RISK_CONFIG.maxLookbackHours}h.`;
  }
  if ((p.lookbackHours / bucketH) % 1 || (p.currentHours / bucketH) % 1) {
    return `Windows must be whole multiples of ${RISK_CONFIG.bucketMinutes} min.`;
  }
  return null;
}

export type SignalKey = keyof typeof RISK_CONFIG.weights;

/** How a dependency edge between two workloads was discovered. */
export type EdgeSource = "traced call" | "database" | "untraced (configured)";

export interface RiskDependency {
  service: string;
  via: EdgeSource;
}

export interface RiskDavisMatch {
  displayId: string;
  name: string;
  status: string;
  /** "service": the problem affects one of the service's own entities; "infrastructure": its host or cluster */
  match: "service" | "infrastructure";
  /** Davis signal (0–1) this problem contributes; the strongest one wins */
  weight: number;
}

/**
 * Everything the score was computed from, for the Risk Breakdown view. Output only: it is
 * collected while scoring and never feeds back into the score.
 */
export interface RiskBreakdown {
  /** Per signal: weight, normalized signal 0–1 and weighted points (100·weight·signal) before the multiplier */
  components: { key: SignalKey; label: string; weight: number; signal: number; points: number }[];
  /** Sum of `components[].points` */
  basePoints: number;
  /** Blast-radius multiplier, 1 + 0.5·blast */
  multiplier: number;
  /** base × multiplier exceeded 100 and was capped */
  capped: boolean;
  errors: {
    reqBase: number;
    reqNow: number;
    failRateBasePct: number;
    failRateNowPct: number;
    z: number;
    /** Request-failure part of the error signal (z-score and absolute level), 0–1 */
    reqSignal: number;
    logBase: number;
    logNow: number;
    /** Error log lines expected in the compare window at the baseline rate (Poisson λ) */
    logExpected: number;
    zLog: number;
  };
  latency: {
    p95BaseMs: number | null;
    p95NowMs: number | null;
    ratio: number | null;
    trendWindow: string;
    trendNow: string;
  };
  saturation: {
    cpuPct: number;
    /** CPU min-max normalized across the cluster's services, 0–1 */
    cpuNorm: number;
    memGrowthPct: number;
    /** Memory growth min-max normalized across the cluster's services, 0–1 */
    memNorm: number;
    oomKills: number;
    hosts: string[];
  };
  change: {
    hoursAgo: number;
    source: "deployment" | "feature flag" | "config/deploy event" | "none in window";
  };
  davis: RiskDavisMatch[];
  blast: {
    /** Blast radius 0–1 */
    value: number;
    tier: string;
    isEntrypoint: boolean;
    /** Transitive callers of this service, and the largest count in the cluster */
    dependents: number;
    maxDependents: number;
    traceSharePct: number;
    maxTraceSharePct: number;
    /** Direct upstream services */
    callers: RiskDependency[];
    /** Direct downstream dependencies */
    callees: RiskDependency[];
    /** Every service that (transitively) calls this one */
    transitiveDependents: string[];
  };
}

/** One scored (cluster, service). The leaderboard columns are status, service, cluster, score, driver, trend, blast. */
export interface RiskRow {
  rank: number;
  score: number;
  service: string;
  /**
   * Dynatrace service entity (SERVICE-…) with the most spans in the trace window; null when the workload is untraced.
   * Output only, used to link the row to the service.
   */
  serviceId: string | null;
  /** k8s.cluster.uid the service runs in */
  cluster: string;
  status: string;
  primaryDriver: string;
  trendLast2h: string;
  trendWindow: string;
  blastRadius: string;
  p95BaseMs: number | null;
  p95NowMs: number | null;
  p95Ratio: number | null;
  failRateNowPct: number | null;
  failZ: number | null;
  logErrBase: number;
  logErrNow: number;
  cpuPct: number | null;
  memGrowthPct: number | null;
  oomKills: number;
  hoursSinceChange: number | null;
  davis: string;
  sSat: number | null;
  sErr: number | null;
  sLat: number | null;
  sChg: number | null;
  sDavis: number | null;
  blastMult: number | null;
  coverage: string;
  breakdown: RiskBreakdown;
}

/** Response body of `computeRiskLeaderboard`. */
export interface RiskLeaderboard {
  rows: RiskRow[];
  /** k8s.cluster.uid values that had data and were scored */
  clusters: string[];
  /** Parameters this result was computed with */
  params: RiskParams;
  /** Human-readable scoring window */
  window: string;
  /** End of the scoring window (aligned to the bucket boundary), ISO 8601; a string because it crosses JSON */
  computedAt: string;
}
