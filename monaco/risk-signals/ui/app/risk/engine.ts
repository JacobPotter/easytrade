/**
 * EasyTrade Service Risk Signal Matrix: TypeScript port of the dashboard Code tile
 * monaco/dashboards/risk-leaderboard-tile.js (non-business-aware model).
 *
 * The scoring logic is duplicated there: any change to weights, signals or classification
 * must be applied to BOTH files. App-only differences (intentional, 2026-11-03):
 *   - the cluster scope and the baseline/compare windows are parameters (RiskParams), not auto-detected/fixed;
 *   - every query is grouped by k8s.cluster.uid and each cluster is scored independently, so the app can
 *     show one row per (cluster, service). Scoring one cluster gives the same numbers as the tile does;
 *   - each row also carries a `breakdown` (inputs and intermediate values for the Risk Breakdown view).
 *     It is output only and does not affect the score, so the tile does not need it.
 * Expected Grail scan per run: about 0.8 GB for one cluster at 24h; scales with window length.
 */
import { numArr, numField, runDql, str, strArr, type ResultRecord } from "./dql";
import { avg, median, minMax, nonNull, round, sum, trend, type Trend } from "./stats";

/** db.system value on client spans -> workload that serves it */
const DB_WORKLOADS: Readonly<Record<string, string | undefined>> = { mssql: "easytrade-db" };

