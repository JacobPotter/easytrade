import React, { useEffect, useMemo } from "react";

import { SingleValue, TimeseriesChart, convertToTimeseries } from "@dynatrace/strato-components/charts";
import { MessageContainer } from "@dynatrace/strato-components/content";
import { Flex, Surface } from "@dynatrace/strato-components/layouts";
import { DataTable, convertToColumns } from "@dynatrace/strato-components/tables";
import { Heading } from "@dynatrace/strato-components/typography";
import { useDql } from "@dynatrace-sdk/react-hooks";

import { toNum } from "../risk/dql";
import type { MetricScope, MetricTileDef } from "../risk/metricsQueries";

interface MetricTileProps {
  def: MetricTileDef;
  /** App-wide cluster scope and windows (from RiskFiltersContext) */
  scope: MetricScope;
}

const SINGLE_VALUE_HEIGHT = 80;
const CHART_HEIGHT = 280;
/** Tables scroll inside this height instead of growing the tile. */
const TABLE_HEIGHT = 360;

/** One dashboard tile: runs its DQL and renders it as a single value, line chart or table. */
export const MetricTile = ({ def, scope }: MetricTileProps) => {
  const title = def.title(scope);
  // useDql re-runs whenever the query text changes, i.e. when the filters change.
  const { data, error, isLoading } = useDql({ query: def.query(scope) });

  useEffect(() => {
    if (error) console.error(`Risk Metrics tile "${title}" failed`, error);
  }, [error, title]);

  const timeseries = useMemo(
    () => (def.kind === "line" && data ? convertToTimeseries(data.records, data.types) : []),
    [def.kind, data],
  );
  const columns = useMemo(
    () => (def.kind === "table" && data ? convertToColumns(data.types) : []),
    [def.kind, data],
  );

  const loading = isLoading || (!data && !error);

  let body: React.ReactNode;
  if (error) {
    body = (
      <MessageContainer variant="critical">
        <MessageContainer.Description>{error.message}</MessageContainer.Description>
      </MessageContainer>
    );
  } else if (def.kind === "single") {
    const raw = data && def.field ? toNum(data.records[0]?.[def.field]) : null;
    const value = raw === null ? "–" : Number(raw.toFixed(def.decimals ?? 1));
    body = <SingleValue data={value} loading={loading} height={SINGLE_VALUE_HEIGHT} />;
  } else if (def.kind === "line") {
    body = (
      <TimeseriesChart
        data={timeseries}
        loading={loading}
        variant="line"
        gapPolicy="connect"
        height={CHART_HEIGHT}
      />
    );
  } else {
    body = (
      <DataTable data={data?.records ?? []} columns={columns} loading={loading} sortable fullWidth resizable lineWrap>
        <DataTable.EmptyState>No records.</DataTable.EmptyState>
      </DataTable>
    );
  }

  // Every body gets a definite height. DataTable (height: 100%; min-height: 0) and SingleValue
  // (height: inherit) size from their parent, so without one they collapse and paint over the next row.
  const bodyHeight =
    def.kind === "single" ? SINGLE_VALUE_HEIGHT : def.kind === "line" ? CHART_HEIGHT : TABLE_HEIGHT;

  return (
    <Surface padding={16}>
      <Flex flexDirection="column" gap={8}>
        <Heading level={5}>{title}</Heading>
        <Flex flexDirection="column" height={error ? undefined : bodyHeight} flexShrink={0}>
          {body}
        </Flex>
      </Flex>
    </Surface>
  );
};
