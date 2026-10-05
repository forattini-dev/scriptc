import { Client } from "null-default";
new Client({ id: "explicit", payload: 1 });
new Client({ payload: 2 });
new Client({ id: undefined, payload: 3 });
new Client({ id: null, payload: 4 });
