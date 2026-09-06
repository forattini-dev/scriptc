// @rust-only
// Schema classes as native classes: Schema.Class / TaggedClass (data),
// Schema.ErrorClass / TaggedErrorClass (yieldable errors with the Error
// base): props from the fields literal, `_tag`, optional props, getters,
// `yield* new E(...)`, Effect.fail with a class, catchTag by tag, catch
// over a union of error classes, runSync throwing the error itself, and
// inspect/toString of instances.
import { Effect, Exit, Schema } from "effect";

class Person extends Schema.Class<Person>("Person")({
  name: Schema.String,
  age: Schema.Number,
  nick: Schema.optional(Schema.String),
}) {
  greet(): string {
    return `hi ${this.name} (${this.age})`;
  }
}

class Info extends Schema.TaggedClass<Info>()("Info", { id: Schema.String, n: Schema.Number }) {
  get label(): string {
    return `${this.id}#${this.n}`;
  }
}

class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
  message: Schema.String,
  id: Schema.Number,
  extra: Schema.optional(Schema.String),
}) {
  get detail(): string {
    return `${this._tag}/${this.id}: ${this.message}`;
  }
}

class Busy extends Schema.TaggedErrorClass<Busy>()("Busy", {}) {}

class Werr extends Schema.ErrorClass<Werr>("Werr")({ message: Schema.String, code: Schema.Number }) {}

const p = new Person({ name: "ana", age: 31 });
console.log(p.greet(), p.name, p.age, p.nick);
console.log(p);
console.log(new Person({ name: "bo", age: 2, nick: "b" }));

const i = new Info({ id: "a", n: 2 });
console.log(i.label, i._tag, i.id + i.n);
console.log(i);
console.log([i, new Info({ id: "z", n: 0 })]);

const e = new NotFound({ message: "missing", id: 7 });
console.log(e._tag, e.name, e.message, e.id, e.extra, e.detail);
console.log(String(e), `${e}`, e instanceof Error, e instanceof NotFound);
console.log(e);
console.log(new NotFound({ message: "with extra", id: 8, extra: "x" }));

const b = new Busy({});
console.log(b._tag, b.name, JSON.stringify(b.message), String(b));
console.log(b);

const w = new Werr({ message: "boom", code: 3 });
console.log(w.name, w.message, w.code, String(w), w instanceof Error);
console.log(w);

// Yieldable errors and tagged recovery.
const lookup = (id: number) =>
  Effect.gen(function* () {
    if (id < 0) {
      yield* new NotFound({ message: `no ${id}`, id });
    }
    if (id === 0) {
      yield* new Busy({});
    }
    if (id > 100) {
      return yield* Effect.fail(new Werr({ message: "too big", code: id }));
    }
    return id * 2;
  });

const recovered = (id: number) =>
  lookup(id).pipe(
    Effect.catchTag("NotFound", (err) => Effect.succeed(err.id * 1000)),
    Effect.catchTag("Busy", (err) => Effect.succeed(err._tag.length)),
    Effect.catch((err) => Effect.succeed(err.code)),
  );
console.log(Effect.runSync(recovered(5)), Effect.runSync(recovered(-3)), Effect.runSync(recovered(0)), Effect.runSync(recovered(500)));

// A union failure channel observed whole.
const described = (id: number) =>
  lookup(id).pipe(
    Effect.catch((err) => Effect.succeed(err instanceof NotFound ? err.detail : err instanceof Busy ? "busy!" : `werr ${err.code}`)),
  );
console.log(Effect.runSync(described(-1)), Effect.runSync(described(0)), Effect.runSync(described(101)));

const exit = Effect.runSyncExit(lookup(-9));
console.log(Exit.isFailure(exit), Exit.isSuccess(Effect.runSyncExit(lookup(1))));

try {
  Effect.runSync(lookup(-2));
} catch (err) {
  if (err instanceof NotFound) console.log("thrown:", err.name, err.message, err.id);
  else console.log("thrown other", err);
}

Effect.runPromise(lookup(-4)).then(
  (v) => console.log("fulfilled", v),
  (err: unknown) => console.log("rejected:", err instanceof NotFound, err instanceof Error, String(err)),
);
