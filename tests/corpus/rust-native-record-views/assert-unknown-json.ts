type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
interface Failure extends JsonObject { name: string }
type Payload = { exit_code: number | null; summary: string; failures?: Failure[] };

function withHelp(value: JsonObject): JsonObject {
  value.help = ["try again"];
  return value;
}

const payload: Payload = { exit_code: 2, summary: "failed" };
payload.failures = [{ name: "example" }];
const result = true
  ? withHelp(payload as unknown as JsonObject) as unknown as Payload
  : payload;
console.log(result.exit_code, result.summary);
