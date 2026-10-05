// @ts-nocheck
class Protocol {
  contentType() {
    console.log("base-called");
    throw new Error("implementation missing");
  }
}
class JsonProtocol extends Protocol {
  contentType() { return "application/json"; }
}
/** @param {Protocol} protocol */
function printContentType(protocol) {
  console.log(protocol.contentType());
}
printContentType(new JsonProtocol());
try { printContentType(new Protocol()); }
catch (error) { console.log(error.message); }
