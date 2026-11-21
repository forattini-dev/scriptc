export {};

interface Adapter {
  values(): Promise<Array<{ value: number }>>;
}

const adapter: Adapter = {
  values() {
    return Promise.all([
      Promise.resolve({ value: 4 }),
      Promise.resolve({ value: 9 }),
    ]);
  },
};

function main(): void {
  adapter.values().then((entries) =>
    console.log(entries.map((entry) => entry.value).join(",")),
  );
}

main();
