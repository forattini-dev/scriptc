// @dynamic
type Request =
  | { id: string; op: "ping"; self?: true }
  | { id: string; op: "worker-start"; worker: string };

type RequestBody = Request extends infer Member
  ? Member extends { id: string }
    ? Omit<Member, "id">
    : never
  : never;

function withId(request: RequestBody, id: string): Request {
  return { ...request, id } as Request;
}

function printRequest(request: Request): void {
  if (request.op === "ping") console.log(request.op, request.self, request.id);
  else console.log(request.op, request.worker, request.id);
}

printRequest(withId({ op: "ping", self: true }, "req-1"));
printRequest(withId({ op: "worker-start", worker: "agent-7" }, "req-2"));
