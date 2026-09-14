// @rust-only
// Generic members of service interfaces as closure-FAMILY slots: the
// receiver's implementation is not statically provable (it comes from a
// factory, an array, or a conditional), so `bus.publish(def, ...)` dispatches
// on the stored family value at this call's instantiation. Covers arrow and
// object-literal-method implementations, captured mutable state, several
// instantiations, callbacks typed by the type parameter, and identity.
interface Definition { readonly type: string }
type Payload<D extends Definition> = { readonly definition: D; readonly seq: number };

interface Events {
  readonly project: <D extends Definition>(definition: D, projector: (payload: Payload<D>) => void) => number;
  readonly publish: <D extends Definition>(definition: D, data: string) => string;
  readonly count: () => number;
}

function arrowEvents(prefix: string): Events {
  let seq = 0;
  const project = <D extends Definition>(definition: D, projector: (payload: Payload<D>) => void): number => {
    seq++;
    projector({ definition, seq });
    return seq;
  };
  const publish = <D extends Definition>(definition: D, data: string): string => `${prefix}:${definition.type}:${data}:${++seq}`;
  return { project, publish, count: () => seq };
}

function literalEvents(prefix: string): Events {
  const seen: string[] = [];
  return {
    project<D extends Definition>(definition: D, projector: (payload: Payload<D>) => void): number {
      seen.push(definition.type);
      projector({ definition, seq: seen.length * 10 });
      return seen.length;
    },
    publish<D extends Definition>(definition: D, data: string): string {
      seen.push(data);
      return `${prefix}[${seen.join(",")}]<${definition.type}>`;
    },
    count: () => seen.length,
  };
}

const Created = { type: "created", id: 7 } as const;
const Moved = { type: "moved", to: "north" } as const;

const all: Events[] = [arrowEvents("a"), literalEvents("l"), arrowEvents("b")];
for (const events of all) {
  events.project(Created, (payload) => console.log(payload.definition.type, payload.definition.id, payload.seq));
  events.project(Moved, (payload) => console.log(payload.definition.type, payload.definition.to, payload.seq));
  console.log(events.publish(Created, "x"), events.publish({ type: "adhoc" }, "y"), events.count());
}

const pick = (literal: boolean): Events => (literal ? literalEvents("p") : arrowEvents("q"));
const chosen = pick(Math.random() >= 0);
console.log(chosen.publish(Moved, "z"), chosen === chosen, all[0] === all[2]);
