type SqlParam = string | number | boolean | null | Uint8Array;

function encodeParam(param: SqlParam): string | number | boolean | null | { $hex: string } {
  if (param !== null && typeof param === "object") {
    return { $hex: Buffer.from(param).toString("hex") };
  }
  return param;
}

function encodeParams(params: SqlParam[]): string {
  return JSON.stringify(params.map(encodeParam));
}

console.log(encodeParams(["a", 1, true, null, new Uint8Array([0xde, 0xad])]));

type ListParam = string | number[] | null;

function encodeList(param: ListParam): string {
  if (Array.isArray(param)) return Buffer.from(param).toString("hex");
  return param === null ? "null" : param;
}

const listParams: ListParam[] = [null, [1, 254], "text"];
console.log(listParams.map(encodeList).join("|"));
