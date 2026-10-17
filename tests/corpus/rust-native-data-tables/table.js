const Endpoints = {
  projects: {
    read: ["GET /projects", { headers: { accept: "json" } }, { renamed: ["read", "get"] }],
    write: ["POST /projects", {}, { mapToData: "body" }],
    remove: ["DELETE /projects"]
  },
  flags: [true, false, null, -0, 12],
  empty: { record: {}, array: [] }
};
console.log("before alias", endpoints_default === undefined);
var endpoints_default = Endpoints;
export function table() { return Endpoints; }
export { Endpoints, endpoints_default as default };
