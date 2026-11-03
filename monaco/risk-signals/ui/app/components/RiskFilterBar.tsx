import React from "react";

import { FilterBar } from "@dynatrace/strato-components/filters";
import { Select } from "@dynatrace/strato-components/forms";

import { BASELINE_OPTIONS, COMPARE_OPTIONS, useRiskFilters } from "../risk/RiskFiltersContext";

/** App-wide scope: clusters (none = all) and the baseline / compare windows. Applies to every tab. */
export const RiskFilterBar = () => {
  const { params, setClusters, setLookbackHours, setCurrentHours, reset, clusterOptions, clusterOptionsLoading } =
    useRiskFilters();

  return (
    <FilterBar
      onFilterChange={() => {
        /* Each Select is controlled and writes to RiskFiltersContext directly */
      }}
    >
      <FilterBar.Item name="clusters" label="Kubernetes cluster">
        <Select<string, true>
          multiple
          clearable
          value={[...params.clusters]}
          onChange={(v) => setClusters(v)}
        >
          <Select.Trigger placeholder={clusterOptionsLoading ? "Loading clusters…" : "All clusters"} />
          <Select.Content>
            {clusterOptions.map((c) => (
              <Select.Option key={c.uid} value={c.uid}>
                {c.label}
              </Select.Option>
            ))}
          </Select.Content>
        </Select>
      </FilterBar.Item>
      <FilterBar.Item name="baseline" label="Baseline window">
        <Select<number, false>
          value={params.lookbackHours}
          onChange={(v) => {
            if (v !== null) setLookbackHours(v);
          }}
        >
          <Select.Content>
            {BASELINE_OPTIONS.map((h) => (
              <Select.Option key={h} value={h}>
                {`Last ${h}h`}
              </Select.Option>
            ))}
          </Select.Content>
        </Select>
      </FilterBar.Item>
      <FilterBar.Item name="compare" label="Compare window">
        <Select<number, false>
          value={params.currentHours}
          onChange={(v) => {
            if (v !== null) setCurrentHours(v);
          }}
        >
          <Select.Content>
            {COMPARE_OPTIONS.map((h) => (
              <Select.Option key={h} value={h} disabled={h * 2 > params.lookbackHours}>
                {`Last ${h}h`}
              </Select.Option>
            ))}
          </Select.Content>
        </Select>
      </FilterBar.Item>
      <FilterBar.ResetButton onClick={reset} />
    </FilterBar>
  );
};
