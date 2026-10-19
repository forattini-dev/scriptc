import * as target from "./tdz.ts";
const saved = target;
try { console.log("early", saved.pending); } catch (error) {
  if (error instanceof Error) { console.log("tdz", error.name, error.message); }
  else { throw error; }
}
try { saved.writeEarly(); } catch (error) {
  if (error instanceof Error) { console.log("write tdz", error.name, error.message); }
  else { throw error; }
}
