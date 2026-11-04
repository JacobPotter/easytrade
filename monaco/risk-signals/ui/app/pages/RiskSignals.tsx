import React, { useMemo } from "react";

import { Button } from "@dynatrace/strato-components/buttons";
import { InformationOverlay, MessageContainer } from "@dynatrace/strato-components/content";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph, Text } from "@dynatrace/strato-components/typography";
import { RefreshIcon } from "@dynatrace/strato-icons";

import { RiskFilterBar } from "../components/RiskFilterBar";
import { RiskHoneycomb } from "../components/RiskHoneycomb";
import { RISK_CONFIG, type RiskParams } from "../risk/riskContract";
import {
  DEFAULT_PRESET,
  DEFAULT_PRESET_ID,
  presetName,
  RiskFiltersProvider,
  useRiskFilters,
  type WindowPreset,
} from "../risk/RiskFiltersContext";
import { useRiskLeaderboard } from "../risk/useRiskLeaderboard";
import { Leaderboard } from "./Leaderboard";

const w = RISK_CONFIG.weights;
const windowText = (p: Pick<WindowPreset, "lookbackHours" | "currentHours">) =>
  `${p.lookbackHours}h / last ${p.currentHours}h`;

const modelSummary = (p: RiskParams, preset: WindowPreset) =>
  `${presetName(preset)} window. Composite 0–100 risk per service and cluster: errors ${w.err} · latency ${w.lat} · saturation ${w.sat} · ` +
  `change recency ${w.chg} · Davis ${w.davis}, × blast-radius multiplier (1–1.5). ` +
  `Baseline = ${p.lookbackHours}h→${p.currentHours}h ago, current = last ${p.currentHours}h. ` +
  `Each cluster is scored on its own (normalization and blast radius stay within the cluster).`;

/** Page body. Needs the filter context, so it renders inside RiskFiltersProvider. */
const RiskSignalsContent = () => {
  const { params, preset, clusterLabel } = useRiskFilters();
  // One scoring run (~0.8 GB scan) feeds both the honeycomb and the leaderboard table.
  const leaderboard = useRiskLeaderboard(params);
  const { data, error, isLoading, refresh } = leaderboard;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const multiCluster = (data?.clusters.length ?? 0) > 1;

  return (
    <Flex flexDirection="column" padding={32} gap={16}>
      <RiskFilterBar />

      <Flex justifyContent="space-between" alignItems="flex-start">
        <Flex flexDirection="column" gap={4}>
          <Flex alignItems="center" gap={8}>
            <Heading level={2}>Service Risk Signals</Heading>
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

      {/* Empty finished results are covered by the table's empty state */}
      {(isLoading || rows.length > 0) && (
        <RiskHoneycomb rows={rows} loading={isLoading} multiCluster={multiCluster} clusterLabel={clusterLabel} />
      )}

      <Leaderboard leaderboard={leaderboard} />
    </Flex>
  );
};

/**
 * App home: the filter bar (clusters + windows), the page header with Refresh, the status honeycomb and the
 * leaderboard table. Both views share one scoring run.
 * Per-service evidence (charts, failing endpoints, error logs) lives in each row's Risk Breakdown sheet.
 */
export const RiskSignals = () => (
  <RiskFiltersProvider>
    <RiskSignalsContent />
  </RiskFiltersProvider>
);
