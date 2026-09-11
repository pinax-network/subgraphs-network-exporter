# subgraphs-network-exporter

Prometheus exporter for **The Graph network subgraph** — surfaces on-chain indexer economics (stake,
delegation, allocations, curation signal) that don't exist on any `/metrics` endpoint, for **any set
of indexers** you configure.

Zero-dependency [Bun](https://bun.sh) app. Sibling to
[`subgraphs-qos-exporter`](https://github.com/pinax-network/subgraphs-qos-exporter) (gateway QoS
feed); together they give Grafana the full picture the raw graph-node metrics can't.

> Supersedes the old inline `stake-exporter` ConfigMap in `k8s-subgraphs`. Metric names are
> unchanged (plus an `indexer`/`indexer_name` label on the per-deployment allocation), so existing
> dashboards keep working — and it now generalises to multiple indexers.

## Metrics

Per-indexer (labelled `indexer`, `indexer_name`) — for the `INDEXERS` detail set, and (with
`ALL_INDEXER_STAKE=true`) every registered indexer above `MIN_STAKE_GRT`:

| Metric | Source field |
|---|---|
| `indexer_self_stake_grt` | `stakedTokens` |
| `indexer_delegated_grt` | `delegatedTokens` |
| `indexer_delegation_capacity_grt` | `delegatedCapacity` |
| `indexer_allocated_grt` | `allocatedTokens` |
| `indexer_available_stake_grt` | `availableStake` |
| `indexer_query_fees_collected_grt` | `queryFeesCollected` |
| `indexer_rewards_earned_grt` | `rewardsEarned` |
| `indexer_capacity_used_ratio` | `allocatedTokens / delegatedCapacity` |

Per-`(indexer, deployment)`:

| Metric | Meaning |
|---|---|
| `indexer_subgraph_allocated_grt` | that indexer's active allocation on a deployment |

Per-deployment (network-wide, from `subgraphDeployment` — deduped across all tracked indexers' allocations):

| Metric | Meaning |
|---|---|
| `subgraph_total_allocated_grt` | tokens allocated on the deployment by **all** indexers |
| `subgraph_signalled_grt` | curation signal on the deployment (drives the indexing-reward split) |
| `subgraph_name_info` | `deployment → display name` (value `1`) |

Liveness: `subgraphs_network_exporter_up`, `_last_refresh_seconds`, `_indexers_tracked`,
`_deployments_tracked` (plus `indexer_stake_exporter_up` for backward-compat).

## Configuration

All via env (see `.env.example`); everything has a default.

| Var | Default | Notes |
|---|---|---|
| `NETWORK_SUBGRAPH_URL` | in-cluster GNArb | GraphQL endpoint; override to run locally |
| `INDEXERS` | our wallet | comma-separated wallets — the **detail** set (stake + allocations + signal + names) |
| `ALL_INDEXER_STAKE` | `false` | also emit stake gauges for every registered indexer over the floor |
| `MIN_STAKE_GRT` | `100000` | stake floor for the all-indexers view **and** for `gen-indexers.ts` pruning |
| `REFRESH_SECONDS` | `60` | stake/allocation/signal poll |
| `NAME_REFRESH_SECONDS` | `1800` | display-name poll (names change rarely) |
| `PORT` | `9400` | HTTP listen port |

## Indexer names (`indexers.json`)

Indexer display names come from a committed **`indexers.json`** (`{ "<wallet>": "<name>" }`), baked into
the image and loaded at startup — so there's no risky name field on the runtime critical path.
Regenerate it out-of-band (drops anyone below the stake floor, which prunes deregistered indexers):

```sh
NETWORK_SUBGRAPH_URL="https://gateway.thegraph.com/api/<key>/subgraphs/id/<network-subgraph>" \
MAINNET_RPC_URL="https://eth.rpc.example/v1/<key>/" \
MIN_STAKE_GRT=100000 \
  bun run gen:indexers > indexers.json
```

Name preference: ENS primary name (mainnet reverse resolution) → network-subgraph `defaultDisplayName`
→ indexer URL host. `MAINNET_RPC_URL` is optional (without it, ENS reverse is skipped).

## Run

```sh
bun install          # dev deps only (types); the app itself has none
bun run start        # serves /metrics and /healthz on :9400
bun test             # unit tests for the pure render/format helpers
bun run typecheck
```

## Endpoints

- `GET /metrics` (and `/`) — Prometheus text exposition
- `GET /healthz` — `200 ok` once the first refresh succeeds, else `503 degraded`

## Design

- **Stdlib-only at runtime** — Bun's global `fetch`; the render/format helpers are pure and exported
  for `bun test`. The HTTP server + poll loop only start under `import.meta.main`.
- **Two cadences** — a fast loop (`REFRESH_SECONDS`) for stake/allocations/signal, a slow one
  (`NAME_REFRESH_SECONDS`) for display names. A failed cycle keeps the last-good metrics and only
  flips `_up` to 0; fast-retries every 30s so a transient blip never leaves stale data for long.
- **Multiple indexers** — put any wallets in `INDEXERS`. Per-deployment `total`/`signal` are
  deployment-global, so they're deduped across the union of tracked indexers' allocations.

Horizon PoI monitoring uses `max(createdAt, latestPoiPresentedAt)` in seconds and
reads `maxPOIStaleness()` from SubgraphService on Arbitrum (`POI_RPC_URL`, default
public Arbitrum RPC). `indexer_poi_allocations_at_risk` counts native allocations
within two days of that live deadline; `indexer_poi_allocations_stale` uses the
contract's strict greater-than boundary. The existing epoch-age gauges now cover
legacy allocations only. Alerts must also check
`subgraphs_network_exporter_poi_up` and
`subgraphs_network_exporter_poi_last_success_seconds`: a stale/erroring source must
not appear healthy because the economics loop still succeeds. Native monitoring
fails closed on incomplete or stale Network data and keeps the last good values.
