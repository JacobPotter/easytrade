import React, { useMemo } from "react";

import { Button } from "@dynatrace/strato-components/buttons";
import { InformationOverlay, MessageContainer } from "@dynatrace/strato-components/content";
import { Flex } from "@dynatrace/strato-components/layouts";
import {
  DataTable,
  type DataTableColumnDef,
  type DataTableColumnSort,
  type DataTableColumnVisibilityState,
} from "@dynatrace/strato-components/tables";
import { Heading, Paragraph, Text } from "@dynatrace/strato-components/typography";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { RefreshIcon } from "@dynatrace/strato-icons";

import { RISK_CONFIG, type RiskParams, type RiskRow } from "../risk/engine";
import { useRiskFilters } from "../risk/RiskFiltersContext";
import { useRiskLeaderboard } from "../risk/useRiskLeaderboard";

const w = RISK_CONFIG.weights;
const modelSummary = (p: RiskParams) =>
  `Composite 0–100 risk per service and cluster: errors ${w.err} · latency ${w.lat} · saturation ${w.sat} · ` +
  `change recency ${w.chg} · Davis ${w.davis}, × blast-radius multiplier (1–1.5). ` +
  `Baseline = ${p.lookbackHours}h→${p.currentHours}h ago, current = last ${p.currentHours}h. ` +
  `Each cluster is scored on its own (normalization and blast radius stay within the cluster).`;

/** Rank is hidden but stays the default sort (rank 1 = highest risk first). */
const DEFAULT_SORT: DataTableColumnSort[] = [{ id: "rank", desc: false }];

export const Leaderboard = () => {
  const { params, clusterLabel } = useRiskFilters();
  const { data, error, isLoading, runId, refresh } = useRiskLeaderboard(params);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  // The Cluster column only adds information when more than one cluster was scored.
  const multiCluster = (data?.clusters.length ?? 0) > 1;
  const defaultVisibility = useMemo<DataTableColumnVisibilityState>(
    () => ({ rank: false, cluster: multiCluster }),
    [multiCluster],
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
            <Heading level={2}>High-Risk Service Leaderboard</Heading>
            <InformationOverlay aria-label="How the risk score is calculated">
              <InformationOverlay.Content>
                <Paragraph>{modelSummary(params)}</Paragraph>
              </InformationOverlay.Content>
            </InformationOverlay>
          </Flex>
          {data && (
            <Text>
              {data.clusters.length
                ? `${data.clusters.length === 1 ? "Cluster" : "Clusters"}: ${data.clusters.map(clusterLabel).join(", ")}`
                : "No cluster had data in the window"}{" "}
              · window {data.window}
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
        <DataTable.EmptyState>
          {error ? "No data: see the error above." : "No services scored yet."}
        </DataTable.EmptyState>
      </DataTable>
    </Flex>
  );
};
