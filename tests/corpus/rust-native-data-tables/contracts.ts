// @rust-only
// @no-engine
import endpoints, { Endpoints, table } from "./table.js";
import { second } from "./aliases.js";
console.log("identity", endpoints === Endpoints, second === endpoints, table() === endpoints);
const data = endpoints as any;
console.log("routes", data.projects.read[0] === "GET /projects", data.projects.write[0] === "POST /projects", data.projects.remove[0] === "DELETE /projects");
console.log("options", data.projects.read[1].headers.accept === "json", data.projects.read[2].renamed[0] === "read", data.projects.write[2].mapToData === "body");
console.log("absence", data.projects.read[1].renamed === undefined, data.projects.read[2].headers === undefined);
console.log("arrays", data.flags[0] === true, data.flags[2] === null, data.flags[3] === 0, data.flags.length === 5, data.empty.array.length === 0);
