/**
 * Typed accessors for DQL result records. Shared by the UI (useDql results) and the risk engine in api/risk/,
 * which runs the queries itself (api/risk/runDql.ts).
 */
import type { ResultRecord, ResultRecordValue } from "@dynatrace-sdk/client-query";

export type { ResultRecord };

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
