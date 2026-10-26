// @rust-only
// @no-engine
type Packet = {value: number; optional?: string};
const packet: Packet = {value: 1};
const row = [1, 2];
function roundTrip(value: Packet | number[] | string): void {
  try { throw value; }
  catch (caught) {
    console.log("identity", caught === value);
    if (typeof caught === "object" && caught !== null && !Array.isArray(caught)) {
      console.log("record", "value" in caught, "optional" in caught);
    }
    try { throw caught; }
    catch (again) { console.log("rethrow", again === value); }
  }
}
roundTrip(packet); roundTrip(row); roundTrip("text");
try { throw packet; } catch (caught) {
  if (typeof caught !== "object" || caught === null) throw caught;
  packet.optional = undefined;
  console.log("live", "optional" in caught, Object.hasOwn(packet, "optional"), caught === packet);
  delete packet.optional;
  console.log("live-delete", "optional" in caught);
}
