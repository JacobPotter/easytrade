import React, { useMemo } from "react";

import { Flex, Grid } from "@dynatrace/strato-components/layouts";
import { Text } from "@dynatrace/strato-components/typography";

import { MetricTile } from "../components/MetricTile";
import { METRIC_TILES, metricScope, type MetricTileDef } from "../risk/metricsQueries";
import { useRiskFilters } from "../risk/RiskFiltersContext";

const byId = (id: string): MetricTileDef => {
  const def = METRIC_TILES.find((t) => t.id === id);
  if (!def) throw new Error(`Unknown metric tile "${id}"`);
  return def;
};

const SINGLE_VALUES = ["activeProblems", "failPct", "ingressP95"].map(byId);
const CHARTS = ["p95ByService", "failRateByService"].map(byId);
const TABLES = ["failuresByEndpoint", "logErrors"].map(byId);
const DAVIS = byId("davisProblems");

/** Context metrics from the High-Risk Service Leaderboard dashboard, scoped by the app-wide filter bar. */
export const RiskMetrics = () => {
  const { params, clusterLabel } = useRiskFilters();
  const scope = useMemo(() => metricScope(params), [params]);
  const scopeText = params.clusters.length ? params.clusters.map(clusterLabel).join(", ") : "all clusters";

  return (
    <Flex flexDirection="column" gap={16}>
      <Text>
        Scope: {scopeText} · baseline last {params.lookbackHours}h, compare last {params.currentHours}h · Davis
        problem tiles are not cluster-scoped
      </Text>

      <Grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap={16} flexShrink={0}>
        {SINGLE_VALUES.map((def) => (
          <MetricTile key={def.id} def={def} scope={scope} />
        ))}
      </Grid>
      <Grid gridTemplateColumns="repeat(auto-fit, minmax(420px, 1fr))" gap={16} flexShrink={0}>
        {CHARTS.map((def) => (
          <MetricTile key={def.id} def={def} scope={scope} />
        ))}
      </Grid>
      <Grid gridTemplateColumns="repeat(auto-fit, minmax(420px, 1fr))" gap={16} flexShrink={0}>
        {TABLES.map((def) => (
          <MetricTile key={def.id} def={def} scope={scope} />
        ))}
      </Grid>
      <Flex flexDirection="column" flexShrink={0}>
        <MetricTile def={DAVIS} scope={scope} />
      </Flex>
    </Flex>
  );
};
