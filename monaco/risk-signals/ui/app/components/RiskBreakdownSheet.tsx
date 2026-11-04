import React, { useMemo } from "react";

import { Button } from "@dynatrace/strato-components/buttons";
import { Accordion, Chip, ChipGroup, MessageContainer, ProgressBar } from "@dynatrace/strato-components/content";
import { Flex, Surface } from "@dynatrace/strato-components/layouts";
import { Sheet } from "@dynatrace/strato-components/overlays";
import { SimpleTable, type SimpleTableColumnDef } from "@dynatrace/strato-components/tables";
import { Heading, Paragraph, Strong, Text } from "@dynatrace/strato-components/typography";

import { RISK_CONFIG, type EdgeSource, type RiskDependency, type RiskRow, type SignalKey } from "../risk/riskContract";
import { EVIDENCE, type EvidenceDef, type EvidenceScope } from "../risk/metricsQueries";
import { MetricTile } from "./MetricTile";

/** Window of the scoring run a row came from (ISO timestamps); the evidence queries are pinned to it. */
export type BreakdownEvidenceWindow = Pick<EvidenceScope, "from" | "to" | "split" | "currentHours">;

interface RiskBreakdownSheetProps {
  /** Row to explain; the sheet is open while this is set */
  row: RiskRow | undefined;
  /** Scoring window of the run the row came from */
  window: string;
  /** Run window for the per-service evidence; without it no evidence sections are shown */
  evidence?: BreakdownEvidenceWindow;
  clusterLabel: (uid: string) => string;
  onDismiss: () => void;
}

interface CompositionRow {
  key: SignalKey;
  name: string;
  weight: number;
  signal: number;
  points: number;
  maxPoints: number;
  isDriver: boolean;
}

interface MetricRow {
  metric: string;
  value: string;
}

interface MetricSection {
  key: SignalKey;
  title: string;
  /** How the raw metrics map to the 0–1 signal (mirrors api/risk/engine.ts) */
  howScored: string;
  rows: MetricRow[];
  /** Per-service charts/tables shown under the metrics, each in a collapsed (lazily queried) section */
  evidence?: EvidenceDef[];
}

const SIGNAL_NAMES: Record<SignalKey, string> = {
  err: "Errors",
  lat: "Latency",
  sat: "Saturation",
  chg: "Change recency",
  davis: "Davis problems",
};

const EDGE_COLORS: Record<EdgeSource, "neutral" | "primary" | "warning"> = {
  "traced call": "neutral",
  database: "primary",
  "untraced (configured)": "warning",
};

const num = (v: number | null, unit = ""): string => (v === null ? "n/a" : `${v}${unit}`);

const COMPOSITION_COLUMNS: SimpleTableColumnDef<CompositionRow>[] = [
  {
    id: "name",
    header: "Signal",
    accessor: "name",
    cell: ({ rowData }) => (rowData.isDriver ? <Strong>{rowData.name} (primary driver)</Strong> : <Text>{rowData.name}</Text>),
  },
  { id: "weight", header: "Weight", accessor: "weight", alignment: "right" },
  { id: "signal", header: "Signal (0–1)", accessor: "signal", alignment: "right" },
  {
    id: "points",
    header: "Points",
    accessor: "points",
    cell: ({ rowData }) => (
      <ProgressBar
        value={rowData.points}
        max={rowData.maxPoints}
        density="condensed"
        color={rowData.isDriver ? "critical" : "primary"}
        aria-label={`${rowData.name}: ${rowData.points} of ${rowData.maxPoints} points`}
        aria-valuetext={`${rowData.points} of ${rowData.maxPoints} points`}
      >
        <ProgressBar.Value>{`${rowData.points} / ${rowData.maxPoints}`}</ProgressBar.Value>
      </ProgressBar>
    ),
  },
];

const METRIC_COLUMNS: SimpleTableColumnDef<MetricRow>[] = [
  { id: "metric", header: "Metric", accessor: "metric" },
  { id: "value", header: "Value", accessor: "value" },
];

const DependencyChips = ({ items, label }: { items: RiskDependency[]; label: string }) =>
  items.length ? (
    <ChipGroup aria-label={label}>
      {items.map((d) => (
        <Chip key={d.service} color={EDGE_COLORS[d.via]} size="condensed">
          {d.service}
          <Chip.Suffix>{d.via}</Chip.Suffix>
        </Chip>
      ))}
      <ChipGroup.Control count />
    </ChipGroup>
  ) : (
    <Text>None</Text>
  );

/**
 * Shows how one row's risk score was built, from data the engine already computed. Opening the sheet runs no
 * queries; the per-service evidence sections query Grail only when the user expands them.
 */
