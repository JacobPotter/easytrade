import React from "react";

import { Flex } from "@dynatrace/strato-components/layouts";
import { Tab, Tabs } from "@dynatrace/strato-components/navigation";

import { RiskFilterBar } from "../components/RiskFilterBar";
import { RiskFiltersProvider } from "../risk/RiskFiltersContext";
import { Leaderboard } from "./Leaderboard";
import { RiskMetrics } from "./RiskMetrics";

/** App home: one filter bar (clusters + windows) shared by every tab, one tab per risk view. */
export const RiskSignals = () => {
  return (
    <RiskFiltersProvider>
      <Flex flexDirection="column" padding={32} gap={16}>
        <RiskFilterBar />
        <Tabs panelOverflow="scroll-y">
          {/* keepMounted: switching tabs must not unmount the leaderboard and re-run its ~0.8 GB of queries */}
          <Tab title="Risk Leaderboard" keepMounted>
            <Leaderboard />
          </Tab>
          {/* keepMounted: avoid re-running ~0.3 GB of context queries on every tab switch */}
          <Tab title="Risk Metrics" keepMounted>
            <RiskMetrics />
          </Tab>
        </Tabs>
      </Flex>
    </RiskFiltersProvider>
  );
};
