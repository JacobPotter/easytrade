import { queryExecutionClient, type ResultRecord } from "@dynatrace-sdk/client-query";

const REQUEST_TIMEOUT_MS = 30000;

/** Runs a DQL query to completion (execute, then long-poll) and returns its records. */
export async function runDql(
  query: string,
  abortSignal?: AbortSignal,
): Promise<ResultRecord[]> {
  const started = await queryExecutionClient.queryExecute({
    body: {
      query,
      requestTimeoutMilliseconds: REQUEST_TIMEOUT_MS,
      maxResultRecords: 100000,
    },
    abortSignal,
  });
  if (started.result) return dropNulls(started.result.records);
  if (!started.requestToken) {
    throw new Error(`DQL ${started.state} without request token: ${query}`);
  }

  let polled;
  do {
    polled = await queryExecutionClient.queryPoll({
      requestToken: started.requestToken,
      requestTimeoutMilliseconds: REQUEST_TIMEOUT_MS,
      abortSignal,
    });
  } while (polled.state === "RUNNING" || polled.state === "NOT_STARTED");

  if (polled.state !== "SUCCEEDED" || !polled.result) {
    throw new Error(`DQL ${polled.state}: ${query}`);
  }
  return dropNulls(polled.result.records);
}

const dropNulls = (records: (ResultRecord | null)[]): ResultRecord[] =>
  records.filter((r): r is ResultRecord => r !== null);
