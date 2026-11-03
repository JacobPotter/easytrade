import React, { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from "react";

import { useDql } from "@dynatrace-sdk/react-hooks";

import { str } from "./dql";
import { DEFAULT_RISK_PARAMS, RISK_CONFIG, type RiskParams } from "./engine";

/** Baseline window choices (hours, including the compare window). */
export const BASELINE_OPTIONS = [6, 12, 24, 48, 72] as const;
/** Compare window choices (hours). Must be ≤ half the baseline (see validateRiskParams). */
export const COMPARE_OPTIONS = [1, 2, 3, 4, 6] as const;

export interface ClusterOption {
  uid: string;
  name: string;
  /** "name · uid-prefix": names are not unique (several clusters report as "test-cluster") */
  label: string;
}

interface RiskFiltersValue {
  /** Scope shared by every tab. clusters = [] means all clusters. */
  params: RiskParams;
  setClusters: (clusters: string[]) => void;
  setLookbackHours: (hours: number) => void;
  setCurrentHours: (hours: number) => void;
  reset: () => void;
  /** Clusters running the namespace in the baseline window */
  clusterOptions: ClusterOption[];
  clusterOptionsLoading: boolean;
  clusterOptionsError: Error | null;
  /** Display label for a cluster uid (falls back to the uid prefix) */
  clusterLabel: (uid: string) => string;
}

const RiskFiltersContext = createContext<RiskFiltersValue | null>(null);

export const RiskFiltersProvider = ({ children }: PropsWithChildren) => {
  const [params, setParams] = useState<RiskParams>(DEFAULT_RISK_PARAMS);

  // Process metrics carry cluster uid + name and cost no Grail scan (checked 2026-11-03).
  const options = useDql(
    `timeseries cpu = avg(dt.process.cpu.usage), by:{k8s.cluster.uid, k8s.cluster.name}, ` +
      `filter: k8s.namespace.name == "${RISK_CONFIG.namespace}", from: now()-${params.lookbackHours}h, interval: 1h ` +
      `| fields k8s.cluster.uid, k8s.cluster.name`,
  );

  const clusterOptions = useMemo<ClusterOption[]>(() => {
    const byUid = new Map<string, ClusterOption>();
    for (const r of options.data?.records ?? []) {
      const uid = str(r, "k8s.cluster.uid");
      if (!uid) continue;
      const name = str(r, "k8s.cluster.name") ?? "unnamed";
      byUid.set(uid, { uid, name, label: `${name} · ${uid.slice(0, 8)}` });
    }
    return [...byUid.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [options.data]);

  const clusterLabel = useCallback(
    (uid: string) => clusterOptions.find((c) => c.uid === uid)?.label ?? uid.slice(0, 8),
    [clusterOptions],
  );

  const value = useMemo<RiskFiltersValue>(
    () => ({
      params,
      setClusters: (clusters) => setParams((p) => ({ ...p, clusters })),
      // Keep compare ≤ half the baseline: shrink it to the largest allowed choice when needed.
      setLookbackHours: (lookbackHours) =>
        setParams((p) => {
          const allowed = COMPARE_OPTIONS.filter((c) => c * 2 <= lookbackHours);
          const currentHours = p.currentHours * 2 <= lookbackHours ? p.currentHours : (allowed.at(-1) ?? 1);
          return { ...p, lookbackHours, currentHours };
        }),
      setCurrentHours: (currentHours) => setParams((p) => ({ ...p, currentHours })),
      reset: () => setParams(DEFAULT_RISK_PARAMS),
      clusterOptions,
      clusterOptionsLoading: options.isLoading,
      clusterOptionsError: options.error,
      clusterLabel,
    }),
    [params, clusterOptions, options.isLoading, options.error, clusterLabel],
  );

  return <RiskFiltersContext.Provider value={value}>{children}</RiskFiltersContext.Provider>;
};

export function useRiskFilters(): RiskFiltersValue {
  const ctx = useContext(RiskFiltersContext);
  if (!ctx) throw new Error("useRiskFilters must be used inside <RiskFiltersProvider>");
  return ctx;
}
