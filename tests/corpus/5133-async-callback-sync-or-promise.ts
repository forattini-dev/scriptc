interface Migration {
  applies: (value: number) => boolean | Promise<boolean>;
}

export {};

const migrations: Migration[] = [
  {
    applies: async (value) => {
      return value > 2;
    },
  },
];

void Promise.resolve(migrations[0].applies(3)).then((value) => console.log(value));
