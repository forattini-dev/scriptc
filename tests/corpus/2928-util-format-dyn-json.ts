// util.format's %j over checked-dynamic values uses the same JSON walk as
// JSON.stringify: object properties with undefined values disappear, array
// positions become null, and an omitted root renders as the word undefined.
import { format } from "node:util";

const parsed: unknown = JSON.parse('{"name":"scriptc","values":[1,true,null]}');
console.log(format("json:%j", parsed));

const nested: unknown = { keep: 1, drop: undefined, list: [undefined, 2] };
console.log(format("%j", nested));

const absent: unknown = undefined;
console.log(format("<%j>", absent));

const callable: unknown = () => 1;
console.log(format("<%j>", callable));
