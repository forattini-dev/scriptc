type Outcome = "present" | "skipped";

function run(): void {
  const open = (): {
    finish: (outcome: Outcome, detail?: string) => void;
  } => {
    const finish = (outcome: Outcome, detail?: string): void => {
      if (detail) console.log(detail);
      console.log(outcome);
    };
    return { finish };
  };

  const { finish } = open();
  finish("present");
}

run();
