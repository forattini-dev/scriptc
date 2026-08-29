let fallbackCalls = 0;

function fallback(asNumber: boolean): number | string {
  fallbackCalls++;
  return asNumber ? 501 : "nouid";
}

function sessionKey(uid: number | string | undefined, asNumber: boolean): string {
  const resolved = uid ?? fallback(asNumber);
  return `uid:${resolved}`;
}

console.log(sessionKey(42, false), fallbackCalls);
console.log(sessionKey("agent", true), fallbackCalls);
console.log(sessionKey(undefined, true), fallbackCalls);
console.log(sessionKey(undefined, false), fallbackCalls);
