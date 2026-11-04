import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@dynatrace/strato-components/buttons";
import {
  InformationOverlay,
  Markdown,
  MessageContainer,
  ProgressCircle,
} from "@dynatrace/strato-components/content";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Menu } from "@dynatrace/strato-components/navigation";
import { Sheet } from "@dynatrace/strato-components/overlays";
import {
  DataTable,
  type DataTableColumnDef,
  type DataTableColumnSort,
  type DataTableColumnVisibilityState,
} from "@dynatrace/strato-components/tables";
import { Heading, Paragraph, Text } from "@dynatrace/strato-components/typography";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { AiIcon, AnalyticsIcon, RefreshIcon } from "@dynatrace/strato-icons";

import { RiskBreakdownSheet, type BreakdownEvidenceWindow } from "../components/RiskBreakdownSheet";

import { analyzeServiceRisk, toRiskPayload } from "../risk/analysis";
import { RISK_CONFIG, type RiskParams, type RiskRow } from "../risk/engine";
import { DEFAULT_PRESET, DEFAULT_PRESET_ID, presetName, useRiskFilters, type WindowPreset } from "../risk/RiskFiltersContext";
import { useRiskLeaderboard } from "../risk/useRiskLeaderboard";

const w = RISK_CONFIG.weights;
const windowText = (p: Pick<WindowPreset, "lookbackHours" | "currentHours">) =>
  `${p.lookbackHours}h / last ${p.currentHours}h`;

const modelSummary = (p: RiskParams, preset: WindowPreset) =>
  `${presetName(preset)} window. Composite 0–100 risk per service and cluster: errors ${w.err} · latency ${w.lat} · saturation ${w.sat} · ` +
  `change recency ${w.chg} · Davis ${w.davis}, × blast-radius multiplier (1–1.5). ` +
  `Baseline = ${p.lookbackHours}h→${p.currentHours}h ago, current = last ${p.currentHours}h. ` +
  `Each cluster is scored on its own (normalization and blast radius stay within the cluster).`;

/** Rank is hidden but stays the default sort (rank 1 = highest risk first). */
const DEFAULT_SORT: DataTableColumnSort[] = [{ id: "rank", desc: false }];