export const RiskBreakdownSheet = ({ row, window, evidence, clusterLabel, onDismiss }: RiskBreakdownSheetProps) => {
  const b = row?.breakdown;
  const traced = row?.coverage === "traces+metrics+logs";

  const evidenceScope = useMemo<EvidenceScope | undefined>(
    () =>
      row && evidence
        ? {
            clusterUid: row.cluster,
            // The engine strips the namespace prefix from the workload name (api/risk/engine.ts, row.service)
            workload: `${RISK_CONFIG.namespace}-${row.service}`,
            ...evidence,
          }
        : undefined,
    [row, evidence],
  );

  const composition = useMemo<CompositionRow[]>(() => {
    if (!b) return [];
    const top = Math.max(...b.components.map((c) => c.points));
    return b.components.map((c) => ({
      key: c.key,
      name: SIGNAL_NAMES[c.key],
      weight: c.weight,
      signal: c.signal,
      points: c.points,
      maxPoints: Math.round(c.weight * 100),
      isDriver: top > 0 && c.points === top,
    }));
  }, [b]);

  const sections = useMemo<MetricSection[]>(() => {
    if (!b) return [];
    const { errors: e, latency: l, saturation: s, change: c } = b;
    return [
      {
        key: "err",
        title: SIGNAL_NAMES.err,
        howScored:
          "0.7 × request part + 0.3 × min(1, log z⁺ / 3). Request part = 0.5 × min(1, failure z⁺ / 3) + 0.5 × min(1, failure rate / 1 %).",
        rows: [
          { metric: "Requests (baseline → now)", value: `${e.reqBase} → ${e.reqNow}` },
          { metric: "Failure rate (baseline → now)", value: `${e.failRateBasePct} % → ${e.failRateNowPct} %` },
          { metric: "Failure-rate z-score", value: String(e.z) },
          { metric: "Request part of the signal", value: String(e.reqSignal) },
          { metric: "Error log lines (baseline → now)", value: `${e.logBase} → ${e.logNow}` },
          { metric: "Error log lines expected now (λ)", value: String(e.logExpected) },
          { metric: "Log-error z-score", value: String(e.zLog) },
        ],
        // Trace-based evidence would be empty for services without traces
        evidence: traced ? [EVIDENCE.failRate, EVIDENCE.failuresByEndpoint, EVIDENCE.logSamples] : [EVIDENCE.logSamples],
      },
      {
        key: "lat",
        title: SIGNAL_NAMES.lat,
        howScored: "min(1, log₂(p95 now / p95 baseline)); a doubled p95 is the full signal, no change or faster is 0.",
        rows: [
          { metric: "p95 response time (baseline → now)", value: `${num(l.p95BaseMs, " ms")} → ${num(l.p95NowMs, " ms")}` },
          { metric: "p95 ratio (now / baseline)", value: num(l.ratio, "×") },
          { metric: "p95 trend over the whole window", value: l.trendWindow },
          { metric: "p95 trend in the compare window", value: l.trendNow },
        ],
        evidence: traced ? [EVIDENCE.p95] : [],
      },
      {
        key: "sat",
        title: SIGNAL_NAMES.sat,
        howScored:
          `min(1, 0.4 × CPU + 0.4 × memory growth + 0.5 if any OOM kill in ${RISK_CONFIG.oomHistoryDays}d). ` +
          "CPU and memory growth are min-max normalized across the cluster's services.",
        rows: [
          { metric: "CPU (compare window, summed over pods)", value: `${s.cpuPct} % (normalized ${s.cpuNorm})` },
          { metric: "Memory growth over the window", value: `${s.memGrowthPct} % (normalized ${s.memNorm})` },
          { metric: `OOM kills (${RISK_CONFIG.oomHistoryDays}d)`, value: String(s.oomKills) },
          { metric: "Hosts", value: s.hosts.length ? s.hosts.join(", ") : "n/a" },
        ],
      },
      {
        key: "chg",
        title: SIGNAL_NAMES.chg,
        howScored: `e^(−hours since change / ${RISK_CONFIG.changeDecayHours}h): 1 right after a change, about 0.37 after ${RISK_CONFIG.changeDecayHours}h.`,
        rows: [
          { metric: "Hours since last change", value: `${c.hoursAgo} h` },
          { metric: "Most recent change", value: c.source },
        ],
      },
      {
        key: "davis",
        title: SIGNAL_NAMES.davis,
        howScored:
          "Strongest matching problem wins. On the service: 1 active, 0.6 closed in the compare window, 0.3 earlier. " +
          `On its host or cluster: ${RISK_CONFIG.infraProblemWeight} active, ${RISK_CONFIG.infraProblemWeight / 2} recently closed.`,
        rows: b.davis.length
          ? b.davis.map((d) => ({
              metric: `${d.displayId} (${d.match})`,
              value: `${d.name || "Unnamed problem"} · ${d.status || "unknown status"} · signal ${d.weight}`,
            }))
          : [{ metric: "Problems", value: "No matching Davis problem in the window" }],
      },
    ];
  }, [b, traced]);

  // Only shown when capped; otherwise the row's own score is displayed (avoids rounding drift from basePoints).
  const uncapped = b ? Math.round(b.basePoints * b.multiplier) : 0;

  return (
    <Sheet
      title={row ? `Risk breakdown: ${row.service}` : "Risk breakdown"}
      show={!!row}
      onDismiss={onDismiss}
      actions={<Button onClick={onDismiss}>Close</Button>}
    >
      {row && b && (
        <Flex flexDirection="column" gap={24}>
          {/* Summary */}
          <Flex gap={32} alignItems="center" flexWrap="wrap">
            <Flex flexDirection="column" gap={0}>
              <Text>Risk score</Text>
              <Heading level={1}>{row.score}</Heading>
            </Flex>
            <Flex flexDirection="column" gap={4}>
              <Text>
                <Strong>Status:</Strong> {row.status} · <Strong>Rank:</Strong> #{row.rank}
              </Text>
              <Text>
                <Strong>Cluster:</Strong> {clusterLabel(row.cluster)} · <Strong>Coverage:</Strong> {row.coverage}
              </Text>
              <Text>
                <Strong>Window:</Strong> {window}
              </Text>
            </Flex>
          </Flex>
          {row.coverage !== "traces+metrics+logs" && (
            <MessageContainer variant="neutral">
              <MessageContainer.Description>
                No traces for this service: request failure and latency signals are missing, and blast radius
                relies on configured and database edges only.
              </MessageContainer.Description>
            </MessageContainer>
          )}

          {/* Score composition */}
          <Flex flexDirection="column" gap={8}>
            <Heading level={4}>Score composition</Heading>
            <SimpleTable data={composition} columns={COMPOSITION_COLUMNS} variant={{ rowDensity: "condensed" }} />
            <Paragraph>
              Base {b.basePoints} points × blast-radius multiplier {b.multiplier} ={" "}
              {b.capped ? `${uncapped}, capped at 100` : row.score}. Points = 100 × weight × signal.
            </Paragraph>
          </Flex>

          {/* Blast radius */}
          <Flex flexDirection="column" gap={8}>
            <Heading level={4}>Blast radius</Heading>
            <Paragraph>
              <Strong>{b.blast.tier}</Strong> (blast {b.blast.value}, multiplier ×{b.multiplier}).{" "}
              {b.blast.isEntrypoint
                ? "This is an entry point, so every request depends on it and blast radius is fixed at 1."
                : `0.5 × ${b.blast.dependents}/${b.blast.maxDependents} dependents + 0.5 × ${b.blast.traceSharePct} %/${b.blast.maxTraceSharePct} % trace share (each relative to the cluster maximum).`}
            </Paragraph>
            <Surface padding={12}>
              <Flex flexDirection="column" gap={12}>
                <Flex flexDirection="column" gap={4}>
                  <Strong>Called by ({b.blast.callers.length})</Strong>
                  <DependencyChips items={b.blast.callers} label="Direct callers" />
                </Flex>
                <Flex flexDirection="column" gap={4}>
                  <Strong>Depends on ({b.blast.callees.length})</Strong>
                  <DependencyChips items={b.blast.callees} label="Direct dependencies" />
                </Flex>
                <Flex flexDirection="column" gap={4}>
                  <Strong>Affected if this service fails ({b.blast.transitiveDependents.length})</Strong>
                  {b.blast.transitiveDependents.length ? (
                    <ChipGroup aria-label="Transitive dependents">
                      {b.blast.transitiveDependents.map((s) => (
                        <Chip key={s} size="condensed">
                          {s}
                        </Chip>
                      ))}
                      <ChipGroup.Control count />
                    </ChipGroup>
                  ) : (
                    <Text>None</Text>
                  )}
                </Flex>
              </Flex>
            </Surface>
          </Flex>

          {/* Metrics behind each signal */}
          <Flex flexDirection="column" gap={16}>
            <Heading level={4}>Metrics used</Heading>
            {sections.map((sec) => (
              <Flex key={sec.key} flexDirection="column" gap={4}>
                <Heading level={5}>{sec.title}</Heading>
                <Text>{sec.howScored}</Text>
                <SimpleTable data={sec.rows} columns={METRIC_COLUMNS} variant={{ rowDensity: "condensed" }} />
                {evidenceScope && !!sec.evidence?.length && (
                  // Sections start collapsed and are not kept mounted, so each query runs only once expanded.
                  <Accordion multiple size="condensed" aria-label={`${sec.title} evidence`}>
                    {sec.evidence.map((def) => (
                      <Accordion.Section key={def.id} id={def.id}>
                        <Accordion.SectionLabel>{def.title(evidenceScope)}</Accordion.SectionLabel>
                        <Accordion.SectionContent>
                          <MetricTile def={def} scope={evidenceScope} bare />
                        </Accordion.SectionContent>
                      </Accordion.Section>
                    ))}
                  </Accordion>
                )}
              </Flex>
            ))}
          </Flex>
        </Flex>
      )}
    </Sheet>
  );
};
