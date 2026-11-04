import React from "react";

import { Chip } from "@dynatrace/strato-components/content";
import { FilterBar } from "@dynatrace/strato-components/filters";
import { Select } from "@dynatrace/strato-components/forms";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Tooltip } from "@dynatrace/strato-components/overlays";
import { Text } from "@dynatrace/strato-components/typography";

import { WINDOW_PRESETS, useRiskFilters, type WindowPreset, type WindowPresetId } from "../risk/RiskFiltersContext";

/** App-wide scope: clusters (none = all) and the scoring window preset. Applies to every tab. */
export const RiskFilterBar = () => {
  const { params, setClusters, preset, setPreset, reset, clusterOptions, clusterOptionsLoading } = useRiskFilters();

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
      <FilterBar.Item name="window" label="Scoring window">
        <Select<WindowPresetId, false>
          value={preset.id}
          onChange={(v) => {
            if (v !== null) setPreset(v);
          }}
        >
          <Select.Trigger>
            <Select.DisplayValue>{preset.label}</Select.DisplayValue>
          </Select.Trigger>
          {/* Wider than the trigger so the cost-hint Chip is not clipped */}
          <Select.Content width="max-content">
            {/* Select.Option has no description slot; show it as a tooltip */}
            {WINDOW_PRESETS.map((w: WindowPreset) => (
              <Select.Option key={w.id} value={w.id} textValue={w.label}>
                <Tooltip text={w.description} placement="right">
                  <Flex alignItems="center" gap={8} width="100%">
                    <Text>{w.label}</Text>
                    {w.costHint && <Chip size="condensed">{w.costHint}</Chip>}
                  </Flex>
                </Tooltip>
              </Select.Option>
            ))}
          </Select.Content>
        </Select>
      </FilterBar.Item>
      <FilterBar.ResetButton onClick={reset} />
    </FilterBar>
  );
};
