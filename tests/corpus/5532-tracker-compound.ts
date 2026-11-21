interface Bucket { outperformedQueries: number; gapTotal: number; }
interface Tracker {
  keywords: Set<string>;
  outperformedQueries: number;
  outperformedGapTotal: number;
  outperformedByPage: Map<string, Bucket>;
}
function track(tracker: Tracker, page: string, gap: number): void {
  tracker.outperformedQueries += 1;
  const bucket = tracker.outperformedByPage.get(page) ?? { outperformedQueries: 0, gapTotal: 0 };
  bucket.outperformedQueries += 1;
  bucket.gapTotal += gap;
  tracker.outperformedGapTotal += gap;
  tracker.outperformedByPage.set(page, bucket);
}
const tracker: Tracker = { keywords: new Set(), outperformedQueries: 0, outperformedGapTotal: 0, outperformedByPage: new Map() };
track(tracker, '/a', 3);
track(tracker, '/a', 5);
track(tracker, '/b', 2);
const a = tracker.outperformedByPage.get('/a');
const b = tracker.outperformedByPage.get('/b');
console.log(tracker.outperformedQueries, tracker.outperformedGapTotal, a?.outperformedQueries, a?.gapTotal, b?.outperformedQueries, b?.gapTotal);
