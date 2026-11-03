/**
 * EasyTrade Service Risk Signal Matrix: Dynatrace Dashboard "Code" tile.
 *
 * Runs every DQL query itself, so each refresh scores the live data.
 * Edit CONFIG only. Expected Grail scan per refresh: about 0.8 GB (24h window).
 */
import { queryExecutionClient } from '@dynatrace-sdk/client-query';

const CONFIG = {
  output: 'leaderboard', // 'leaderboard' = prompt columns only, 'full' = every raw and normalized input
  namespace: 'easytrade',
  lookbackHours: 24, // baseline + current
  currentHours: 2, // most recent slice compared against the rest
  bucketMinutes: 15,
  traceWindowMinutes: 30, // trace share + service-ID mapping
  oomHistoryDays: 7, // across all clusters (workload names carry over)
  weights: { sat: 0.2, err: 0.25, lat: 0.2, chg: 0.15, davis: 0.2 },
  changeDecayHours: 6,
  infraProblemWeight: 0.25, // active problem on the host/cluster a service runs on
  exclude: ['easytrade-loadgen'],
  entrypoints: ['easytrade-frontendreverseproxy'],
  dbWorkloads: { mssql: 'easytrade-db' },
  // Calls Dynatrace cannot trace (verified in src/): async queue + untraced Go caller
  extraEdges: [
    ['easytrade-aggregator-service', 'easytrade-offerservice'],
    ['easytrade-pricing-service', 'easytrade-rabbitmq'],
    ['easytrade-rabbitmq', 'easytrade-calculationservice'],
  ],
};

