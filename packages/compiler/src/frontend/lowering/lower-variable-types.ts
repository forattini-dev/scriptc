import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import { DYN, JSVAL, type IrType } from "../../ir/ir.js";
import { dynFallbackType, importCallHandleType, uncheckedOverloadHandleCall, type Lowerer } from "./lowerer.js";
import { nativeImportHandleType } from "./lower-native-import-types.js";

/** The `var` symbol's function-scoped binding TYPE — the declared type at
 * the binding name, with the JS-source fallbacks every mutable binding
 * takes (an empty-object-literal type is checked-dynamic because tsc
 * admits ANY later assignment to it; an unmappable strict type in a JS
 * file rides the dyn fallback). Null when no static type can hold the
 * binding. */
export function varBindingType(L: Lowerer, nameNode: ts.Identifier): IrType | null {
  let type = nativeImportHandleType(L, nameNode) ?? L.mapTypeOf(L.typeOf(nameNode));
  if (type?.kind === "record" && isJsSourceFile(nameNode.getSourceFile())) {
    const shape = L.shapes.get(type.shapeId);
    if (shape && shape.fields.length === 0 && !shape.indexValue && !shape.tuple) type = DYN;
  }
  if (!type) type = dynFallbackType(L, nameNode, L.typeOf(nameNode));
  // `var p = import("./m")` in a function body: the hoisted slot holds
  // the island promise/handle — the import expression's only production
  // (lowerVarDecl's rule for block-scoped bindings).
  if (L.dynamic && ts.isVariableDeclaration(nameNode.parent) && nameNode.parent.name === nameNode) {
    type =
      importCallHandleType(nameNode.parent.initializer) ??
      // An unchecked-overload call result stores the handle, exactly the
      // let/const rule (see uncheckedOverloadHandleCall).
      (uncheckedOverloadHandleCall(L, nameNode.parent.initializer) ? JSVAL : null) ??
      type;
  }
  if (!type || type.kind === "void") return null;
  return type;
}
