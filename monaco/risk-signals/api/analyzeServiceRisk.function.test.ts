import analyzeServiceRisk, {
  buildRiskPrompt,
  type ServiceRiskPayload,
} from "./analyzeServiceRisk.function";

const row: ServiceRiskPayload = {
  service: "easytrade-broker-service",
  cluster: "prod-cluster",
  score: 82.4,
  status: "Critical",
  primaryDriver: "Errors",
  trendLast2h: "Rising",
  blastRadius: "High",
  failRateNowPct: 12.5,
  failZ: 4.2,
  p95BaseMs: 120,
  p95NowMs: 480,
  p95Ratio: 4,
  logErrBase: 3,
  logErrNow: 41,
  cpuPct: 91.3,
  memGrowthPct: 18,
  oomKills: 2,
  hoursSinceChange: 0.5,
  davis: "1 active problem",
  sErr: 0.9,
  sLat: 0.75,
  sSat: 0.6,
  sChg: 0.92,
  sDavis: 1,
  blastMult: 1.4,
  coverage: "full",
};

const promptText = (p: ServiceRiskPayload) => buildRiskPrompt(p).text;

describe("analyzeServiceRisk.function", () => {
  it("buildRiskPrompt_withNumbers_includesExactValues", () => {
    expect(promptText(row)).toEqual(
      expect.stringMatching(
        /82\.4[\s\S]*12\.5 %[\s\S]*4\.2[\s\S]*120 ms[\s\S]*480 ms[\s\S]*91\.3 %[\s\S]*\| OOM kills \| 2 \|/,
      ),
    );
  });

  it("buildRiskPrompt_nullMetrics_rendersNA", () => {
    expect(promptText({ ...row, failRateNowPct: null, p95NowMs: null })).toEqual(
      expect.stringMatching(/\| Failure rate now \| n\/a \|[\s\S]*\| p95 latency now \| n\/a \|/),
    );
  });

  it("buildRiskPrompt_always_instructsSeniorSreWithBulletedMitigation", () => {
    expect(buildRiskPrompt(row).context).toEqual(
      expect.arrayContaining([
        {
          type: "instruction",
          value: expect.stringMatching(/Senior Site Reliability Engineer[\s\S]*Mitigation strategy: a bulleted list/),
        },
      ]),
    );
  });

  it("handler_invalidPayload_throws", async () => {
    await expect(analyzeServiceRisk({ service: "", score: 10 })).rejects.toThrow(/'service'/);
  });
});