async function dql(query) {
  const started = await queryExecutionClient.queryExecute({
    body: { query, requestTimeoutMilliseconds: 30000, maxResultRecords: 100000 },
  });
  if (started.result) return started.result.records;
  let polled;
  do {
    polled = await queryExecutionClient.queryPoll({
      requestToken: started.requestToken,
      requestTimeoutMilliseconds: 30000,
    });
  } while (polled.state === 'RUNNING' || polled.state === 'NOT_STARTED');
  if (polled.state !== 'SUCCEEDED') {
    throw new Error(`DQL ${polled.state}: ${query}`);
  }
  return polled.result.records;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const nonNull = (a) => a.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
const sum = (a) => nonNull(a).reduce((s, v) => s + v, 0);
const avg = (a) => (nonNull(a).length ? sum(a) / nonNull(a).length : null);
const median = (a) => {
  const s = nonNull(a).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

// Ordinary least squares on (index, value); returns % change across the window and t-statistic
function trend(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
  if (pts.length < 4) return { pct: null, t: null };
  const n = pts.length;
  const mx = pts.reduce((s, [x]) => s + x, 0) / n;
  const my = pts.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const b = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx;
  const sse = pts.reduce((s, [x, y]) => s + (y - (my + b * (x - mx))) ** 2, 0);
  const se = Math.sqrt(sse / (n - 2) / sxx);
  const span = pts[n - 1][0] - pts[0][0];
  const t = se > 1e-12 ? b / se : Math.sign(b) * 99;
  return { pct: my ? ((b * span) / my) * 100 : null, t: Math.max(-99, Math.min(99, t)) };
}

function minMax(map) {
  const vals = [...map.values()];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return new Map([...map].map(([k, v]) => [k, hi > lo ? (v - lo) / (hi - lo) : 0]));
}

export default async function () {
  const B = CONFIG.bucketMinutes;
  const end = new Date(Math.floor(Date.now() / (B * 60000)) * B * 60000);
  const start = new Date(end.getTime() - CONFIG.lookbackHours * 3600000);
  const split = new Date(end.getTime() - CONFIG.currentHours * 3600000);
  const nBuckets = (CONFIG.lookbackHours * 60) / B;
  const splitIdx = nBuckets - (CONFIG.currentHours * 60) / B;
  const win = `from:"${start.toISOString()}", to:"${end.toISOString()}"`;
  const ns = CONFIG.namespace;
  const tw = `from: now()-${CONFIG.traceWindowMinutes}m`;

  // 1. Active cluster = the one sending the most spans right now
  const [active] = await dql(
    `fetch spans, from: now()-15m | filter k8s.namespace.name == "${ns}" ` +
      `| summarize spans = count(), by:{k8s.cluster.uid} | sort spans desc | limit 1`,
  );
  if (!active) throw new Error(`No spans from namespace "${ns}" in the last 15 min; fix ingest before scoring.`);
  const uid = active['k8s.cluster.uid'];
  const inCluster = `k8s.cluster.uid == "${uid}"`;

  // 2. All signal queries in parallel
  const [
    podsSmartscape, podsLogs, red, logErr, proc, svcMap, traceRows, traceTotal,
    edges, dbCalls, ooms, problems, flagToggles, changeEvents, clusterEntity,
  ] = await Promise.all([
    dql(`smartscapeNodes "K8S_POD" | filter ${inCluster} and k8s.namespace.name == "${ns}" | fields k8s.pod.uid, k8s.workload.name`),
    dql(`fetch logs, ${tw} | filter k8s.namespace.name == "${ns}" and ${inCluster} | summarize n = count(), by:{k8s.pod.uid, k8s.workload.name}`),
    dql(`timeseries {req = sum(dt.service.request.count), fail = sum(dt.service.request.failure_count), ` +
      `p95 = percentile(dt.service.request.response_time, 95)}, by:{k8s.workload.name}, ` +
      `filter: ${inCluster}, interval:${B}m, ${win}`),
    dql(`fetch logs, ${win} | filter k8s.namespace.name == "${ns}" and ${inCluster} ` +
      `and in(loglevel, array("ERROR", "SEVERE", "FATAL")) ` +
      `| summarize base = countIf(timestamp < toTimestamp("${split.toISOString()}")), ` +
      `cur = countIf(timestamp >= toTimestamp("${split.toISOString()}")), by:{k8s.workload.name}`),
    dql(`timeseries {cpu = avg(dt.process.cpu.usage), mem = avg(dt.process.memory.working_set_size)}, ` +
      `by:{k8s.pod.uid, dt.smartscape.host}, filter: k8s.namespace.name == "${ns}" and ${inCluster}, interval:${B}m, ${win}`),
    dql(`fetch spans, ${tw} | filter ${inCluster} | summarize n = count(), by:{dt.smartscape.service, k8s.workload.name}`),
    dql(`fetch spans, ${tw} | filter ${inCluster} | summarize traces = countDistinct(trace.id), by:{k8s.workload.name}`),
    dql(`fetch spans, ${tw} | filter ${inCluster} | summarize traces = countDistinct(trace.id)`),
    dql(`smartscapeEdges "calls" | filter source_type == "SERVICE" and target_type == "SERVICE" | fields source_id, target_id`),
    dql(`fetch spans, ${tw} | filter ${inCluster} and isNotNull(db.system) | summarize calls = count(), by:{k8s.workload.name, db.system}`),
    dql(`timeseries oom = sum(dt.kubernetes.container.oom_kills), by:{k8s.workload.name}, ` +
      `filter: k8s.namespace.name == "${ns}", from: now()-${CONFIG.oomHistoryDays}d | fieldsAdd total = arraySum(oom) | fields k8s.workload.name, total`),
    dql(`fetch dt.davis.problems, ${win} | sort timestamp desc | dedup event.id ` +
      `| fields display_id, event.name, event.status, event.start, event.end, affected_entity_ids, root_cause_entity_id`),
    dql(`fetch bizevents, ${win} | filter event.type == "com.easytrade.flag-toggle" | summarize n = count(), last = max(timestamp)`),
    dql(`fetch events, ${win} | filter in(event.type, array("CUSTOM_DEPLOYMENT", "CUSTOM_CONFIGURATION")) ` +
      `| summarize last = max(timestamp), by:{k8s.workload.name, dt.smartscape.service}`),
    dql(`timeseries x = sum(dt.service.request.count), by:{dt.entity.kubernetes_cluster}, filter: ${inCluster}, from: now()-30m ` +
      `| fields dt.entity.kubernetes_cluster`),
  ]);

  // 3. Mappings: pod -> workload, service ID -> workload
  const podToWl = new Map();
  for (const r of [...podsSmartscape, ...podsLogs]) {
    if (r['k8s.pod.uid'] && r['k8s.workload.name']) podToWl.set(r['k8s.pod.uid'], r['k8s.workload.name']);
  }
  const svcToWl = new Map();
  const wlSvcIds = new Map();
  for (const r of svcMap) {
    const id = r['dt.smartscape.service'];
    const wl = r['k8s.workload.name'];
    if (!id || !wl) continue;
    svcToWl.set(id, wl);
    if (!wlSvcIds.has(wl)) wlSvcIds.set(wl, new Set());
    wlSvcIds.get(wl).add(id);
  }

  const workloads = new Set([...podToWl.values()].filter((w) => !CONFIG.exclude.includes(w)));
  for (const r of red) if (r['k8s.workload.name'] && !CONFIG.exclude.includes(r['k8s.workload.name'])) workloads.add(r['k8s.workload.name']);
  const W = [...workloads].sort();

  // 4. Per-workload raw signals
  const redBy = new Map(red.filter((r) => r['k8s.workload.name']).map((r) => [r['k8s.workload.name'], r]));
  const logBy = new Map(logErr.map((r) => [r['k8s.workload.name'], { base: num(r.base), cur: num(r.cur) }]));
  const oomBy = new Map(ooms.map((r) => [r['k8s.workload.name'], num(r.total) || 0]));
  const tracesBy = new Map(traceRows.map((r) => [r['k8s.workload.name'], num(r.traces)]));
  const totalTraces = num(traceTotal[0]?.traces) || 1;
  const clusterIds = new Set(clusterEntity.map((r) => r['dt.entity.kubernetes_cluster']).filter(Boolean));

  const procBy = new Map(); // workload -> { cpuCur, memGrowth, firstIdx, hosts }
  for (const r of proc) {
    const wl = podToWl.get(r['k8s.pod.uid']);
    if (!wl || !workloads.has(wl)) continue;
    const cpu = (r.cpu || []).map(num);
    const mem = (r.mem || []).map(num);
    const memVals = nonNull(mem);
    const firstIdx = cpu.findIndex((v) => v !== null);
    const growth = memVals.length >= 6
      ? ((median(memVals.slice(-3)) - median(memVals.slice(0, 3))) / median(memVals.slice(0, 3))) * 100
      : 0;
    const prev = procBy.get(wl) || { cpuCur: 0, memGrowth: -Infinity, firstIdx: -1, hosts: new Set() };
    prev.cpuCur += avg(cpu.slice(splitIdx)) || 0;
    prev.memGrowth = Math.max(prev.memGrowth, growth);
    prev.firstIdx = Math.max(prev.firstIdx, firstIdx); // newest pod = latest deploy
    if (r['dt.smartscape.host']) prev.hosts.add(r['dt.smartscape.host']);
    procBy.set(wl, prev);
  }

  // Change recency: newest pod start (first bucket with data), config events, flag toggles
  const hoursAgo = (iso) => (end.getTime() - new Date(iso).getTime()) / 3600000;
  const flagHrs = num(flagToggles[0]?.n) > 0 ? hoursAgo(flagToggles[0].last) : Infinity;
  const evtHrs = new Map();
  for (const r of changeEvents) {
    const wl = r['k8s.workload.name'] || svcToWl.get(r['dt.smartscape.service']);
    if (wl) evtHrs.set(wl, Math.min(evtHrs.get(wl) ?? Infinity, hoursAgo(r.last)));
  }

  // 5. Topology and blast radius
  const adj = new Map(W.map((w) => [w, new Set()]));
  const addEdge = (a, b) => { if (a !== b && adj.has(a) && adj.has(b)) adj.get(a).add(b); };
  for (const e of edges) addEdge(svcToWl.get(e.source_id), svcToWl.get(e.target_id));
  for (const r of dbCalls) addEdge(r['k8s.workload.name'], CONFIG.dbWorkloads[r['db.system']]);
  for (const [a, b] of CONFIG.extraEdges) addEdge(a, b);
  const callers = new Map(W.map((w) => [w, new Set()]));
  for (const [a, outs] of adj) for (const b of outs) callers.get(b).add(a);
  const dependents = (w) => {
    const seen = new Set();
    const stack = [w];
    while (stack.length) for (const p of callers.get(stack.pop()) || []) if (p !== w && !seen.has(p)) { seen.add(p); stack.push(p); }
    return seen.size;
  };
  const deps = new Map(W.map((w) => [w, dependents(w)]));
  const maxDeps = Math.max(1, ...deps.values());
  const maxShare = Math.max(1e-9, ...W.map((w) => (tracesBy.get(w) || 0) / totalTraces));

  // 6. Signals
  const sig = new Map();
  for (const w of W) {
    const r = redBy.get(w);
    const req = r ? (r.req || []).map(num) : [];
    const fail = r ? (r.fail || []).map(num) : [];
    const p95 = r ? (r.p95 || []).map((v) => (v === null ? null : num(v) / 1000)) : [];

    // Errors: request failure z-score + absolute level, plus log-error rate change (Poisson)
    const nb = sum(req.slice(0, splitIdx)); const fb = sum(fail.slice(0, splitIdx));
    const nc = sum(req.slice(splitIdx)); const fc = sum(fail.slice(splitIdx));
    const p0 = Math.max(nb ? fb / nb : 0, 1e-4);
    const pc = nc ? fc / nc : 0;
    const z = nc ? (pc - p0) / Math.sqrt((p0 * (1 - p0)) / nc) : 0;
    const errReq = nc ? 0.5 * Math.min(1, Math.max(0, z) / 3) + 0.5 * Math.min(1, pc / 0.01) : 0;
    const le = logBy.get(w) || { base: 0, cur: 0 };
    const lambda = Math.max(0.5, (le.base * CONFIG.currentHours) / (CONFIG.lookbackHours - CONFIG.currentHours));
    const zLog = (le.cur - lambda) / Math.sqrt(lambda);
    const err = 0.7 * errReq + 0.3 * Math.min(1, Math.max(0, zLog) / 3);

    // Latency: median p95 now vs baseline; 2x = full signal
    const p95Base = median(p95.slice(0, splitIdx));
    const p95Cur = median(p95.slice(splitIdx));
    const latRatio = p95Base && p95Cur ? p95Cur / p95Base : null;
    const lat = latRatio ? Math.min(1, Math.max(0, Math.log(latRatio)) / Math.LN2) : 0;

    // Change recency
    const pr = procBy.get(w);
    const deployHrs = pr && pr.firstIdx > 0 ? (nBuckets - pr.firstIdx) * (B / 60) : CONFIG.lookbackHours;
    const changeHrs = Math.min(deployHrs, flagHrs, evtHrs.get(w) ?? Infinity);
    const chg = Math.exp(-changeHrs / CONFIG.changeDecayHours);

    // Davis
    const ids = wlSvcIds.get(w) || new Set();
    const infra = new Set([...(pr?.hosts || []), ...clusterIds]);
    let davis = 0;
    const davisIds = [];
    for (const p of problems) {
      const affected = new Set([...(p.affected_entity_ids || []), p.root_cause_entity_id].filter(Boolean));
      const activeNow = p['event.status'] === 'ACTIVE';
      const recent = activeNow || (p['event.end'] && new Date(p['event.end']) >= split);
      let s = 0;
      if ([...ids].some((id) => affected.has(id))) s = activeNow ? 1 : recent ? 0.6 : 0.3;
      else if ([...infra].some((id) => affected.has(id))) s = activeNow ? CONFIG.infraProblemWeight : recent ? CONFIG.infraProblemWeight / 2 : 0;
      if (s > 0) davisIds.push(p.display_id);
      davis = Math.max(davis, s);
    }

    const share = (tracesBy.get(w) || 0) / totalTraces;
    const blast = CONFIG.entrypoints.includes(w) ? 1 : 0.5 * (deps.get(w) / maxDeps) + 0.5 * (share / maxShare);

    sig.set(w, {
      traced: !!r, req, p95, nc, fc, pc, z, le, zLog, err, p95Base, p95Cur, latRatio, lat,
      cpu: pr?.cpuCur ?? 0, memGrowth: pr && Number.isFinite(pr.memGrowth) ? pr.memGrowth : 0,
      ooms: oomBy.get(w) || 0, changeHrs, chg, davis, davisIds, share, blast,
      full: trend(p95), cur: trend(p95.slice(splitIdx)),
    });
  }

  // Saturation (needs fleet-wide normalization)
  const cpuN = minMax(new Map(W.map((w) => [w, sig.get(w).cpu])));
  const memN = minMax(new Map(W.map((w) => [w, Math.max(0, sig.get(w).memGrowth)])));
  for (const w of W) {
    const s = sig.get(w);
    s.sat = Math.min(1, 0.4 * cpuN.get(w) + 0.4 * memN.get(w) + 0.5 * (s.ooms > 0 ? 1 : 0));
  }

  // 7. Score, classify, explain
  const wt = CONFIG.weights;
  const rows = W.map((w) => {
    const s = sig.get(w);
    const parts = {
      sat: wt.sat * s.sat, err: wt.err * s.err, lat: wt.lat * s.lat, chg: wt.chg * s.chg, davis: wt.davis * s.davis,
    };
    const mult = 1 + 0.5 * s.blast;
    const score = Math.round(100 * Math.min(1, Object.values(parts).reduce((a, b) => a + b, 0) * mult));

    const labels = {
      sat: `Saturation: CPU ${round(s.cpu, 2)}%, mem +${round(s.memGrowth)}%${s.ooms ? `, ${s.ooms} OOM kill(s) in ${CONFIG.oomHistoryDays}d` : ''}`,
      err: `Errors: ${round(s.pc * 100, 2)}% failed (z ${round(s.z)}), log errors ${s.le.base}→${s.le.cur}`,
      lat: `Latency: p95 ${round(s.p95Base)}→${round(s.p95Cur)} ms (${round(s.latRatio, 2)}×)`,
      chg: `Change ${round(s.changeHrs)}h ago`,
      davis: `Davis: ${s.davisIds.join(', ')}`,
    };
    const driver = Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0];

    let status = '⚪ Stable';
    const deteriorating = (s.full.pct >= 20 && s.full.t >= 2) || (s.cur.pct >= 20 && s.cur.t >= 2);
    if (s.davis >= 1 || (s.pc >= 0.01 && s.z >= 3)) status = '🔴 Broken';
    else if (deteriorating) status = '🟠 Deteriorating';
    else if ((s.latRatio ?? 1) >= 1.3 || s.z >= 3 || s.zLog >= 3 || (s.cur.pct >= 20 && s.cur.t >= 1)) status = '🟡 Watch';
    else if (s.full.pct <= -20 && s.full.t <= -2) status = '🟢 Recovering';

    const arrow = s.cur.pct === null ? '–' : s.cur.t >= 2 ? '📈' : s.cur.t <= -2 ? '📉' : s.cur.pct > 10 ? '↗️' : s.cur.pct < -10 ? '↘️' : '➡️';
    const tier = s.blast >= 0.75 ? 'Critical' : s.blast >= 0.4 ? 'High' : s.blast >= 0.2 ? 'Medium' : 'Low';

    return {
      score,
      service: w.replace(`${ns}-`, ''),
      status,
      primaryDriver: labels[driver],
      trendLast2h: s.cur.pct === null ? 'n/a' : `${arrow} ${round(s.cur.pct)}% (t ${round(s.cur.t)})`,
      trendWindow: s.full.pct === null ? 'n/a' : `${round(s.full.pct)}% (t ${round(s.full.t)})`,
      blastRadius: `${tier}: ${deps.get(w)} dependents, ${round(s.share * 100)}% of traces`,
      p95BaseMs: round(s.p95Base), p95NowMs: round(s.p95Cur), p95Ratio: round(s.latRatio, 2),
      failRateNowPct: round(s.pc * 100, 3), failZ: round(s.z), logErrBase: s.le.base, logErrNow: s.le.cur,
      cpuPct: round(s.cpu, 3), memGrowthPct: round(s.memGrowth), oomKills: s.ooms,
      hoursSinceChange: round(s.changeHrs), davis: s.davisIds.join(', ') || '–',
      sSat: round(s.sat, 2), sErr: round(s.err, 2), sLat: round(s.lat, 2), sChg: round(s.chg, 2), sDavis: round(s.davis, 2),
      blastMult: round(mult, 2),
      coverage: s.traced ? 'traces+metrics+logs' : 'metrics+logs only',
      window: `${start.toISOString().slice(11, 16)}–${end.toISOString().slice(11, 16)} UTC (now = last ${CONFIG.currentHours}h)`,
      cluster: uid,
    };
  });

  const ranked = rows.sort((a, b) => b.score - a.score).map((r, i) => ({ rank: i + 1, ...r }));
  if (CONFIG.output === 'full') return ranked;
  // Rows stay in rank order (rank 1 first); the Rank column itself is not shown.
  // Key order = dashboard column order, so Status comes first.
  return ranked.map((r) => ({
    Status: r.status,
    'Service Name': r.service,
    'Risk Score': r.score,
    'Primary Driver': r.primaryDriver,
    'Trend Direction': r.trendLast2h,
    'Blast Radius Impact': r.blastRadius,
  }));
}
