type QueueEntry = { childPid: number | null; slot: string };
type Snapshot = {
  buildQueue: QueueEntry[];
  unknown: string[];
};

function snapshotFrom(text: string): Snapshot {
  const snapshot: Snapshot = { buildQueue: [], unknown: [] };
  const value = JSON.parse(text);
  snapshot.buildQueue = Array.isArray(value.buildQueue) ? value.buildQueue : [];
  snapshot.unknown = Array.isArray(value.unknown) ? value.unknown : [];
  return snapshot;
}

const snapshot = snapshotFrom('{"buildQueue":[{"childPid":7,"slot":"a"}],"unknown":["x"]}');
console.log(snapshot.buildQueue[0]?.childPid, snapshot.buildQueue[0]?.slot);
snapshot.buildQueue.push({ childPid: null, slot: "b" });
console.log(snapshot.buildQueue.length, snapshot.unknown.join("|"));
