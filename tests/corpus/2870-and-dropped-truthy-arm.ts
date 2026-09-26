// `&&` drops an always-truthy object arm from the checker's result. The
// left evaluates once, the right stays lazy, and the falsy unit arm retags
// into the result union without attempting to carry the object arm.
class Marker {
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }
}

let leftCalls = 0;
function marker(present: boolean): Marker | undefined {
  leftCalls++;
  return present ? new Marker("ready") : undefined;
}

let rightCalls = 0;
function found(value: string): string | undefined {
  rightCalls++;
  return value === "hit" ? value : undefined;
}

function pick(present: boolean, value: string): string | undefined {
  return marker(present) && found(value);
}

console.log(pick(false, "hit"), leftCalls, rightCalls);
console.log(pick(true, "hit"), leftCalls, rightCalls);
console.log(pick(true, "miss"), leftCalls, rightCalls);
