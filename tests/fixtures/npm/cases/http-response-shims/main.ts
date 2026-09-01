// @dynamic
// The island's node:http write side — OutgoingMessage and ServerResponse —
// against Node. express/lib/response.js does
// Object.create(http.ServerResponse.prototype) at module load, so the
// constructors, the prototype chain and the whole header/status surface
// have to exist before express can even be required. reszoo reproduces
// that shape (and the EventEmitter mixin express performs on its `app`
// function) without vendoring express itself.
import { report } from "reszoo";

const out: string = report();
console.log(out);
