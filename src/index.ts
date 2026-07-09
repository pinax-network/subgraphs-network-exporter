// subgraphs-network-exporter — serve The Graph network subgraph's on-chain indexer economics as
// Prometheus metrics.
//
// Stake, delegation, allocations and curation signal live in the network subgraph (GraphQL), not in
// any /metrics endpoint. We query it every REFRESH_SECONDS for a configurable SET of indexers
// (INDEXERS, default just ours) and expose:
//   • per-indexer gauges  — self-stake, delegated, delegation capacity, allocated, available stake,
//                            lifetime query fees & rewards, capacity-used ratio  (labelled by wallet)
//   • per-(indexer,deployment) allocation — indexer_subgraph_allocated_grt
//   • per-deployment network-wide — subgraph_total_allocated_grt (all indexers), subgraph_signalled_grt
//     (curation signal, drives the indexing-reward split), subgraph_name_info (display name)
//
// Generalised from the old inline stake-exporter: put ANY wallet(s) in INDEXERS to operate/observe
// multiple indexers. Metric names are unchanged from that exporter (plus an indexer/indexer_name
// label on the per-deployment allocation), so Grafana keeps working.
//
// Zero npm deps — Bun's global fetch. Pure render/format helpers are exported for `bun test`.

// The network subgraph GraphQL endpoint. Default is our in-cluster GNArb deployment (only resolves
// inside the cluster); override for local testing.
const NETWORK_SUBGRAPH_URL = (process.env.NETWORK_SUBGRAPH_URL ??
  "http://graph-node-serve.subgraphs-arbitrum-one:8000/subgraphs/id/QmT329Bej8AwSLahmgnmi6fdYkj3rorYAcCes45gDv9aJ4"
).replace(/\/+$/, "");
// Indexers to track — comma-separated wallets. Default: our indexer. Add more to operate/observe a
// fleet; every wallet here gets the full stake + allocation + signal treatment.
const INDEXERS = (process.env.INDEXERS ?? "0x3717cef8020bddee7a18f4efb2bfa88fefdcb1bc")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const REFRESH_MS = Number(process.env.REFRESH_SECONDS ?? 60) * 1000;
const NAME_REFRESH_MS = Number(process.env.NAME_REFRESH_SECONDS ?? 1800) * 1000;   // names change rarely
const PORT = Number(process.env.PORT ?? 9400);

// ── GraphQL ──────────────────────────────────────────────────────────────────────────────────────
async function gql(query: string): Promise<any> {
  const r = await fetch(NETWORK_SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`gql HTTP ${r.status}`);
  const j = (await r.json()) as { data?: any; errors?: unknown };
  if (j.errors) throw new Error(`gql: ${JSON.stringify(j.errors)}`);
  return j.data;
}

const stakeQuery = (id: string) =>
  `{ indexer(id:"${id}"){ defaultDisplayName stakedTokens delegatedTokens delegatedCapacity ` +
  `allocatedTokens availableStake queryFeesCollected rewardsEarned } }`;
const allocQuery = (id: string) =>
  `{ indexer(id:"${id}"){ allocations(first:1000, where:{status:Active}){ ` +
  `allocatedTokens subgraphDeployment { ipfsHash stakedTokens signalledTokens } } } }`;
const nameQuery = (id: string) =>
  `{ indexer(id:"${id}"){ allocations(first:1000, where:{status:Active}){ subgraphDeployment { ipfsHash ` +
  `versions(first:1, orderBy:version, orderDirection:desc){ subgraph { metadata { displayName } } } } } } }`;

// ── formatting ───────────────────────────────────────────────────────────────────────────────────
// wei string → GRT float. BigInt keeps the integer exact before the (lossy-but-fine) /1e18 divide.
export const grt = (v: unknown): number => {
  try { return Number(BigInt(String(v ?? "0"))) / 1e18; } catch { return 0; }
};
export const esc = (s: unknown): string =>
  String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

