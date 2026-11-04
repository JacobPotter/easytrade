import React, { useMemo } from "react";

import { HoneycombChart } from "@dynatrace/strato-components/charts";
import Colors from "@dynatrace/strato-design-tokens/colors";

import type { RiskRow } from "../risk/riskContract";

/**
 * Tile color per Status label. Keys must match the status labels set in `api/risk/engine.ts`
 * (and used by the Risk Leaderboard dashboard tile), emoji included.
 */
export const STATUS_COLORS: Record<string, string> = {
  "🔴 Broken": Colors.Charts.Status.Critical.Default,
  "🟠 Deteriorating": Colors.Charts.Loglevel.Severe.Default, // Charts.Status has no orange
  "🟡 Watch": Colors.Charts.Status.Warning.Default,
  "🟢 Recovering": Colors.Charts.Status.Ideal.Default,
  "⚪ Stable": Colors.Charts.Status.Neutral.Default,
};

interface RiskHoneycombProps {
  rows: RiskRow[];
  loading: boolean;
  multiCluster: boolean;
  clusterLabel: (uid: string) => string;
}

/** One tile per leaderboard row: name and score inside, colored by the row's Status. */
export const RiskHoneycomb = ({ rows, loading, multiCluster, clusterLabel }: RiskHoneycombProps) => {
  const data = useMemo(
    () =>
      rows.map((r) => ({
        name: multiCluster ? `${r.service} (${clusterLabel(r.cluster)})` : r.service,
        value: r.score,
        status: r.status,
      })),
    [rows, multiCluster, clusterLabel],
  );

  return (
    <HoneycombChart data={data} labelsDisplay="all" textSize="auto" loading={loading} height={240}>
      {Object.entries(STATUS_COLORS).map(([status, color]) => (
        <HoneycombChart.ColorRule
          key={status}
          valueAccessor="status"
          comparator="equals"
          matchValue={status}
          color={color}
        />
      ))}
      {/* A numeric legend would show a score gradient, not the status colors; the Status column explains them */}
      <HoneycombChart.Legend hidden />
    </HoneycombChart>
  );
};
