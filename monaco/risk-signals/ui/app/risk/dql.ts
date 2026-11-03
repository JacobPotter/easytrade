import {
  queryExecutionClient,
  type ResultRecord,
  type ResultRecordValue,
} from "@dynatrace-sdk/client-query";

export type { ResultRecord };

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

/** Converts a scalar record value to a number; null for missing or non-numeric values. */
export function toNum(v: ResultRecordValue | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** String field, or undefined if missing or not a string. */
export function str(r: ResultRecord, key: string): string | undefined {
  const v = r[key];
  return typeof v === "string" ? v : undefined;
}

/** Numeric field (DQL longs arrive as strings), or null. */
export function numField(r: ResultRecord, key: string): number | null {
  return toNum(r[key]);
}

/** Timeseries array field as numbers (nulls preserved); empty if missing. */
export function numArr(r: ResultRecord, key: string): (number | null)[] {
  const v = r[key];
  return Array.isArray(v) ? v.map((x) => toNum(x)) : [];
}

/** Array-of-strings field; non-string entries dropped; empty if missing. */
export function strArr(r: ResultRecord, key: string): string[] {
  const v = r[key];
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}
