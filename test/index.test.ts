import { expect, test } from "bun:test";
import { grt, esc, renderStake, renderAlloc, renderDeployments, renderNames, renderNetwork } from "../src/index.ts";

test("grt: wei string -> GRT float, exact via BigInt", () => {
  expect(grt("1000000000000000000")).toBe(1);
  expect(grt("2790000000000000000000000")).toBeCloseTo(2_790_000, 0);
  expect(grt(null)).toBe(0);
  expect(grt("not-a-number")).toBe(0);
});

test("esc: escapes label-breaking characters", () => {
  expect(esc('a "b" c')).toBe('a \\"b\\" c');
  expect(esc("line\nbreak")).toBe("line break");
  expect(esc(null)).toBe("");
});

test("renderStake: per-indexer gauges + capacity ratio, labelled by wallet+name", () => {
  const out = renderStake([{
    id: "0xabc", name: "pinax2.eth",
    data: {
      stakedTokens: "100000000000000000000", delegatedTokens: "0",
      delegatedCapacity: "200000000000000000000", allocatedTokens: "100000000000000000000",
      availableStake: "0", queryFeesCollected: "0", rewardsEarned: "0",
    },
  }]);
  expect(out).toContain('indexer_self_stake_grt{indexer="0xabc",indexer_name="pinax2.eth"} 100.000000');
  expect(out).toContain('indexer_capacity_used_ratio{indexer="0xabc",indexer_name="pinax2.eth"} 0.500000');
  expect(out).toContain("# TYPE indexer_allocated_grt gauge");
});

test("renderAlloc: sums an indexer's allocations per deployment", () => {
  const out = renderAlloc([
    { indexer: "0xabc", indexerName: "us", hash: "Qm1", allocated: 10 },
    { indexer: "0xabc", indexerName: "us", hash: "Qm1", allocated: 5 },
    { indexer: "0xabc", indexerName: "us", hash: "Qm2", allocated: 7 },
  ]);
  expect(out).toContain('indexer_subgraph_allocated_grt{indexer="0xabc",indexer_name="us",deployment="Qm1"} 15.000000');
  expect(out).toContain('indexer_subgraph_allocated_grt{indexer="0xabc",indexer_name="us",deployment="Qm2"} 7.000000');
});

test("renderDeployments: network-wide total + signal + indexer count per deployment", () => {
  const out = renderDeployments(new Map([["Qm1", { total: 500, signal: 42.5, indexers: 7 }]]));
  expect(out).toContain('subgraph_total_allocated_grt{deployment="Qm1"} 500.000000');
  expect(out).toContain('subgraph_signalled_grt{deployment="Qm1"} 42.500000');
  expect(out).toContain('subgraph_indexer_count{deployment="Qm1"} 7');
});

test("renderNames: deployment -> display name info gauge", () => {
  const out = renderNames(new Map([["Qm1", "Lido"]]));
  expect(out).toContain('subgraph_name_info{deployment="Qm1",name="Lido"} 1');
});

test("renderStake: emits reward-cut ratio from ppm", () => {
  const out = renderStake([{
    id: "0xabc", name: "pinax2.eth",
    data: {
      stakedTokens: "0", delegatedTokens: "0", delegatedCapacity: "0", allocatedTokens: "0",
      availableStake: "0", queryFeesCollected: "0", rewardsEarned: "0", indexingRewardCut: 250000,
    },
  }]);
  expect(out).toContain('indexer_indexing_reward_cut_ratio{indexer="0xabc",indexer_name="pinax2.eth"} 0.250000');
});

test("renderNetwork: total signal + issuance per block (wei -> GRT)", () => {
  const out = renderNetwork({
    totalTokensSignalled: "9292523000000000000000000",
    networkGRTIssuancePerBlock: "120730000000000000000",
  });
  expect(out).toContain("graph_network_total_signal_grt 9292523.000000");
  expect(out).toContain("graph_network_issuance_per_block_grt 120.730000");
});
