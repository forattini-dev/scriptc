// @dynamic
// Agent-written clients commonly hide an untyped package transport behind a
// typed async protocol whose success payload intentionally remains unknown.
import { sendRequest } from "wire-client";

type Request = { id: string; op: "status" };
type Response =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string };

async function requestStatus(request: Request): Promise<Response> {
  return await sendRequest<Request, Response>(request);
}

const response = await requestStatus({ id: "req-1", op: "status" });
if (response.ok) {
  const value = response.value as { count: number; label: string };
  console.log(response.id, response.ok, value.label, value.count);
} else {
  console.log(response.id, response.ok, response.error);
}
