# subgraphs-network-exporter — context

Zero-dependency Bun Prometheus exporter for The Graph **network subgraph** (on-chain indexer
economics). One file: `src/index.ts`. Pure render/format helpers are exported and unit-tested
(`bun test`); the poll loop + `Bun.serve` only run under `import.meta.main`.

## Why this exists

Extracted from the inline Python `stake-exporter` ConfigMap in `../k8s-subgraphs` (pinax2). Reasons:
consistency with `../subgraphs-qos-exporter` (Bun, no Python), the inline Python-in-YAML blob had
grown unwieldy (stake + names + allocations + signal), and we want to observe **multiple / any**
indexers, not just ours. Metric names are kept identical to the old exporter (plus an
`indexer`/`indexer_name` label on `indexer_subgraph_allocated_grt`) so Grafana keeps working.

## Ecosystem

- `../subgraphs-qos-exporter` — sibling Bun exporter (gateway QoS feed via on-chain DataEdge). This
  repo mirrors its structure (Dockerfile, `.github/workflows/docker.yml` → GHCR, tsconfig, tests).
- `../k8s-subgraphs` — Flux GitOps cluster (riv-dev1). Hosts the deployment manifests. The old
  `pinax2/stake-exporter.yaml` (inline ConfigMap) is what this replaces.
- `../subgraphs-grafana` — dashboards-as-code that CONSUME these metrics.

## Deploy flow

Push to `main` → CI (`docker.yml`) type-checks, `bun test`, builds & pushes
`ghcr.io/pinax-network/subgraphs-network-exporter:latest`. A `k8s-subgraphs` Deployment pulls that
image; Flux rolls it out.

## Migration status (drop the estimator, re-source signal)

Bigger arc across repos: decommission the old `estimator` as a Grafana data source. Steps:
1. **(done, interim)** `k8s-subgraphs#144` added `subgraph_signalled_grt` to the inline Python exporter
   — ships curation signal now so Grafana can migrate off `estimator_subgraph_signal_grt`.
2. **(this repo)** Bun rewrite emitting the same metrics incl. `subgraph_signalled_grt`, multi-indexer.
3. **(pending)** `k8s-subgraphs`: replace the inline `stake-exporter` ConfigMap/Deployment with a
   Deployment referencing this image; keep the Service/VMServiceScrape on `:9400`. Once live,
   `#144` is superseded.
4. **(pending)** `subgraphs-grafana`: point Signal / Alloc:signal / Optimal GRT at
   `subgraph_signalled_grt`; re-source Chain/name/network-queries off `graph_qos` + `subgraph_name_info`;
   then remove all `estimator_*` deps. Per-subgraph **Disk** column has no in-cluster replacement and
   will be dropped (macro Postgres volume via `kubelet_volume_stats` stays — `subgraphs-grafana#81`).

## Conventions

- Keep it dependency-free at runtime (Bun global `fetch`). Types-only devDeps.
- A failed refresh keeps last-good metrics and only flips `_up`; fast-retry 30s.
- GRT = wei/1e18 via `BigInt` then `Number` (exact int, then divide).
- Commit trailers: `Co-Authored-By: Claude ...` and `Claude-Session:` per the session.
