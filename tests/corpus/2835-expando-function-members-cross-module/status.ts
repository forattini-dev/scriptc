// The `statuses` shape, spelled in TS: a module whose DEFAULT EXPORT is a
// function carrying data tables as expando members. The members are
// written at module scope BELOW the declaration and read both from inside
// the module (the function's own body, which runs only after the writes)
// and from the importer.
const messages: { [code: number]: string } = { 200: "OK", 404: "Not Found", 500: "Internal Server Error" };

export default function status(code: number): string {
  // A member read from INSIDE the declaring function's body — the same
  // storage the module-scope writes below fill. Only KNOWN codes are
  // looked up: a missing index-signature key is a separate story (Node
  // answers undefined, which `string` cannot hold).
  return status.message[code];
}

status.message = messages;
status.empty = { 204: true, 205: true, 304: true };
status.codes = [200, 204, 304, 404, 500];
status.label = "http";
status.describe = function describe(code: number): string {
  return code + " " + status(code);
};
