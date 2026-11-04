import { parseRiskParams } from "./computeRiskLeaderboard.function";
import { DEFAULT_RISK_PARAMS } from "../ui/app/risk/riskContract";

describe("computeRiskLeaderboard.function", () => {
  it("parseRiskParams_nonObject_throws", () => {
    expect(() => parseRiskParams("24h")).toThrow(/expected an object/);
  });

  it("parseRiskParams_nonStringCluster_throws", () => {
    expect(() => parseRiskParams({ ...DEFAULT_RISK_PARAMS, clusters: ["c-1", 42] })).toThrow(/'clusters'/);
  });

  it("parseRiskParams_compareLongerThanHalfBaseline_throws", () => {
    expect(() => parseRiskParams({ clusters: [], lookbackHours: 6, currentHours: 4 })).toThrow(/at most half/);
  });

  it("parseRiskParams_lookbackAboveMax_throws", () => {
    expect(() => parseRiskParams({ clusters: [], lookbackHours: 720, currentHours: 2 })).toThrow(/at most 48h/);
  });

  it("parseRiskParams_defaultParams_returnsThem", () => {
    expect(parseRiskParams(DEFAULT_RISK_PARAMS)).toEqual(DEFAULT_RISK_PARAMS);
  });
});