export const RISK_CONFIG = {
  namespace: "easytrade",
  lookbackHours: 24, // default baseline window (baseline + current)
  currentHours: 2, // default compare window: most recent slice compared against the rest
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

/** User-selectable scope of a scoring run. */
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

export interface RiskLeaderboard {
  rows: RiskRow[];
  /** k8s.cluster.uid values that had data and were scored */
  clusters: string[];
  /** Parameters this result was computed with */
  params: RiskParams;
  /** Human-readable scoring window */
  window: string;
  /** End of the scoring window (aligned to the bucket boundary) */
  computedAt: Date;
}

interface ProcAgg {
  cpuCur: number;
  memGrowth: number;
  firstIdx: number;
  hosts: Set<string>;
}

interface Signals {
  traced: boolean;
  nb: number;
  nc: number;
  p0: number;
  pc: number;
  z: number;
  errReq: number;
  le: { base: number; cur: number };
  lambda: number;
  zLog: number;
  err: number;
  p95Base: number | null;
  p95Cur: number | null;
  latRatio: number | null;
  lat: number;
  cpu: number;
  memGrowth: number;
  hosts: string[];
  ooms: number;
  changeHrs: number;
  changeSource: RiskBreakdown["change"]["source"];
  chg: number;
  davis: number;
  davisIds: string[];
  davisMatches: RiskDavisMatch[];
  share: number;
  blast: number;
  sat: number;
  cpuNorm: number;
  memNorm: number;
  full: Trend;
  cur: Trend;
}

/** Query results restricted to one cluster. */
interface ClusterData {
  pods: ResultRecord[];
  red: ResultRecord[];
  logErr: ResultRecord[];
  proc: ResultRecord[];
  svcMap: ResultRecord[];
  traceRows: ResultRecord[];
  traceTotal: ResultRecord[];
  dbCalls: ResultRecord[];
  changeEvents: ResultRecord[];
  clusterEntity: ResultRecord[];
}

/** Results that are not split by cluster. */
interface SharedData {
  edges: ResultRecord[];
  ooms: ResultRecord[];
  problems: ResultRecord[];
  flagToggles: ResultRecord[];
}

interface Window {
  end: Date;
  split: Date;
  nBuckets: number;
  splitIdx: number;
  lookbackHours: number;
  currentHours: number;
}

const WL = "k8s.workload.name";
const CL = "k8s.cluster.uid";

/** Validates the windows: whole 15-min buckets, compare at least 1h (trend needs ≥ 4 points) and ≤ half the baseline. */
export function validateRiskParams(p: RiskParams): string | null {
  const bucketH = RISK_CONFIG.bucketMinutes / 60;
  if (!Number.isFinite(p.lookbackHours) || !Number.isFinite(p.currentHours)) return "Windows must be numbers.";
  if (p.currentHours < 1) return "Compare window must be at least 1h.";
  if (p.currentHours * 2 > p.lookbackHours) return "Compare window must be at most half the baseline window.";
  if ((p.lookbackHours / bucketH) % 1 || (p.currentHours / bucketH) % 1) {
    return `Windows must be whole multiples of ${RISK_CONFIG.bucketMinutes} min.`;
  }
  return null;
}

export async function computeRiskLeaderboard(
  params: RiskParams = DEFAULT_RISK_PARAMS,
  abortSignal?: AbortSignal,
): Promise<RiskLeaderboard> {
  const invalid = validateRiskParams(params);
  if (invalid) throw new Error(invalid);

  const CONFIG = RISK_CONFIG;
  const dql = (q: string) => runDql(q, abortSignal);

  const B = CONFIG.bucketMinutes;
  const { lookbackHours, currentHours } = params;
  const end = new Date(Math.floor(Date.now() / (B * 60000)) * B * 60000);
  const start = new Date(end.getTime() - lookbackHours * 3600000);
  const split = new Date(end.getTime() - currentHours * 3600000);
  const nBuckets = (lookbackHours * 60) / B;
  const splitIdx = nBuckets - (currentHours * 60) / B;
  const win = `from:"${start.toISOString()}", to:"${end.toISOString()}"`;
  const ns = CONFIG.namespace;
  const tw = `from: now()-${CONFIG.traceWindowMinutes}m`;
  const inScope = clusterCondition(params.clusters);

  // 1. All signal queries in parallel, grouped by cluster where the data has one
  const [
    podsSmartscape, podsLogs, red, logErr, proc, svcMap, traceRows, traceTotal,
    edges, dbCalls, ooms, problems, flagToggles, changeEvents, clusterEntity,
  ] = await Promise.all([
    dql(`smartscapeNodes "K8S_POD" | filter ${inScope} and k8s.namespace.name == "${ns}" | fields k8s.cluster.uid, k8s.pod.uid, k8s.workload.name`),
    dql(`fetch logs, ${tw} | filter k8s.namespace.name == "${ns}" and ${inScope} | summarize n = count(), by:{k8s.cluster.uid, k8s.pod.uid, k8s.workload.name}`),
    dql(`timeseries {req = sum(dt.service.request.count), fail = sum(dt.service.request.failure_count), ` +
      `p95 = percentile(dt.service.request.response_time, 95)}, by:{k8s.cluster.uid, k8s.workload.name}, ` +
      `filter: ${inScope}, interval:${B}m, ${win}`),
    dql(`fetch logs, ${win} | filter k8s.namespace.name == "${ns}" and ${inScope} ` +
      `and in(loglevel, array("ERROR", "SEVERE", "FATAL")) ` +
      `| summarize base = countIf(timestamp < toTimestamp("${split.toISOString()}")), ` +
      `cur = countIf(timestamp >= toTimestamp("${split.toISOString()}")), by:{k8s.cluster.uid, k8s.workload.name}`),
    dql(`timeseries {cpu = avg(dt.process.cpu.usage), mem = avg(dt.process.memory.working_set_size)}, ` +
      `by:{k8s.cluster.uid, k8s.pod.uid, dt.smartscape.host}, filter: k8s.namespace.name == "${ns}" and ${inScope}, interval:${B}m, ${win}`),
    dql(`fetch spans, ${tw} | filter ${inScope} | summarize n = count(), by:{k8s.cluster.uid, dt.smartscape.service, k8s.workload.name}`),
    dql(`fetch spans, ${tw} | filter ${inScope} | summarize traces = countDistinct(trace.id), by:{k8s.cluster.uid, k8s.workload.name}`),
    dql(`fetch spans, ${tw} | filter ${inScope} | summarize traces = countDistinct(trace.id), by:{k8s.cluster.uid}`),
    dql(`smartscapeEdges "calls" | filter source_type == "SERVICE" and target_type == "SERVICE" | fields source_id, target_id`),
    dql(`fetch spans, ${tw} | filter ${inScope} and isNotNull(db.system) | summarize calls = count(), by:{k8s.cluster.uid, k8s.workload.name, db.system}`),
    dql(`timeseries oom = sum(dt.kubernetes.container.oom_kills), by:{k8s.workload.name}, ` +
      `filter: k8s.namespace.name == "${ns}", from: now()-${CONFIG.oomHistoryDays}d | fieldsAdd total = arraySum(oom) | fields k8s.workload.name, total`),
    dql(`fetch dt.davis.problems, ${win} | sort timestamp desc | dedup event.id ` +
      `| fields display_id, event.name, event.status, event.start, event.end, affected_entity_ids, root_cause_entity_id`),
    dql(`fetch bizevents, ${win} | filter event.type == "com.easytrade.flag-toggle" | summarize n = count(), last = max(timestamp)`),
    dql(`fetch events, ${win} | filter in(event.type, array("CUSTOM_DEPLOYMENT", "CUSTOM_CONFIGURATION")) ` +
      `| summarize last = max(timestamp), by:{k8s.cluster.uid, k8s.workload.name, dt.smartscape.service}`),
    dql(`timeseries x = sum(dt.service.request.count), by:{k8s.cluster.uid, dt.entity.kubernetes_cluster}, filter: ${inScope}, from: now()-30m ` +
      `| fields k8s.cluster.uid, dt.entity.kubernetes_cluster`),
  ]);

  // 2. Partition by cluster. Change events without a cluster apply to every cluster.
  const groups = new Map<string, ClusterData>();
  const groupOf = (uid: string): ClusterData => {
    let g = groups.get(uid);
    if (!g) {
      g = { pods: [], red: [], logErr: [], proc: [], svcMap: [], traceRows: [], traceTotal: [], dbCalls: [], changeEvents: [], clusterEntity: [] };
      groups.set(uid, g);
    }
    return g;
  };
  const scored = new Set<string>(); // clusters with service, log or process data in the window
  const assign = (rows: ResultRecord[], key: keyof ClusterData, marksData = false) => {
    for (const r of rows) {
      const uid = str(r, CL);
      if (!uid) continue;
      groupOf(uid)[key].push(r);
      if (marksData) scored.add(uid);
    }
  };
  assign([...podsSmartscape, ...podsLogs], "pods", true);
  assign(red, "red", true);
  assign(logErr, "logErr");
  assign(proc, "proc", true);
  assign(svcMap, "svcMap");
  assign(traceRows, "traceRows");
  assign(traceTotal, "traceTotal");
  assign(dbCalls, "dbCalls");
  assign(changeEvents, "changeEvents");
  assign(clusterEntity, "clusterEntity");
  const unscopedChanges = changeEvents.filter((r) => !str(r, CL));

  const shared: SharedData = { edges, ooms, problems, flagToggles };
  const w: Window = { end, split, nBuckets, splitIdx, lookbackHours, currentHours };
  // The DQL filter already limits results to the selection; enforce it here too.
  const selected = new Set(params.clusters);
  const clusters = [...scored].filter((uid) => !selected.size || selected.has(uid)).sort();
  const rows = clusters.flatMap((uid) => {
    const g = groupOf(uid);
    return scoreCluster(uid, { ...g, changeEvents: [...g.changeEvents, ...unscopedChanges] }, shared, w);
  });

  const ranked = rows.sort((a, b) => b.score - a.score).map((r, i) => ({ rank: i + 1, ...r }));
  const fmtTime = (d: Date) => (lookbackHours > 24 ? d.toISOString().slice(5, 16).replace("T", " ") : d.toISOString().slice(11, 16));
  return {
    rows: ranked,
    clusters,
    params,
    window: `${fmtTime(start)}–${fmtTime(end)} UTC (now = last ${currentHours}h)`,
    computedAt: end,
  };
}

/** Scores the services of one cluster. Same logic as the dashboard tile, which scores a single cluster. */
function scoreCluster(uid: string, d: ClusterData, shared: SharedData, w: Window): Omit<RiskRow, "rank">[] {
  const CONFIG = RISK_CONFIG;
  const B = CONFIG.bucketMinutes;
  const ns = CONFIG.namespace;
  const { end, split, nBuckets, splitIdx, lookbackHours, currentHours } = w;
  const excluded = (wl: string) => (CONFIG.exclude as readonly string[]).includes(wl);

  // Mappings: pod -> workload, service ID -> workload
  const podToWl = new Map<string, string>();
  for (const r of d.pods) {
    const pod = str(r, "k8s.pod.uid");
    const wl = str(r, WL);
    if (pod && wl) podToWl.set(pod, wl);
  }
  const svcToWl = new Map<string, string>();
  const wlSvcIds = new Map<string, Set<string>>();
  for (const r of d.svcMap) {
    const id = str(r, "dt.smartscape.service");
    const wl = str(r, WL);
    if (!id || !wl) continue;
    svcToWl.set(id, wl);
    const ids = wlSvcIds.get(wl) ?? new Set<string>();
    ids.add(id);
    wlSvcIds.set(wl, ids);
  }

  const workloads = new Set([...podToWl.values()].filter((wl) => !excluded(wl)));
  for (const r of d.red) {
    const wl = str(r, WL);
    if (wl && !excluded(wl)) workloads.add(wl);
  }
  const W = [...workloads].sort();

  // Per-workload raw signals
  const redBy = new Map<string, ResultRecord>();
  for (const r of d.red) {
    const wl = str(r, WL);
    if (wl) redBy.set(wl, r);
  }
  const logBy = new Map<string, { base: number; cur: number }>();
  for (const r of d.logErr) {
    const wl = str(r, WL);
    if (wl) logBy.set(wl, { base: numField(r, "base") ?? 0, cur: numField(r, "cur") ?? 0 });
  }
  const oomBy = new Map<string, number>();
  for (const r of shared.ooms) {
    const wl = str(r, WL);
    if (wl) oomBy.set(wl, numField(r, "total") || 0);
  }
  const tracesBy = new Map<string, number>();
  for (const r of d.traceRows) {
    const wl = str(r, WL);
    if (wl) tracesBy.set(wl, numField(r, "traces") ?? 0);
  }
  const totalTraces = (d.traceTotal[0] ? numField(d.traceTotal[0], "traces") : null) || 1;
  const clusterIds = new Set(
    d.clusterEntity.map((r) => str(r, "dt.entity.kubernetes_cluster")).filter((v): v is string => !!v),
  );

  const procBy = new Map<string, ProcAgg>();
  for (const r of d.proc) {
    const pod = str(r, "k8s.pod.uid");
    const wl = pod ? podToWl.get(pod) : undefined;
    if (!wl || !workloads.has(wl)) continue;
    const cpu = numArr(r, "cpu");
    const memVals = nonNull(numArr(r, "mem"));
    const firstIdx = cpu.findIndex((v) => v !== null);
    const memFirst = median(memVals.slice(0, 3)) ?? 0;
    const memLast = median(memVals.slice(-3)) ?? 0;
    const growth = memVals.length >= 6 ? ((memLast - memFirst) / memFirst) * 100 : 0;
    const prev = procBy.get(wl) ?? { cpuCur: 0, memGrowth: -Infinity, firstIdx: -1, hosts: new Set<string>() };
    prev.cpuCur += avg(cpu.slice(splitIdx)) || 0;
    prev.memGrowth = Math.max(prev.memGrowth, growth);
    prev.firstIdx = Math.max(prev.firstIdx, firstIdx); // newest pod = latest deploy
    const host = str(r, "dt.smartscape.host");
    if (host) prev.hosts.add(host);
    procBy.set(wl, prev);
  }

  // Change recency: newest pod start (first bucket with data), config events, flag toggles
  const hoursAgo = (iso: string) => (end.getTime() - new Date(iso).getTime()) / 3600000;
  const flag = shared.flagToggles[0];
  const flagLast = flag ? str(flag, "last") : undefined;
  const flagHrs = flag && (numField(flag, "n") ?? 0) > 0 && flagLast ? hoursAgo(flagLast) : Infinity;
  const evtHrs = new Map<string, number>();
  for (const r of d.changeEvents) {
    const svc = str(r, "dt.smartscape.service");
    const wl = str(r, WL) ?? (svc ? svcToWl.get(svc) : undefined);
    const last = str(r, "last");
    if (wl && last) evtHrs.set(wl, Math.min(evtHrs.get(wl) ?? Infinity, hoursAgo(last)));
  }

  // Topology and blast radius (within this cluster)
  // adj: caller -> callee -> how the edge was found (first source wins, in the order added below)
  const adj = new Map(W.map((wl) => [wl, new Map<string, EdgeSource>()]));
  const addEdge = (a: string | undefined, b: string | undefined, via: EdgeSource) => {
    if (a && b && a !== b && adj.has(a) && adj.has(b) && !adj.get(a)?.has(b)) adj.get(a)?.set(b, via);
  };
  for (const e of shared.edges) {
    const src = str(e, "source_id");
    const tgt = str(e, "target_id");
    addEdge(src ? svcToWl.get(src) : undefined, tgt ? svcToWl.get(tgt) : undefined, "traced call");
  }
  for (const r of d.dbCalls) {
    const sys = str(r, "db.system");
    addEdge(str(r, WL), sys ? CONFIG.dbWorkloads[sys] : undefined, "database");
  }
  for (const [a, b] of CONFIG.extraEdges) addEdge(a, b, "untraced (configured)");
  const callers = new Map(W.map((wl) => [wl, new Set<string>()]));
  for (const [a, outs] of adj) for (const b of outs.keys()) callers.get(b)?.add(a);
  const dependents = (wl: string) => {
    const seen = new Set<string>();
    const stack = [wl];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const p of callers.get(cur) ?? []) {
        if (p !== wl && !seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return seen;
  };
  const depSets = new Map(W.map((wl) => [wl, dependents(wl)]));
  const deps = new Map(W.map((wl) => [wl, depSets.get(wl)?.size ?? 0]));
  const maxDeps = Math.max(1, ...deps.values());
  const maxShare = Math.max(1e-9, ...W.map((wl) => (tracesBy.get(wl) ?? 0) / totalTraces));

  // Signals
  const sig = new Map<string, Signals>();
  for (const wl of W) {
    const r = redBy.get(wl);
    const req = r ? numArr(r, "req") : [];
    const fail = r ? numArr(r, "fail") : [];
    const p95 = r ? numArr(r, "p95").map((v) => (v === null ? null : v / 1000)) : [];

    // Errors: request failure z-score + absolute level, plus log-error rate change (Poisson)
    const nb = sum(req.slice(0, splitIdx));
    const fb = sum(fail.slice(0, splitIdx));
    const nc = sum(req.slice(splitIdx));
    const fc = sum(fail.slice(splitIdx));
    const p0 = Math.max(nb ? fb / nb : 0, 1e-4);
    const pc = nc ? fc / nc : 0;
    const z = nc ? (pc - p0) / Math.sqrt((p0 * (1 - p0)) / nc) : 0;
    const errReq = nc ? 0.5 * Math.min(1, Math.max(0, z) / 3) + 0.5 * Math.min(1, pc / 0.01) : 0;
    const le = logBy.get(wl) ?? { base: 0, cur: 0 };
    const lambda = Math.max(0.5, (le.base * currentHours) / (lookbackHours - currentHours));
    const zLog = (le.cur - lambda) / Math.sqrt(lambda);
    const err = 0.7 * errReq + 0.3 * Math.min(1, Math.max(0, zLog) / 3);

    // Latency: median p95 now vs baseline; 2x = full signal
    const p95Base = median(p95.slice(0, splitIdx));
    const p95Cur = median(p95.slice(splitIdx));
    const latRatio = p95Base && p95Cur ? p95Cur / p95Base : null;
    const lat = latRatio ? Math.min(1, Math.max(0, Math.log(latRatio)) / Math.LN2) : 0;

    // Change recency
    const pr = procBy.get(wl);
    const deployHrs = pr && pr.firstIdx > 0 ? (nBuckets - pr.firstIdx) * (B / 60) : lookbackHours;
    const wlEvtHrs = evtHrs.get(wl) ?? Infinity;
    const changeHrs = Math.min(deployHrs, flagHrs, wlEvtHrs);
    const chg = Math.exp(-changeHrs / CONFIG.changeDecayHours);
    // Which input won the Math.min above; a pod that predates the window counts as "no change"
    const changeSource: RiskBreakdown["change"]["source"] =
      changeHrs === wlEvtHrs ? "config/deploy event"
        : changeHrs === flagHrs ? "feature flag"
          : pr && pr.firstIdx > 0 ? "deployment"
            : "none in window";

    // Davis
    const ids = wlSvcIds.get(wl) ?? new Set<string>();
    const infra = new Set([...(pr?.hosts ?? []), ...clusterIds]);
    let davis = 0;
    const davisIds: string[] = [];
    const davisMatches: RiskDavisMatch[] = [];
    for (const p of shared.problems) {
      const rootCause = str(p, "root_cause_entity_id");
      const affected = new Set([...strArr(p, "affected_entity_ids"), ...(rootCause ? [rootCause] : [])]);
      const activeNow = str(p, "event.status") === "ACTIVE";
      const endIso = str(p, "event.end");
      const recent = activeNow || (!!endIso && new Date(endIso) >= split);
      let s = 0;
      let match: RiskDavisMatch["match"] = "service";
      if ([...ids].some((id) => affected.has(id))) s = activeNow ? 1 : recent ? 0.6 : 0.3;
      else if ([...infra].some((id) => affected.has(id))) {
        s = activeNow ? CONFIG.infraProblemWeight : recent ? CONFIG.infraProblemWeight / 2 : 0;
        match = "infrastructure";
      }
      const displayId = str(p, "display_id");
      if (s > 0 && displayId) {
        davisIds.push(displayId);
        davisMatches.push({
          displayId,
          name: str(p, "event.name") ?? "",
          status: str(p, "event.status") ?? "",
          match,
          weight: s,
        });
      }
      davis = Math.max(davis, s);
    }

    const share = (tracesBy.get(wl) ?? 0) / totalTraces;
    const blast = (CONFIG.entrypoints as readonly string[]).includes(wl)
      ? 1
      : 0.5 * ((deps.get(wl) ?? 0) / maxDeps) + 0.5 * (share / maxShare);

    sig.set(wl, {
      traced: !!r, nb, nc, p0, pc, z, errReq, le, lambda, zLog, err, p95Base, p95Cur, latRatio, lat,
      cpu: pr?.cpuCur ?? 0,
      memGrowth: pr && Number.isFinite(pr.memGrowth) ? pr.memGrowth : 0,
      hosts: [...(pr?.hosts ?? [])].sort(),
      ooms: oomBy.get(wl) ?? 0, changeHrs, changeSource, chg, davis, davisIds, davisMatches, share, blast,
      sat: 0, cpuNorm: 0, memNorm: 0, // set below, need normalization across the cluster
      full: trend(p95), cur: trend(p95.slice(splitIdx)),
    });
  }

  // Saturation (normalized across the cluster's services)
  const signalsOf = (wl: string) => sig.get(wl) as Signals;
  const cpuN = minMax(new Map(W.map((wl) => [wl, signalsOf(wl).cpu])));
  const memN = minMax(new Map(W.map((wl) => [wl, Math.max(0, signalsOf(wl).memGrowth)])));
  for (const wl of W) {
    const s = signalsOf(wl);
    s.cpuNorm = cpuN.get(wl) ?? 0;
    s.memNorm = memN.get(wl) ?? 0;
    s.sat = Math.min(1, 0.4 * s.cpuNorm + 0.4 * s.memNorm + 0.5 * (s.ooms > 0 ? 1 : 0));
  }

  // Score, classify, explain
  const wt = CONFIG.weights;
  return W.map((wl): Omit<RiskRow, "rank"> => {
    const s = signalsOf(wl);
    const parts: Record<SignalKey, number> = {
      sat: wt.sat * s.sat, err: wt.err * s.err, lat: wt.lat * s.lat, chg: wt.chg * s.chg, davis: wt.davis * s.davis,
    };
    const mult = 1 + 0.5 * s.blast;
    const score = Math.round(100 * Math.min(1, Object.values(parts).reduce((a, b) => a + b, 0) * mult));

    const labels: Record<SignalKey, string> = {
      sat: `Saturation: CPU ${fmt(round(s.cpu, 2))}%, mem +${fmt(round(s.memGrowth))}%${s.ooms ? `, ${s.ooms} OOM kill(s) in ${CONFIG.oomHistoryDays}d` : ""}`,
      err: `Errors: ${fmt(round(s.pc * 100, 2))}% failed (z ${fmt(round(s.z))}), log errors ${s.le.base}→${s.le.cur}`,
      lat: `Latency: p95 ${fmt(round(s.p95Base))}→${fmt(round(s.p95Cur))} ms (${fmt(round(s.latRatio, 2))}×)`,
      chg: `Change ${fmt(round(s.changeHrs))}h ago`,
      davis: `Davis: ${s.davisIds.join(", ")}`,
    };
    const driver = (Object.entries(parts) as [SignalKey, number][]).sort((a, b) => b[1] - a[1])[0][0];

    const { full, cur } = s;
    const ge = (t: Trend, pct: number, tt: number) => t.pct !== null && t.t !== null && t.pct >= pct && t.t >= tt;
    const le = (t: Trend, pct: number, tt: number) => t.pct !== null && t.t !== null && t.pct <= pct && t.t <= tt;

    let status = "⚪ Stable";
    const deteriorating = ge(full, 20, 2) || ge(cur, 20, 2);
    if (s.davis >= 1 || (s.pc >= 0.01 && s.z >= 3)) status = "🔴 Broken";
    else if (deteriorating) status = "🟠 Deteriorating";
    else if ((s.latRatio ?? 1) >= 1.3 || s.z >= 3 || s.zLog >= 3 || ge(cur, 20, 1)) status = "🟡 Watch";
    else if (le(full, -20, -2)) status = "🟢 Recovering";

    const curT = cur.t ?? 0;
    const curPct = cur.pct ?? 0;
    const arrow = cur.pct === null ? "–" : curT >= 2 ? "📈" : curT <= -2 ? "📉" : curPct > 10 ? "↗️" : curPct < -10 ? "↘️" : "➡️";
    const tier = s.blast >= 0.75 ? "Critical" : s.blast >= 0.4 ? "High" : s.blast >= 0.2 ? "Medium" : "Low";

    const short = (w: string) => w.replace(`${ns}-`, "");
    const byName = (a: RiskDependency, b: RiskDependency) => a.service.localeCompare(b.service);
    const signalOf: Record<SignalKey, number> = { sat: s.sat, err: s.err, lat: s.lat, chg: s.chg, davis: s.davis };
    const components = (Object.keys(parts) as SignalKey[]).map((key) => ({
      key,
      label: labels[key],
      weight: wt[key],
      signal: round(signalOf[key], 3) ?? 0,
      points: round(100 * parts[key], 1) ?? 0,
    }));
    const basePoints = 100 * Object.values(parts).reduce((a, b) => a + b, 0);
    const breakdown: RiskBreakdown = {
      components,
      basePoints: round(basePoints, 1) ?? 0,
      multiplier: round(mult, 2) ?? 1,
      capped: basePoints * mult > 100,
      errors: {
        reqBase: s.nb, reqNow: s.nc,
        failRateBasePct: round(s.p0 * 100, 3) ?? 0, failRateNowPct: round(s.pc * 100, 3) ?? 0,
        z: round(s.z, 2) ?? 0, reqSignal: round(s.errReq, 3) ?? 0,
        logBase: s.le.base, logNow: s.le.cur, logExpected: round(s.lambda, 1) ?? 0, zLog: round(s.zLog, 2) ?? 0,
      },
      latency: {
        p95BaseMs: round(s.p95Base), p95NowMs: round(s.p95Cur), ratio: round(s.latRatio, 2),
        trendWindow: full.pct === null ? "n/a" : `${fmt(round(full.pct))}% (t ${fmt(round(full.t))})`,
        trendNow: cur.pct === null ? "n/a" : `${fmt(round(cur.pct))}% (t ${fmt(round(cur.t))})`,
      },
      saturation: {
        cpuPct: round(s.cpu, 3) ?? 0, cpuNorm: round(s.cpuNorm, 3) ?? 0,
        memGrowthPct: round(s.memGrowth) ?? 0, memNorm: round(s.memNorm, 3) ?? 0,
        oomKills: s.ooms, hosts: s.hosts,
      },
      change: { hoursAgo: round(s.changeHrs) ?? 0, source: s.changeSource },
      davis: s.davisMatches,
      blast: {
        value: round(s.blast, 3) ?? 0,
        tier,
        isEntrypoint: (CONFIG.entrypoints as readonly string[]).includes(wl),
        dependents: deps.get(wl) ?? 0,
        maxDependents: maxDeps,
        traceSharePct: round(s.share * 100, 1) ?? 0,
        maxTraceSharePct: round(maxShare * 100, 1) ?? 0,
        callers: [...(callers.get(wl) ?? [])]
          .map((c) => ({ service: short(c), via: adj.get(c)?.get(wl) ?? "traced call" }))
          .sort(byName),
        callees: [...(adj.get(wl) ?? new Map<string, EdgeSource>())]
          .map(([c, via]) => ({ service: short(c), via }))
          .sort(byName),
        transitiveDependents: [...(depSets.get(wl) ?? [])].map(short).sort(),
      },
    };

    return {
      score,
      service: wl.replace(`${ns}-`, ""),
      cluster: uid,
      status,
      primaryDriver: labels[driver],
      trendLast2h: cur.pct === null ? "n/a" : `${arrow} ${fmt(round(cur.pct))}% (t ${fmt(round(cur.t))})`,
      trendWindow: full.pct === null ? "n/a" : `${fmt(round(full.pct))}% (t ${fmt(round(full.t))})`,
      blastRadius: `${tier}: ${deps.get(wl) ?? 0} dependents, ${fmt(round(s.share * 100))}% of traces`,
      p95BaseMs: round(s.p95Base), p95NowMs: round(s.p95Cur), p95Ratio: round(s.latRatio, 2),
      failRateNowPct: round(s.pc * 100, 3), failZ: round(s.z), logErrBase: s.le.base, logErrNow: s.le.cur,
      cpuPct: round(s.cpu, 3), memGrowthPct: round(s.memGrowth), oomKills: s.ooms,
      hoursSinceChange: round(s.changeHrs), davis: s.davisIds.join(", ") || "–",
      sSat: round(s.sat, 2), sErr: round(s.err, 2), sLat: round(s.lat, 2), sChg: round(s.chg, 2), sDavis: round(s.davis, 2),
      blastMult: round(mult, 2),
      coverage: s.traced ? "traces+metrics+logs" : "metrics+logs only",
      breakdown,
    };
  });
}

/** Formats a rounded value for labels; mirrors the tile, which prints `null` for missing values. */
const fmt = (v: number | null): string => (v === null ? "null" : String(v));
