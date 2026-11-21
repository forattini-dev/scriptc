type LeftValue = string | number | boolean | null | LeftValue[] | LeftObject;
type LeftObject = { [key: string]: LeftValue };
type RightValue = string | number | boolean | null | RightValue[] | RightObject;
type RightObject = { [key: string]: RightValue };

function render(value: LeftValue[] | LeftObject): string {
  if (!Array.isArray(value)) return JSON.stringify(value as RightValue);
  return String(value.length);
}

function project(value: LeftValue[] | LeftObject): string {
  const projected: RightValue[] | RightObject = value;
  return Array.isArray(projected) ? String(projected.length) : JSON.stringify(projected);
}

function rightLength(value: readonly RightValue[]): number {
  return value.length;
}

function guardedRecursiveAlias(input: LeftValue): number {
  const value: LeftValue = input;
  if (Array.isArray(value)) return rightLength(value);
  return -1;
}

function guardedRecord(value: LeftValue): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("record required");
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length;
}

function guardedUnknown(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("record required");
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length;
}

const input = JSON.parse('[{"status":"ready"}]') as LeftValue[] | LeftObject;
const sourceArray = [{ status: "ready" }] as LeftValue[];
const arrayView: RightValue[] = sourceArray;
console.log(project(input));
console.log(JSON.stringify(arrayView));
console.log(render([{ status: "ready" }]));
console.log(render({ status: "ready" }));
console.log(guardedRecursiveAlias([1, { status: "ready" }]));
console.log(guardedRecord({ status: "ready" }));
const decoded = JSON.parse('{"status":"ready"}') as LeftValue;
console.log(guardedUnknown(decoded));
