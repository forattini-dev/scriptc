export interface Event {
  collection: string;
  bytes?: number;
  [key: string]: unknown;
}
export let state: Event = { collection: "events", bytes: 10 };
export { state as aliasState };
export default state;
export function echo(event: Event): Event { return event; }
export function read(): number { return state.bytes ?? 0; }
export function replace(): void { state = { collection: "replacement", bytes: 90 }; }
export async function update(event: Event): Promise<Event> {
  event.bytes = (event.bytes ?? 0) + 1;
  await Promise.resolve();
  event.bytes = (event.bytes ?? 0) + 1;
  event.extra = "updated";
  return event;
}
