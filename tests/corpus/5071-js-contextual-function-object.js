// @ts-nocheck
function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment }, onError) {
  if (ctx && onError) onError(pos);
  return `${offset}:${before === undefined}:${spaceBefore}:${comment}`;
}

/**
 * @type {{ composeEmptyNode: (
 *   ctx: any,
 *   offset: number,
 *   before: any,
 *   pos: any,
 *   props: { spaceBefore: boolean, comment: string },
 *   onError: any
 * ) => string }}
 */
const CN = { composeEmptyNode };

console.log(
  composeEmptyNode(null, 1, undefined, null, { spaceBefore: false, comment: "direct" }, null),
);
console.log(
  CN.composeEmptyNode(null, 2, "token", null, { spaceBefore: true, comment: "view" }, null),
);
