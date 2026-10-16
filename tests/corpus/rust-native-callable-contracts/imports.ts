// @rust-only
// @no-engine
import { endpoint } from "./api.js";
const alias = endpoint;
console.log("JS callable", endpoint(4), endpoint.parse(3), endpoint.offset, alias === endpoint);
alias.offset = 10;
console.log("JS alias", endpoint.offset, endpoint(5));