// [metric, GraphQL key, HELP text]
const FIELDS: [string, string, string][] = [
  ["indexer_self_stake_grt", "stakedTokens", "Indexer self-stake"],
  ["indexer_delegated_grt", "delegatedTokens", "Delegated tokens"],
  ["indexer_delegation_capacity_grt", "delegatedCapacity", "Delegation capacity (16x self-stake)"],
  ["indexer_allocated_grt", "allocatedTokens", "Allocated tokens"],
  ["indexer_available_stake_grt", "availableStake", "Available (unallocated) stake"],
  ["indexer_query_fees_collected_grt", "queryFeesCollected", "Lifetime query fees collected"],
  ["indexer_rewards_earned_grt", "rewardsEarned", "Lifetime indexing rewards earned"],
];

export type StakeRow = { id: string; name: string; data: Record<string, unknown> };
export type AllocRow = { indexer: string; indexerName: string; hash: string; allocated: number };
export type DeploymentAgg = { total: number; signal: number };

export function renderStake(rows: StakeRow[]): string {
  const out: string[] = [];
  for (const [metric, , help] of FIELDS) out.push(`# HELP ${metric} ${help} (GRT)`, `# TYPE ${metric} gauge`);
  out.push("# HELP indexer_capacity_used_ratio Allocated / delegation capacity (0-1)",
    "# TYPE indexer_capacity_used_ratio gauge");
  for (const row of rows) {
    const lbl = `indexer="${esc(row.id)}",indexer_name="${esc(row.name)}"`;
    for (const [metric, key] of FIELDS) out.push(`${metric}{${lbl}} ${grt(row.data[key]).toFixed(6)}`);
    const cap = grt(row.data.delegatedCapacity), alloc = grt(row.data.allocatedTokens);
    out.push(`indexer_capacity_used_ratio{${lbl}} ${(cap ? alloc / cap : 0).toFixed(6)}`);
  }
  return out.join("\n") + "\n";
}

export function renderAlloc(allocs: AllocRow[]): string {
  // sum multiple active allocations by the same indexer on the same deployment
  const agg = new Map<string, { indexer: string; name: string; hash: string; v: number }>();
  for (const a of allocs) {
    const k = `${a.indexer}|${a.hash}`;
    const cur = agg.get(k) ?? { indexer: a.indexer, name: a.indexerName, hash: a.hash, v: 0 };
    cur.v += a.allocated;
    agg.set(k, cur);
  }
  const out = ["# HELP indexer_subgraph_allocated_grt An indexer's active allocation on this deployment (GRT)",
    "# TYPE indexer_subgraph_allocated_grt gauge"];
  for (const { indexer, name, hash, v } of agg.values())
    out.push(`indexer_subgraph_allocated_grt{indexer="${esc(indexer)}",indexer_name="${esc(name)}",deployment="${esc(hash)}"} ${v.toFixed(6)}`);
  return out.join("\n") + "\n";
}

export function renderDeployments(deps: Map<string, DeploymentAgg>): string {
  const out = ["# HELP subgraph_total_allocated_grt Tokens allocated on this deployment by ALL indexers (GRT)",
    "# TYPE subgraph_total_allocated_grt gauge",
    "# HELP subgraph_signalled_grt Curation signal on this deployment (GRT) - drives indexing-reward split",
    "# TYPE subgraph_signalled_grt gauge"];
  for (const [hash, d] of deps) out.push(`subgraph_total_allocated_grt{deployment="${esc(hash)}"} ${d.total.toFixed(6)}`);
  for (const [hash, d] of deps) out.push(`subgraph_signalled_grt{deployment="${esc(hash)}"} ${d.signal.toFixed(6)}`);
  return out.join("\n") + "\n";
}

export function renderNames(names: Map<string, string>): string {
  const out = ["# HELP subgraph_name_info deployment -> real subgraph display name",
    "# TYPE subgraph_name_info gauge"];
  for (const [hash, name] of names) out.push(`subgraph_name_info{deployment="${esc(hash)}",name="${esc(name)}"} 1`);
  return out.join("\n") + "\n";
}

// ── runtime state ────────────────────────────────────────────────────────────────────────────────
let stakeBlock = "", allocBlock = "", depBlock = "", nameBlock = "";
let up = 0, lastRefresh = 0, deploymentCount = 0;
const indexerNameCache = new Map<string, string>();   // wallet -> defaultDisplayName (reused by alloc labels)

