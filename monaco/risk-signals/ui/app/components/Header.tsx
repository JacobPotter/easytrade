import React from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "@dynatrace/strato-components/layouts";

export const Header = () => {
  return (
    <AppHeader>
      <AppHeader.Navigation>
        <AppHeader.Logo as={Link} to="/" appName="Risk Signals" />
        <AppHeader.NavigationItem as={Link} to="/">
          Service Risk Leaderboard
        </AppHeader.NavigationItem>
      </AppHeader.Navigation>
    </AppHeader>
  );
};
