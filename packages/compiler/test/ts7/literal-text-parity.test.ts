import { expect, test } from "vitest";
import { ad, buildTwoWorlds, ts5, walkBoth } from "./harness.js";

const SOURCE = [
  'const stringLiteral = "\\uFEFFabc";',
  "const noSubstitution = `\\uFEFFabc`;",
  "const interpolation = `\\uFEFFhead${1}\\uFEFFtail`;",
  'const keyed = { "\\uFEFFkey": 1 };',
].join("\n");

function cookedTexts5(nodes: readonly ts5.Node[]): string[] {
  return nodes.flatMap((node) =>
    ts5.isStringLiteralLike(node) ||
    node.kind === ts5.SyntaxKind.TemplateHead ||
    node.kind === ts5.SyntaxKind.TemplateMiddle ||
    node.kind === ts5.SyntaxKind.TemplateTail
      ? [(node as ts5.StringLiteralLike | ts5.TemplateLiteralLikeNode).text]
      : []
  );
}

function cookedTexts7(nodes: readonly ad.Node[]): string[] {
  return nodes.flatMap((node) =>
    ad.isStringLiteralLike(node) ||
    node.kind === ad.SyntaxKind.TemplateHead ||
    node.kind === ad.SyntaxKind.TemplateMiddle ||
    node.kind === ad.SyntaxKind.TemplateTail
      ? [(node as ad.StringLiteralLike | ad.TemplateLiteralLikeNode).text]
      : []
  );
}

test("remote string-table decoding preserves a leading U+FEFF as literal data", () => {
  const worlds = buildTwoWorlds({ "leading-feff.ts": SOURCE });
  try {
    const file = worlds.files[0];
    if (file === undefined) throw new Error("fixture path missing");
    const nodes = walkBoth(worlds, file);
    const expected = cookedTexts5(nodes.n5);
    expect(cookedTexts7(nodes.n7)).toEqual(expected);
    expect(expected).toContain("\uFEFFabc");
    expect(expected).toContain("\uFEFFhead");
    expect(expected).toContain("\uFEFFtail");
    expect(expected).toContain("\uFEFFkey");
  } finally {
    worlds.dispose();
  }
});
