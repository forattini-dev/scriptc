export {};

function cleanupFocus(this: { count: number }): void {
  console.log(`${cleanupFocus.kind}:${this.count}`);
}

cleanupFocus.kind = "focus";

const state: {
  count: number;
  cleanupFocusSubscription: typeof cleanupFocus | null;
} = {
  count: 7,
  cleanupFocusSubscription: null,
};

state.cleanupFocusSubscription = cleanupFocus;
state.cleanupFocusSubscription?.();

const absent: typeof state = {
  count: 9,
  cleanupFocusSubscription: null,
};
absent.cleanupFocusSubscription?.();

interface CompiledQuery {
  (value: unknown): boolean;
  shouldTestNextSiblings?: boolean;
}

const boolbase = {
  falseFunc: function falseFunc(): boolean {
    return false;
  },
};

function selectSentinel(): CompiledQuery {
  return boolbase.falseFunc;
}

const sentinel = selectSentinel();
console.log(
  "sentinel",
  sentinel({ ignored: true }),
  sentinel === boolbase.falseFunc,
  sentinel.shouldTestNextSiblings,
);
sentinel.shouldTestNextSiblings = true;
console.log(
  "sentinel-mutated",
  (boolbase.falseFunc as CompiledQuery).shouldTestNextSiblings,
  sentinel === boolbase.falseFunc,
);
