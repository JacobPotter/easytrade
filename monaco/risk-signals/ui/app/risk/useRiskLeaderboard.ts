import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRiskLeaderboard } from "./leaderboardClient";
import type { RiskLeaderboard, RiskParams } from "./riskContract";

export interface UseRiskLeaderboardResult {
  data: RiskLeaderboard | undefined;
  error: Error | undefined;
  isLoading: boolean;
  /** Increments with every completed run; use as a React key to remount views sized to the data. */
  runId: number;
  /** Re-runs the leaderboard; supersedes a run that is still in flight. */
  refresh: () => void;
}

/**
 * Fetches the leaderboard from the computeRiskLeaderboard app function on mount, whenever `params` change, and on
 * demand. The in-flight call is aborted on unmount, on refresh and when params change, and its result is dropped.
 * Aborting cancels the HTTP call only: DQL queries the function already started run to completion on the server.
 */
export function useRiskLeaderboard(params: RiskParams): UseRiskLeaderboardResult {
  const [data, setData] = useState<RiskLeaderboard>();
  const [error, setError] = useState<Error>();
  const [isLoading, setIsLoading] = useState(true);
  const [runId, setRunId] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  // Value-based dependency: a new object with the same values must not trigger a ~0.8 GB re-run.
  const paramsKey = JSON.stringify(params);

  const refresh = useCallback(() => {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setIsLoading(true);
    setError(undefined);

    fetchRiskLeaderboard(paramsRef.current, ac.signal)
      .then((result) => {
        if (ac.signal.aborted) return;
        setData(result);
        setRunId((n) => n + 1);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        console.error("Risk leaderboard computation failed", err);
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!ac.signal.aborted) setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
    return () => controller.current?.abort();
  }, [refresh, paramsKey]);

  return { data, error, isLoading, runId, refresh };
}
