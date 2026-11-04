import {
  copilotClient,
  type ConversationRequest,
  type ConversationResponse,
  type RecommenderResponse,
} from "@dynatrace-sdk/client-davis-copilot";

import type { ServiceRiskAnalysis, ServiceRiskPayload } from "../ui/app/risk/analysisContract";

export type { ServiceRiskAnalysis, ServiceRiskPayload };

const SRE_INSTRUCTION = [
  "Act as a Senior Site Reliability Engineer reviewing one service of the EasyTrade stock-broking application on Kubernetes.",
  "Base the analysis strictly on the numbers provided; quote the exact values you rely on and do not invent metrics. Treat 'n/a' as missing data and say when it limits a conclusion.",
  "Answer in Markdown with exactly these sections:",
  "### Assessment: 2-3 sentences on how risky the service is right now and why.",
  "### Likely bottlenecks: a bulleted list; each bullet names the bottleneck and the metric(s) that point to it.",
  "### Mitigation strategy: a bulleted list grouped as **Immediate**, **Short-term** and **Preventive**, each bullet a concrete action.",
].join("\n");

const fmt = (value: number | null, unit = "", digits = 2): string =>
  value === null || !Number.isFinite(value) ? "n/a" : `${Number(value.toFixed(digits))}${unit}`;

/** Builds the Davis CoPilot request. Exported for tests; pure, no I/O. */
export function buildRiskPrompt(p: ServiceRiskPayload): ConversationRequest {
  const lines = [
    `Analyze the operational risk of service "${p.service}" in cluster "${p.cluster}".`,
    "",
    "Risk model: composite score 0-100 = weighted errors 0.25, latency 0.2, saturation 0.2, change recency 0.15, Davis problems 0.2, multiplied by a blast-radius factor (1-1.5). Baseline = earlier part of the lookback window, current = most recent slice.",
    "",
    "| Signal | Value |",
    "| --- | --- |",
    `| Risk score (0-100) | ${fmt(p.score, "", 1)} |`,
    `| Status | ${p.status} |`,
    `| Primary driver | ${p.primaryDriver} |`,
    `| Trend (current window) | ${p.trendLast2h} |`,
    `| Blast radius | ${p.blastRadius} |`,
    `| Failure rate now | ${fmt(p.failRateNowPct, " %")} |`,
    `| Failure-rate z-score vs baseline | ${fmt(p.failZ)} |`,
    `| p95 latency baseline | ${fmt(p.p95BaseMs, " ms", 1)} |`,
    `| p95 latency now | ${fmt(p.p95NowMs, " ms", 1)} |`,
    `| p95 latency ratio now/baseline | ${fmt(p.p95Ratio)} |`,
    `| Error logs per bucket baseline | ${fmt(p.logErrBase)} |`,
    `| Error logs per bucket now | ${fmt(p.logErrNow)} |`,
    `| CPU usage vs limit | ${fmt(p.cpuPct, " %", 1)} |`,
    `| Memory growth over window | ${fmt(p.memGrowthPct, " %", 1)} |`,
    `| OOM kills | ${fmt(p.oomKills, "", 0)} |`,
    `| Hours since last change | ${fmt(p.hoursSinceChange, " h", 1)} |`,
    `| Davis problems | ${p.davis || "none"} |`,
    `| Component score errors (0-1) | ${fmt(p.sErr)} |`,
    `| Component score latency (0-1) | ${fmt(p.sLat)} |`,
    `| Component score saturation (0-1) | ${fmt(p.sSat)} |`,
    `| Component score change (0-1) | ${fmt(p.sChg)} |`,
    `| Component score Davis (0-1) | ${fmt(p.sDavis)} |`,
    `| Blast-radius multiplier | ${fmt(p.blastMult)} |`,
    `| Signal coverage | ${p.coverage} |`,
  ];

  return {
    text: lines.join("\n"),
    context: [
      { type: "instruction", value: SRE_INSTRUCTION },
      // Answer from the supplied numbers, not from a Dynatrace documentation search.
      { type: "document-retrieval", value: "disabled" },
    ],
    annotations: { application_context: "my.risk.signals" },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Narrows the untyped function payload; throws with the first offending field. */
export function parsePayload(payload: unknown): ServiceRiskPayload {
  if (!isRecord(payload)) throw new Error("Invalid payload: expected an object with the service risk row");
  if (typeof payload.service !== "string" || payload.service.trim() === "") {
    throw new Error("Invalid payload: 'service' must be a non-empty string");
  }
  if (typeof payload.score !== "number" || !Number.isFinite(payload.score)) {
    throw new Error("Invalid payload: 'score' must be a finite number");
  }
  // The remaining fields are only rendered into the prompt; the UI builds them from a typed RiskRow.
  return payload as unknown as ServiceRiskPayload;
}

/** recommenderConversation returns either one JSON answer or a list of stream events. */
const isConversationResponse = (r: RecommenderResponse): r is ConversationResponse =>
  !Array.isArray(r) && typeof r.text === "string";

// dt-app requires the handler to be the default export of `api/<name>.function.ts`
// (exception to the repo's named-exports rule).
export default async function (payload: unknown): Promise<ServiceRiskAnalysis> {
  const row = parsePayload(payload);
  const response = await copilotClient.recommenderConversation({ body: buildRiskPrompt(row) });

  if (!isConversationResponse(response)) {
    throw new Error("Davis CoPilot returned a streaming response; expected a single JSON answer");
  }
  if (response.status === "FAILED") {
    throw new Error(`Davis CoPilot could not analyze ${row.service}: ${response.text}`);
  }
  return { analysis: response.text, status: response.status };
}
