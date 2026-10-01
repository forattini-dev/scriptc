// @rust-only
// @no-engine
// A direct record receiver preserves missing slots until property lookup.
type Row = { id: number };
let effects = "";
function rows(present: boolean): Row[] {
  effects += "receiver;";
  return present ? [{ id: 7 }] : [];
}
function index(): number {
  effects += "index;";
  return 0;
}
console.log("present", (rows(true)[index()]).id, effects);
effects = "";
try {
  console.log("missing", (rows(false)[index()]).id);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
console.log("effects", effects);
const sparse: Row[] = [{ id: 1 }];
sparse.length = 2;
try {
  console.log("hole", sparse[1].id);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
try {
  console.log("negative", sparse[-1].id);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
