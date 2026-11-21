interface Recorder {
  record(value: string): Promise<void>;
}

async function run(recorder?: Recorder): Promise<string> {
  await recorder?.record("seen");
  return "done";
}

const recorder: Recorder = {
  record(value) {
    console.log(value);
    return Promise.resolve();
  },
};

run(undefined).then((value) => console.log(value));
run(recorder).then((value) => console.log(value));
