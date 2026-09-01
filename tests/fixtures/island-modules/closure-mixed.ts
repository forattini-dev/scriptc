// @dynamic
// A marshaled closure with the widened host signatures: a NUMBER
// parameter beside the string one. Before the marshaling funnel grew,
// only all-string parameter lists crossed as host functions.
import { render } from "callbackzoo";

console.log(render((count, text) => `${count}:${text.length}`));
