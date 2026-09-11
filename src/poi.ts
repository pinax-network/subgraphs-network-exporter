// Horizon uses seconds since the later of creation and last PoI. Creation epochs
// remain useful historical gauges, but cannot determine a native PoI deadline.
export type PoiAllocation = { isLegacy: boolean; createdAt: string; latestPoiPresentedAt: string | null };
export function poiSummary(allocations: PoiAllocation[], now: number, maxStaleness: number) {
  if (!Number.isFinite(now) || !Number.isFinite(maxStaleness) || maxStaleness <= 0) throw Error('Invalid PoI timing');
  let count = 0, oldest = 0, atRisk = 0, stale = 0;
  for (const a of allocations) {
    if (typeof a.isLegacy !== 'boolean') throw Error('Missing allocation generation');
    if (a.isLegacy) continue;
    const created = Number(a.createdAt), presented = Number(a.latestPoiPresentedAt ?? 0);
    if (!Number.isFinite(created) || created <= 0 || !Number.isFinite(presented) || presented < 0 || Math.max(created, presented) > now) throw Error('Invalid native timestamp');
    const age = now - Math.max(created, presented);
    count++; oldest = Math.max(oldest, age);
    if (age >= maxStaleness - 2 * 86400) atRisk++;
    if (age > maxStaleness) stale++; // contract uses strict greater-than
  }
  return { count, oldest, atRisk, stale, remaining: count ? maxStaleness - oldest : maxStaleness };
}

export async function liveStaleness(rpcUrl: string): Promise<number> {
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(rpcUrl, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}), signal:AbortSignal.timeout(20000)});
    if (!r.ok) throw Error('PoI RPC HTTP ' + r.status);
    const j = await r.json() as {result?: string; error?: unknown};
    if (j.error || !j.result) throw Error('PoI RPC unavailable');
    return j.result;
  };
  if (await call('eth_chainId', []) !== '0xa4b1') throw Error('PoI RPC chain mismatch');
  // keccak256("maxPOIStaleness()")[0:4], verified against the deployed service ABI.
  const result = await call('eth_call', [{to:'0xb2Bb92d0DE618878E438b55D5846cfecD9301105',data:'0x85e82baf'},'latest']);
  const seconds = Number(BigInt(result));
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw Error('Invalid live maxPOIStaleness');
  return seconds;
}
