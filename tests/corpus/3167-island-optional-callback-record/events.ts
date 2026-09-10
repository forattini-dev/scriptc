export async function run(callback: (value: unknown) => Promise<unknown>): Promise<string> {
  return JSON.stringify([await callback({ mode: 'local' }), await callback(undefined)]);
}
