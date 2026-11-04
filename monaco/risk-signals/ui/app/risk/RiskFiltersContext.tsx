import React, { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from "react";

import { useDql } from "@dynatrace-sdk/react-hooks";

import { str } from "./dql";
import { DEFAULT_RISK_PARAMS, RISK_CONFIG, validateRiskParams, type RiskParams } from "./engine";

/** A named baseline / compare window pair. Presets replace free-form windows (fewer combinations, no constraints to explain). */
export interface WindowPreset {
  id: "default" | "recent-incident" | "slow-regression";
  /** Shown in the Select */
  label: string;
  /** Shown under the option */
  description: string;
  /** Baseline window in hours, including the compare window */
  lookbackHours: number;
  /** Compare window in hours */
  currentHours: number;
  /** Approximate leaderboard Grail scan for one cluster, relative to the 24h default (scan scales with lookback) */
  costHint?: string;
}

export const WINDOW_PRESETS = [
  {
    id: "default",
    label: `Default · ${RISK_CONFIG.lookbackHours}h baseline / last ${RISK_CONFIG.currentHours}h`,
    description:
      "Balanced: a full day of baseline covers the daily traffic cycle, and 2h of recent data (8 points) gives a stable trend that still reacts within hours",
    // Read from RISK_CONFIG so the app default and the dashboard parity values cannot drift apart
    lookbackHours: RISK_CONFIG.lookbackHours,
    currentHours: RISK_CONFIG.currentHours,
  },
  {
    id: "recent-incident",
    label: "Recent incident · 6h / last 1h",
    description: "Surfaces short spikes, e.g. right after toggling a problem pattern",
    lookbackHours: 6,
    currentHours: 1,
  },
  {
    id: "slow-regression",
    label: "Slow regression · 48h / last 6h",
    description: "Catches degradation that built up over hours",
    lookbackHours: 48,
    currentHours: 6,
    costHint: "≈2× Grail scan",
  },
] as const satisfies readonly WindowPreset[];

export type WindowPresetId = WindowPreset["id"];
export const DEFAULT_PRESET_ID: WindowPresetId = "default";

// Fail fast on a bad preset edit instead of at query time.
for (const p of WINDOW_PRESETS) {
  const invalid = validateRiskParams({ clusters: [], lookbackHours: p.lookbackHours, currentHours: p.currentHours });
  if (invalid) {
    const msg = `Window preset "${p.id}" is invalid: ${invalid}`;
    if (process.env.NODE_ENV !== "production") throw new Error(msg);
    console.error(msg);
  }
}

/** Preset matching the given windows (undefined if none matches). */
export function findPreset(p: Pick<RiskParams, "lookbackHours" | "currentHours">): WindowPreset | undefined {
  return WINDOW_PRESETS.find((w) => w.lookbackHours === p.lookbackHours && w.currentHours === p.currentHours);
}

export const DEFAULT_PRESET: WindowPreset = WINDOW_PRESETS[0];

/** Preset name without the windows suffix, e.g. "Recent incident" */
export const presetName = (p: WindowPreset): string => p.label.split(" · ")[0];

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
  /** Active window preset, derived from params (single source of truth) */
  preset: WindowPreset;
  setPreset: (id: WindowPresetId) => void;
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

  // params only ever take preset hours; fall back to Default defensively.
  const preset = findPreset(params) ?? DEFAULT_PRESET;

  const value = useMemo<RiskFiltersValue>(
    () => ({
      params,
      setClusters: (clusters) => setParams((p) => ({ ...p, clusters })),
      preset,
      // Presets are valid by construction (checked at startup), so no clamping is needed.
      setPreset: (id) => {
        const next = WINDOW_PRESETS.find((w) => w.id === id);
        if (next) setParams((p) => ({ ...p, lookbackHours: next.lookbackHours, currentHours: next.currentHours }));
      },
      reset: () => setParams(DEFAULT_RISK_PARAMS),
      clusterOptions,
      clusterOptionsLoading: options.isLoading,
      clusterOptionsError: options.error,
      clusterLabel,
    }),
    [params, preset, clusterOptions, options.isLoading, options.error, clusterLabel],
  );

  return <RiskFiltersContext.Provider value={value}>{children}</RiskFiltersContext.Provider>;
};

export function useRiskFilters(): RiskFiltersValue {
  const ctx = useContext(RiskFiltersContext);
  if (!ctx) throw new Error("useRiskFilters must be used inside <RiskFiltersProvider>");
  return ctx;
}
