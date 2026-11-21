let count = 0;
function side() { count++; return 1; }
function exercise(item: any) {
  try {
    (item as any).map(side());
  } catch (error) {
    console.log((error as Error).name, (error as Error).message, count);
  }
}
exercise({ map: 0 });
exercise({ map: undefined });
