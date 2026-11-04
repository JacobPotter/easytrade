/**
 * DQL behind the per-service evidence in the Risk Breakdown sheet, adapted from the context tiles of
 * monaco/dashboards/easytrade-risk-leaderboard.json. Each query is pinned to one cluster and workload and to the
 * exact window of the scoring run the row came from, so the charts match the scores.
 * Expected Grail scan: the timeseries blocks scan nothing. The span and log blocks scan only once their section is
 * expanded: about 0.3–0.4 GB each at 24h for one busy service; scales with the window.
 */
import { RISK_CONFIG } from "./riskContract";

const ns = RISK_CONFIG.namespace;

export type MetricKind = "single" | "line" | "table";

/** One service in one cluster, over the window of the scoring run its row came from. */
export interface EvidenceScope {
  clusterUid: string;
  /** Full k8s.workload.name, e.g. "easytrade-broker-service" */
  workload: string;
  /** ISO timestamp: run start (computedAt − lookbackHours) */
  from: string;
  /** ISO timestamp: run end (computedAt) */
  to: string;
  /** ISO timestamp: start of the compare window (computedAt − currentHours) */
  split: string;
  currentHours: number;
}

export interface MetricTileDef<S> {
  id: string;
  title: (s: S) => string;
  kind: MetricKind;
  query: (s: S) => string;
  /** single-value tiles: the field to display */
  field?: string;
  /** single-value tiles: decimal places */
  decimals?: number;
}

export type EvidenceDef = MetricTileDef<EvidenceScope>;

/** DQL condition selecting one workload in one cluster. Values are quoted, never interpolated raw. */
const serviceCondition = (s: EvidenceScope) =>
  `k8s.cluster.uid == ${JSON.stringify(s.clusterUid)} and k8s.workload.name == ${JSON.stringify(s.workload)}`;
const runWindow = (s: EvidenceScope) => `from:${JSON.stringify(s.from)}, to:${JSON.stringify(s.to)}`;

export const EVIDENCE = {
  p95: {
    id: "p95",
    title: () => "p95 response time (ms)",
    kind: "line",
    query: (s) =>
      `timeseries p95 = percentile(dt.service.request.response_time, 95), filter: ${serviceCondition(s)}, ` +
      `interval: 15m, ${runWindow(s)} | fieldsAdd p95ms = p95[] / 1000 | fields timeframe, interval, p95ms`,
  },
  failRate: {
    id: "failRate",
    title: () => "Failure rate (%)",
    kind: "line",
    query: (s) =>
      `timeseries {req = sum(dt.service.request.count), fail = sum(dt.service.request.failure_count)}, ` +
      `filter: ${serviceCondition(s)}, interval: 15m, ${runWindow(s)} ` +
      `| fieldsAdd failPct = 100 * fail[] / req[] | fields timeframe, interval, failPct`,
  },
  failuresByEndpoint: {
    id: "failuresByEndpoint",
    title: () => "Failures by endpoint",
    kind: "table",
    query: (s) =>
      `fetch spans, ${runWindow(s)} | filter ${serviceCondition(s)} and span.kind == "server" and request.is_failed == true ` +
      `| summarize {failures = count(), last = max(start_time)}, by:{span.name, http.response.status_code} ` +
      `| sort failures desc | limit 25`,
  },
  logSamples: {
    id: "logSamples",
    title: (s) => `Error logs: baseline vs last ${s.currentHours}h`,
    kind: "table",
    query: (s) =>
      `fetch logs, ${runWindow(s)} | filter k8s.namespace.name == "${ns}" and ${serviceCondition(s)} ` +
      `and in(loglevel, array("ERROR", "SEVERE", "FATAL")) ` +
      `| fieldsAdd period = if(timestamp < toTimestamp(${JSON.stringify(s.split)}), "baseline", else: "last ${s.currentHours}h") ` +
      `| summarize {errors = count(), sample = takeFirst(substring(content, to: 160))}, by:{period} | sort period asc`,
  },
} satisfies Record<string, EvidenceDef>;
