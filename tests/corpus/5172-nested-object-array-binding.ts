function main(): void {
  const source: [{ commandPath: string }, { runLaunchTarget: number }] = [
    { commandPath: "native" },
    { runLaunchTarget: 7 },
  ];
  const [{ commandPath }, { runLaunchTarget }] = source;
  console.log(commandPath);
  console.log(runLaunchTarget);
}

main();
