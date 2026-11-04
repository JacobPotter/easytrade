import React from "react";

import { Flex } from "@dynatrace/strato-components/layouts";

import { RiskFilterBar } from "../components/RiskFilterBar";
import { RiskFiltersProvider } from "../risk/RiskFiltersContext";
import { Leaderboard } from "./Leaderboard";

/**
 * App home: the filter bar (clusters + windows) above the leaderboard.
 * Per-service evidence (charts, failing endpoints, error logs) lives in each row's Risk Breakdown sheet.
 */
export const RiskSignals = () => {
  return (
    <RiskFiltersProvider>
      <Flex flexDirection="column" padding={32} gap={16}>
        <RiskFilterBar />
        <Leaderboard />
      </Flex>
    </RiskFiltersProvider>
  );
};