export const Leaderboard = () => {
  const { params, preset, clusterLabel } = useRiskFilters();
  const { data, error, isLoading, runId, refresh } = useRiskLeaderboard(params);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  // The Cluster column only adds information when more than one cluster was scored.
  const multiCluster = (data?.clusters.length ?? 0) > 1;
  const defaultVisibility = useMemo<DataTableColumnVisibilityState>(
    () => ({ rank: false, cluster: multiCluster }),
    [multiCluster],
  );

  // Davis AI analysis sheet
  const [isOverlayOpen, setIsOverlayOpen] = useState(false);
  const [analysisResult, setAnalysisResult] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<Error>();
  const [analyzedRow, setAnalyzedRow] = useState<RiskRow>();
  const analysisController = useRef<AbortController | null>(null);

  // Risk breakdown sheet: the row plus the window of the run it came from, so a refresh keeps the snapshot consistent
  const [breakdown, setBreakdown] = useState<{ row: RiskRow; window: string; evidence: BreakdownEvidenceWindow }>();
  const closeBreakdown = useCallback(() => setBreakdown(undefined), []);

  const onAnalyze = useCallback(
    (row: RiskRow) => {
      setBreakdown(undefined); // one sheet at a time
      analysisController.current?.abort();
      const ac = new AbortController();
      analysisController.current = ac;
      setAnalyzedRow(row);
      setAnalysisResult("");
      setAnalysisError(undefined);
      setIsAnalyzing(true);
      setIsOverlayOpen(true);

      analyzeServiceRisk(toRiskPayload(row, clusterLabel(row.cluster)), ac.signal)
        .then((text) => {
          if (!ac.signal.aborted) setAnalysisResult(text);
        })
        .catch((err: unknown) => {
          if (ac.signal.aborted) return;
          console.error("Davis AI risk analysis failed", err);
          setAnalysisError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          if (!ac.signal.aborted) setIsAnalyzing(false);
        });
    },
    [clusterLabel],
  );

  const closeAnalysis = useCallback(() => {
    analysisController.current?.abort();
    setIsAnalyzing(false);
    setIsOverlayOpen(false);
  }, []);

  useEffect(() => () => analysisController.current?.abort(), []);

  const onBreakdown = useCallback(
    (row: RiskRow) => {
      if (!data) return;
      closeAnalysis(); // one sheet at a time
      // Pin the evidence queries to this run's window (not "now"), so the charts match the scores.
      const end = data.computedAt.getTime();
      const { lookbackHours, currentHours } = data.params;
      setBreakdown({
        row,
        window: data.window,
        evidence: {
          from: new Date(end - lookbackHours * 3600000).toISOString(),
          to: data.computedAt.toISOString(),
          split: new Date(end - currentHours * 3600000).toISOString(),
          currentHours,
        },
      });
    },
    [closeAnalysis, data],
  );

  const columns = useMemo<DataTableColumnDef<RiskRow>[]>(
    () => [
      { id: "status", header: "Status", accessor: "status", width: "content" },
      { id: "service", header: "Service Name", accessor: "service", width: "content" },
      { id: "cluster", header: "Cluster", accessor: (row) => clusterLabel(row.cluster), width: "content" },
      {
        id: "score",
        header: "Risk Score",
        accessor: "score",
        columnType: "number",
        width: "content",
        thresholds: [
          {
            comparator: "greater-than-or-equal-to",
            value: 70,
            color: Colors.Text.Critical.Default,
            backgroundColor: Colors.Background.Container.Critical.Default,
          },
          {
            rules: [
              { comparator: "greater-than-or-equal-to", value: 40 },
              { comparator: "less-than", value: 70 },
            ],
            color: Colors.Text.Warning.Default,
            backgroundColor: Colors.Background.Container.Warning.Default,
          },
        ],
      },
      { id: "primaryDriver", header: "Primary Driver", accessor: "primaryDriver", width: "content" },
      { id: "trendLast2h", header: "Trend Direction", accessor: "trendLast2h", width: "content" },
      { id: "blastRadius", header: "Blast Radius Impact", accessor: "blastRadius", width: "content" },
      // Hidden by default (see DEFAULT_VISIBILITY); kept so the table can sort by it
      { id: "rank", header: "Rank", accessor: "rank", columnType: "number", width: "content" },
    ],
    [clusterLabel],
  );

  return (
    <Flex flexDirection="column" gap={16}>
      <Flex justifyContent="space-between" alignItems="flex-start">
        <Flex flexDirection="column" gap={4}>
          <Flex alignItems="center" gap={8}>
            <Heading level={2}>Service Risk Leaderboard</Heading>
            <InformationOverlay aria-label="How the risk score is calculated">
              <InformationOverlay.Content>
                <Paragraph>{modelSummary(params, preset)}</Paragraph>
              </InformationOverlay.Content>
            </InformationOverlay>
          </Flex>
          {data && (
            <Text>
              {data.clusters.length
                ? `${data.clusters.length === 1 ? "Cluster" : "Clusters"}: ${data.clusters.map(clusterLabel).join(", ")}`
                : "No cluster had data in the window"}{" "}
              · {presetName(preset)} window {data.window}
            </Text>
          )}
        </Flex>
        <Button onClick={refresh} loading={isLoading} disabled={isLoading}>
          <Button.Prefix>
            <RefreshIcon />
          </Button.Prefix>
          Refresh
        </Button>
      </Flex>

      {preset.id !== DEFAULT_PRESET_ID && (
        <MessageContainer variant="neutral">
          <MessageContainer.Description>
            Scored with the <em>{presetName(preset)}</em> window ({windowText(preset)}): scores differ from the Risk
            Leaderboard dashboard, which uses {windowText(DEFAULT_PRESET)}.
            {preset.costHint && ` This window scans more data (${preset.costHint}).`}
          </MessageContainer.Description>
        </MessageContainer>
      )}

      {error && (
        <MessageContainer variant="critical">
          <MessageContainer.Title>Could not compute the leaderboard</MessageContainer.Title>
          <MessageContainer.Description>{error.message}</MessageContainer.Description>
        </MessageContainer>
      )}

      {/* width: "content" and the default visibility apply on first render only, so remount per result */}
      <DataTable
        key={runId}
        data={rows}
        columns={columns}
        loading={isLoading}
        sortable
        defaultSortBy={DEFAULT_SORT}
        defaultColumnVisibility={defaultVisibility}
        fullWidth
        lineWrap
        rowId={(row) => `${row.cluster}/${row.service}`}
      >
        {/* Row actions: add future per-row actions as Menu.Items here */}
        <DataTable.RowActions>
          {(row: RiskRow) => (
            <Menu>
              <Menu.Content>
                <Menu.Item onSelect={() => onBreakdown(row)}>
                  <Menu.Prefix>
                    <AnalyticsIcon />
                  </Menu.Prefix>
                  Risk Breakdown
                </Menu.Item>
                <Menu.Item onSelect={() => onAnalyze(row)}>
                  <Menu.Prefix>
                    <AiIcon />
                  </Menu.Prefix>
                  Analyze Risk
                </Menu.Item>
              </Menu.Content>
            </Menu>
          )}
        </DataTable.RowActions>
        <DataTable.EmptyState>
          {error ? "No data: see the error above." : "No services scored yet."}
        </DataTable.EmptyState>
      </DataTable>

      <Sheet
        title={analyzedRow ? `Risk analysis: ${analyzedRow.service}` : "Risk analysis"}
        show={isOverlayOpen}
        onDismiss={closeAnalysis}
        actions={<Button onClick={closeAnalysis}>Close</Button>}
      >
        {isAnalyzing ? (
          <Flex flexDirection="column" alignItems="center" gap={8} padding={32}>
            <ProgressCircle aria-label="Davis AI is analyzing the service risk" />
            <Text>Davis AI is analyzing the risk signals…</Text>
          </Flex>
        ) : analysisError ? (
          <MessageContainer variant="critical">
            <MessageContainer.Title>Risk analysis failed</MessageContainer.Title>
            <MessageContainer.Description>{analysisError.message}</MessageContainer.Description>
          </MessageContainer>
        ) : (
          <Markdown>{analysisResult}</Markdown>
        )}
      </Sheet>

      <RiskBreakdownSheet
        row={breakdown?.row}
        window={breakdown?.window ?? ""}
        evidence={breakdown?.evidence}
        clusterLabel={clusterLabel}
        onDismiss={closeBreakdown}
      />
    </Flex>
  );
};
