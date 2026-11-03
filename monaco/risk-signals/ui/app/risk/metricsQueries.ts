/**
 * DQL for the "Risk Metrics" tab: the context tiles of monaco/dashboards/easytrade-risk-leaderboard.json,
 * parameterized by the app-wide scope (RiskFiltersContext) instead of the dashboard's fixed cluster and windows:
 *   - cluster filter: the selected clusters, or every cluster when none is selected;
 *   - "last 2h" tiles use the compare window; "12h" tiles use the baseline window;
 *   - when more than one cluster is in scope, charts and tables are split by a "cluster" label (name · uid prefix).
 * Expected Grail scan per load: about 0.3 GB at 24h for one cluster (failed spans + error logs); scales with the window.
 */
import { clusterCondition, RISK_CONFIG, type RiskParams } from "./engine";

const ns = RISK_CONFIG.namespace;

export type MetricKind = "single" | "line" | "table";

export interface MetricScope {
  /** DQL condition on k8s.cluster.uid */
  clusterCond: string;
  lookbackHours: number;
  currentHours: number;
  /** Split series/rows by cluster (more than one cluster in scope) */
  splitByCluster: boolean;
}

export function metricScope(params: RiskParams): MetricScope {
  return {
    clusterCond: clusterCondition(params.clusters),
    lookbackHours: params.lookbackHours,
    currentHours: params.currentHours,
    splitByCluster: params.clusters.length !== 1,
  };
}

export interface MetricTileDef {
  id: string;
  title: (s: MetricScope) => string;
  kind: MetricKind;
  query: (s: MetricScope) => string;
  /** single-value tiles: the field to display */
  field?: string;
  /** single-value tiles: decimal places */
  decimals?: number;
}

/** `by` prefix that adds the cluster dimensions when splitting */
const byCluster = (s: MetricScope) => (s.splitByCluster ? "k8s.cluster.uid, k8s.cluster.name, " : "");
/** Replaces the cluster dimensions with one readable "cluster" field (cluster names are not unique) */
const clusterLabel = (s: MetricScope) =>
  s.splitByCluster
    ? `| fieldsAdd cluster = concat(coalesce(k8s.cluster.name, "unnamed"), " · ", substring(k8s.cluster.uid, to: 8)) `
    : "";
const clusterField = (s: MetricScope) => (s.splitByCluster ? "cluster, " : "");
const dropClusterDims = (s: MetricScope) => (s.splitByCluster ? "| fieldsRemove k8s.cluster.uid, k8s.cluster.name " : "");

export const METRIC_TILES: MetricTileDef[] = [
  {
    id: "activeProblems",
    title: () => "Active Davis problems",
    kind: "single",
    field: "activeProblems",
    decimals: 0,
    // Not cluster-scoped and not window-scoped: "active" means open right now.
    query: () =>
      `fetch dt.davis.problems, from: now()-24h | sort timestamp desc | dedup event.id ` +
      `| filter event.status == "ACTIVE" | summarize activeProblems = count()`,
  },
  {
    id: "failPct",
    title: (s) => `Failed requests, last ${s.currentHours}h (%)`,
    kind: "single",
    field: "failPct",
    decimals: 2,
    query: (s) =>
      `timeseries {fail = sum(dt.service.request.failure_count, scalar:true), req = sum(dt.service.request.count, scalar:true)}, ` +
      `filter: ${s.clusterCond}, from: now()-${s.currentHours}h | fieldsAdd failPct = 100 * fail / req | fields failPct`,
  },
  {
    id: "ingressP95",
    title: (s) => `Ingress p95, last ${s.currentHours}h (ms)`,
    kind: "single",
    field: "p95ms",
    decimals: 1,
    query: (s) =>
      `timeseries p95 = percentile(dt.service.request.response_time, 95, scalar:true), ` +
      `filter: ${s.clusterCond} and k8s.workload.name == "${ns}-frontendreverseproxy", from: now()-${s.currentHours}h ` +
      `| fieldsAdd p95ms = p95 / 1000 | fields p95ms`,
  },
  {
    id: "p95ByService",
    title: (s) => `p95 latency by service, ${s.lookbackHours}h (ms)`,
    kind: "line",
    query: (s) =>
      `timeseries p95 = percentile(dt.service.request.response_time, 95), by:{${byCluster(s)}k8s.workload.name}, ` +
      `filter: ${s.clusterCond}, interval: 15m, from: now()-${s.lookbackHours}h ` +
      `| fieldsAdd p95ms = p95[] / 1000 ${clusterLabel(s)}` +
      `| fields timeframe, interval, ${clusterField(s)}k8s.workload.name, p95ms`,
  },
  {
    id: "failRateByService",
    title: (s) => `Failure rate by service, ${s.lookbackHours}h (%)`,
    kind: "line",
    query: (s) =>
      `timeseries {req = sum(dt.service.request.count), fail = sum(dt.service.request.failure_count)}, ` +
      `by:{${byCluster(s)}k8s.workload.name}, filter: ${s.clusterCond}, interval: 15m, from: now()-${s.lookbackHours}h ` +
      `| fieldsAdd failPct = 100 * fail[] / req[] ${clusterLabel(s)}` +
      `| fields timeframe, interval, ${clusterField(s)}k8s.workload.name, failPct`,
  },
  {
    id: "failuresByEndpoint",
    title: (s) => `Failures by endpoint, ${s.lookbackHours}h`,
    kind: "table",
    query: (s) =>
      `fetch spans, from: now()-${s.lookbackHours}h | filter ${s.clusterCond} and span.kind == "server" and request.is_failed == true ` +
      `| summarize {failures = count(), last = max(start_time)}, by:{${byCluster(s)}k8s.workload.name, span.name, http.response.status_code} ` +
      `${clusterLabel(s)}${dropClusterDims(s)}| sort failures desc | limit 25`,
  },
  {
    id: "logErrors",
    title: (s) => `Log errors: baseline vs last ${s.currentHours}h`,
    kind: "table",
    query: (s) =>
      `fetch logs, from: now()-${s.lookbackHours}h | filter k8s.namespace.name == "${ns}" and ${s.clusterCond} ` +
      `and in(loglevel, array("ERROR", "SEVERE", "FATAL")) ` +
      `| fieldsAdd period = if(timestamp < now()-${s.currentHours}h, "baseline", else: "last ${s.currentHours}h") ` +
      `| summarize {errors = count(), sample = takeFirst(substring(content, to: 160))}, by:{${byCluster(s)}k8s.workload.name, period} ` +
      `${clusterLabel(s)}${dropClusterDims(s)}| sort k8s.workload.name asc`,
  },
  {
    id: "davisProblems",
    title: (s) => `Davis problems, ${s.lookbackHours}h`,
    kind: "table",
    // Not cluster-scoped: problems reference entities, not k8s.cluster.uid.
    query: (s) =>
      `fetch dt.davis.problems, from: now()-${s.lookbackHours}h | sort timestamp desc | dedup event.id ` +
      `| fields display_id, event.name, event.status, event.start, event.end, affected_entity_ids, root_cause_entity_id ` +
      `| sort event.start desc`,
  },
];
