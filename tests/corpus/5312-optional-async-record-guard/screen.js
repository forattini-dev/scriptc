// @ts-nocheck
export async function navigate(fromScreen) {
  if (fromScreen?.onBeforeExit) {
    const canExit = await fromScreen.onBeforeExit();
    if (canExit === false) return false;
  }
  return true;
}

export function update(cell) {
  cell.set(true);
}
