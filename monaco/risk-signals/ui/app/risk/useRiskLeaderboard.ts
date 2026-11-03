import { useCallback, useEffect, useRef, useState } from "react";
import { computeRiskLeaderboard, type RiskLeaderboard, type RiskParams } from "./engine";

export interface UseRiskLeaderboardResult {
  data: RiskLeaderboard | undefined;
  error: Error | undefined;
  isLoading: boolean;
  /** Increments with every completed run; use as a React key to remount views sized to the data. */
  runId: number;
  /** Re-runs every query; cancels a run that is still in flight. */
  refresh: () => void;
}

/**
 * Runs the risk engine on mount, whenever `params` change, and on demand.
 * In-flight queries are aborted on unmount, on refresh and when params change.
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

    computeRiskLeaderboard(paramsRef.current, ac.signal)
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
