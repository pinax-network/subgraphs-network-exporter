import { test, expect } from 'bun:test';
import { poiSummary } from '../src/poi';
const day=86400;
test('PoI refresh moves a native deadline without changing creation', () => {
  const result=poiSummary([{isLegacy:false,createdAt:String(day),latestPoiPresentedAt:String(29*day)}],40*day,28*day);
  expect(result.oldest).toBe(11*day); expect(result.atRisk).toBe(0); expect(result.remaining).toBe(17*day);
});
test('never-presented native uses creation; stale boundary matches contract', () => {
  const a={isLegacy:false,createdAt:String(day),latestPoiPresentedAt:null};
  expect(poiSummary([a],27*day,28*day).atRisk).toBe(1);
  expect(poiSummary([a],29*day,28*day).stale).toBe(0);
  expect(poiSummary([a],29*day+1,28*day).stale).toBe(1);
});
test('legacy remains outside native counters and invalid data cannot look healthy', () => {
  expect(poiSummary([{isLegacy:true,createdAt:'1',latestPoiPresentedAt:null}],100*day,28*day).count).toBe(0);
  expect(()=>poiSummary([{isLegacy:false,createdAt:'0',latestPoiPresentedAt:null}],day,28*day)).toThrow();
  expect(()=>poiSummary([{isLegacy:false,createdAt:'1',latestPoiPresentedAt:'bad'}],day,28*day)).toThrow();
});