async function refreshEconomics(): Promise<void> {
  const stakeRows: StakeRow[] = [];
  const allocs: AllocRow[] = [];
  const deps = new Map<string, DeploymentAgg>();
  let ok = 0;
  for (const id of INDEXERS) {
    try {
      const d = (await gql(stakeQuery(id)))?.indexer;
      if (d) {
        const name = d.defaultDisplayName ?? "";
        indexerNameCache.set(id, name || indexerNameCache.get(id) || "");
        stakeRows.push({ id, name: indexerNameCache.get(id) ?? "", data: d });
        ok++;
      }
    } catch (e) { console.error(`stake ${id}: ${e}`); }
    try {
      const al = (await gql(allocQuery(id)))?.indexer?.allocations ?? [];
      const iname = indexerNameCache.get(id) ?? "";
      for (const a of al) {
        const sd = a.subgraphDeployment ?? {};
        const hash = sd.ipfsHash;
        if (!hash) continue;
        allocs.push({ indexer: id, indexerName: iname, hash, allocated: grt(a.allocatedTokens) });
        deps.set(hash, { total: grt(sd.stakedTokens), signal: grt(sd.signalledTokens) });   // deployment-global
      }
    } catch (e) { console.error(`alloc ${id}: ${e}`); }
  }
  if (ok > 0) {
    stakeBlock = renderStake(stakeRows);
    allocBlock = renderAlloc(allocs);
    depBlock = renderDeployments(deps);
    deploymentCount = deps.size;
    up = 1;
    console.log(`refreshed: indexers=${stakeRows.length}/${INDEXERS.length}, allocations=${allocs.length}, deployments=${deps.size}`);
  } else {
    up = 0;   // keep last-good blocks; only flip the up gauge
    console.error(`refresh failed for all ${INDEXERS.length} indexers`);
  }
  lastRefresh = Math.floor(Date.now() / 1000);
}

async function refreshNames(): Promise<void> {
  const names = new Map<string, string>();
  for (const id of INDEXERS) {
    try {
      const al = (await gql(nameQuery(id)))?.indexer?.allocations ?? [];
      for (const a of al) {
        const sd = a.subgraphDeployment ?? {};
        const hash = sd.ipfsHash;
        if (!hash || names.has(hash)) continue;
        let nm = "";
        for (const v of sd.versions ?? []) {
          const dn = v?.subgraph?.metadata?.displayName;
          if (dn) { nm = dn; break; }
        }
        names.set(hash, nm || hash);   // fall back to hash if unnamed
      }
    } catch (e) { console.error(`names ${id}: ${e}`); }
  }
  if (names.size) nameBlock = renderNames(names);
}

function body(): string {
  return stakeBlock + allocBlock + depBlock + nameBlock +
    "# TYPE subgraphs_network_exporter_up gauge\n" + `subgraphs_network_exporter_up ${up}\n` +
    "# TYPE subgraphs_network_exporter_last_refresh_seconds gauge\n" + `subgraphs_network_exporter_last_refresh_seconds ${lastRefresh}\n` +
    "# TYPE subgraphs_network_exporter_indexers_tracked gauge\n" + `subgraphs_network_exporter_indexers_tracked ${INDEXERS.length}\n` +
    "# TYPE subgraphs_network_exporter_deployments_tracked gauge\n" + `subgraphs_network_exporter_deployments_tracked ${deploymentCount}\n` +
    // backward-compat with the old inline exporter's liveness metric
    "# TYPE indexer_stake_exporter_up gauge\n" + `indexer_stake_exporter_up ${up}\n`;
}

if (import.meta.main) {
  // Fast-retry (30s) after a failure so a transient GraphQL blip never leaves us stale for long and
  // never fails a k8s rollout (readiness gates on /healthz → the first good refresh).
  (async function loop() { await refreshEconomics(); setTimeout(loop, up ? REFRESH_MS : 30_000); })();
  (async function nloop() { await refreshNames(); setTimeout(nloop, NAME_REFRESH_MS); })();

  Bun.serve({
    port: PORT,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/metrics" || path === "/")
        return new Response(body(), { headers: { "content-type": "text/plain; version=0.0.4" } });
      if (path === "/healthz")
        return new Response(up ? "ok" : "degraded", { status: up ? 200 : 503 });
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`network-exporter on :${PORT} — subgraph=${NETWORK_SUBGRAPH_URL} indexers=[${INDEXERS.join(", ")}] refresh=${REFRESH_MS / 1000}s`);
}
