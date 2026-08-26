import type { RustClosureShape } from "./model.js";

export interface RustDynamicInvokeContext {
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  closureName(shape: RustClosureShape): string;
  dynFunctionVariant(shape: RustClosureShape): string;
  dynTypeName(): string;
}

/** Emit prototype dispatch for checked-dynamic values. */
export function emitRustDynamicInvoke(
  context: RustDynamicInvokeContext,
  boxedShapes: readonly RustClosureShape[],
): void {
  new RustDynamicInvokeEmitter(context, boxedShapes).emit();
}

class RustDynamicInvokeEmitter {
  private readonly dyn: string;
  private readonly functionPatterns: string;

  constructor(
    private readonly context: RustDynamicInvokeContext,
    private readonly boxedShapes: readonly RustClosureShape[],
  ) {
    this.dyn = context.dynTypeName();
    this.functionPatterns = boxedShapes
      .map((shape) => `${this.dyn}::${context.dynFunctionVariant(shape)}(..)`)
      .join(" | ");
  }

  emit(): void {
    this.emitIndexHelpers();
    this.emitValueHelpers();
    this.emitThisHelpers();
    this.emitFunctionCacheHelpers();
    this.emitDefinePropertiesHelper();
    this.emitArrayCallbacks();
    this.emitArraySortHelpers();
    this.emitDispatcher();
  }

  private emitIndexHelpers(): void {
    this.open(`fn sc_dyn_index_arg(args: &[${this.dyn}], index: usize, default: f64, callee_name: &str) -> f64 {`);
    this.open("match args.get(index) {");
    this.context.line(`None | Some(${this.dyn}::Undefined) => default,`);
    this.context.line(`Some(${this.dyn}::Number(value)) if value.is_nan() => 0.0,`);
    this.context.line(`Some(${this.dyn}::Number(value)) => value.trunc(),`);
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name}: non-number index arguments on a dynamic receiver are not supported yet\")),");
    this.close("}");
    this.close("}");
  }

  private emitValueHelpers(): void {
    this.open(`fn sc_dyn_truthy(value: &${this.dyn}) -> bool {`);
    this.open("match value {");
    this.context.line(`${this.dyn}::Undefined | ${this.dyn}::Null => false,`);
    this.context.line(`${this.dyn}::Number(value) => *value != 0.0 && !value.is_nan(),`);
    this.context.line(`${this.dyn}::Boolean(value) => *value,`);
    this.context.line(`${this.dyn}::String(value) => !value.is_empty(),`);
    this.context.line("_ => true,");
    this.close("}");
    this.close("}");

    this.open(`fn sc_dyn_strict_equal(left: &${this.dyn}, right: &${this.dyn}) -> bool {`);
    this.open("match (left, right) {");
    this.context.line(`(${this.dyn}::Undefined, ${this.dyn}::Undefined) | (${this.dyn}::Null, ${this.dyn}::Null) => true,`);
    this.context.line(`(${this.dyn}::Number(left), ${this.dyn}::Number(right)) => left == right,`);
    this.context.line(`(${this.dyn}::Boolean(left), ${this.dyn}::Boolean(right)) => left == right,`);
    this.context.line(`(${this.dyn}::String(left), ${this.dyn}::String(right)) => left.as_ref() == right.as_ref(),`);
    this.context.line(`(${this.dyn}::Bytes(left), ${this.dyn}::Bytes(right)) => left.ptr_eq(right),`);
    this.context.line(`(${this.dyn}::Buffer(left), ${this.dyn}::Buffer(right)) => left.ptr_eq(right),`);
    this.context.line(`(${this.dyn}::Array(left), ${this.dyn}::Array(right)) => left.ptr_eq(right),`);
    this.context.line(`(${this.dyn}::Object(left), ${this.dyn}::Object(right)) => left.ptr_eq(right),`);
    this.context.line(`(${this.dyn}::Promise(left), ${this.dyn}::Promise(right)) => runtime::promise_handle_identity(left) == runtime::promise_handle_identity(right),`);
    this.context.line(`(${this.dyn}::NetServer(left), ${this.dyn}::NetServer(right)) => left.ptr_eq(right),`);
    this.context.line(`(${this.dyn}::NetSocket(left), ${this.dyn}::NetSocket(right)) => left.ptr_eq(right),`);
    for (const pattern of this.functionVariants()) {
      this.context.line(`(${this.dyn}::${pattern}(left, _, _), ${this.dyn}::${pattern}(right, _, _)) => left.identity() == right.identity(),`);
    }
    this.context.line("_ => false,");
    this.close("}");
    this.close("}");

    this.context.line(`fn sc_dyn_same_value_zero(left: &${this.dyn}, right: &${this.dyn}) -> bool {`);
    this.context.pushIndent();
    this.context.line(`matches!((left, right), (${this.dyn}::Number(a), ${this.dyn}::Number(b)) if a.is_nan() && b.is_nan()) || sc_dyn_strict_equal(left, right)`);
    this.context.popIndent();
    this.context.line("}");
  }

  private emitArrayCallbacks(): void {
    this.open(`fn sc_dyn_array_callback(callback: &${this.dyn}, item: ${this.dyn}, index: f64, array: &runtime::JsArray<${this.dyn}>) -> ${this.dyn} {`);
    this.context.line(`let args = [item, ${this.dyn}::Number(index), ${this.dyn}::Array(array.clone())];`);
    this.context.line("sc_dyn_call(callback, &args, \"callback\")");
    this.close("}");

    this.open(`fn sc_dyn_array_iterate(array: &runtime::JsArray<${this.dyn}>, method: &str, args: &[${this.dyn}]) -> ${this.dyn} {`);
    this.context.line(`let callback = args.first().cloned().unwrap_or(${this.dyn}::Undefined);`);
    this.context.line(`let output: runtime::JsArray<${this.dyn}> = runtime::array_new(Vec::new());`);
    this.context.line("let length = runtime::array_len(array);");
    this.context.line("let mut index = 0.0;");
    this.open("while index < length && index < runtime::array_len(array) {");
    this.context.line("let item = runtime::array_get(array, index);");
    this.context.line("let result = sc_dyn_array_callback(&callback, item.clone(), index, array);");
    this.open("match method {");
    this.context.line(`"map" => { runtime::array_push(&output, result); },`);
    this.context.line(`"filter" if sc_dyn_truthy(&result) => { runtime::array_push(&output, item.clone()); },`);
    this.context.line(`"some" if sc_dyn_truthy(&result) => return ${this.dyn}::Boolean(true),`);
    this.context.line(`"every" if !sc_dyn_truthy(&result) => return ${this.dyn}::Boolean(false),`);
    this.context.line("\"find\" if sc_dyn_truthy(&result) => return item,");
    this.context.line(`"findIndex" if sc_dyn_truthy(&result) => return ${this.dyn}::Number(index),`);
    this.context.line("_ => {},");
    this.close("}");
    this.context.line("index += 1.0;");
    this.close("}");
    this.open("match method {");
    this.context.line(`"map" | "filter" => ${this.dyn}::Array(output),`);
    this.context.line(`"some" => ${this.dyn}::Boolean(false),`);
    this.context.line(`"every" => ${this.dyn}::Boolean(true),`);
    this.context.line(`"find" | "forEach" => ${this.dyn}::Undefined,`);
    this.context.line(`"findIndex" => ${this.dyn}::Number(-1.0),`);
    this.context.line("_ => unreachable!(\"scriptc invariant: invalid dynamic array iterator\"),");
    this.close("}");
    this.close("}");
  }

  private emitArraySortHelpers(): void {
    this.open(`fn sc_dyn_sort_compare(left: &${this.dyn}, right: &${this.dyn}, comparator: Option<&${this.dyn}>) -> std::cmp::Ordering {`);
    this.context.line(`if matches!(left, ${this.dyn}::Undefined) { return if matches!(right, ${this.dyn}::Undefined) { std::cmp::Ordering::Equal } else { std::cmp::Ordering::Greater }; }`);
    this.context.line(`if matches!(right, ${this.dyn}::Undefined) { return std::cmp::Ordering::Less; }`);
    this.open("if let Some(comparator) = comparator {");
    this.context.line("let result = sc_dyn_call(comparator, &[left.clone(), right.clone()], \"comparefn\");");
    this.open("let value = match result {");
    this.context.line(`${this.dyn}::Number(value) => value,`);
    this.context.line(`${this.dyn}::Boolean(value) => if value { 1.0 } else { 0.0 },`);
    this.context.line("_ => 0.0,");
    this.close("};");
    this.context.line("return if value < 0.0 { std::cmp::Ordering::Less } else if value > 0.0 { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal };");
    this.close("}");
    this.context.line("sc_dyn_to_string(left).as_bytes().cmp(sc_dyn_to_string(right).as_bytes())");
    this.close("}");

    const callable = this.functionPatterns === ""
      ? `${this.dyn}::Undefined`
      : `${this.dyn}::Undefined | ${this.functionPatterns}`;
    this.open(`fn sc_dyn_array_sort(array: &runtime::JsArray<${this.dyn}>, args: &[${this.dyn}]) -> ${this.dyn} {`);
    this.context.line(`let comparator = args.first().cloned().unwrap_or(${this.dyn}::Undefined);`);
    this.context.line(`if !matches!(&comparator, ${callable}) { runtime::throw_type_error(format!("The comparison function must be either a function or undefined: {}", sc_dyn_to_string(&comparator))); }`);
    this.context.line(`let comparator = if matches!(&comparator, ${this.dyn}::Undefined) { None } else { Some(&comparator) };`);
    this.context.line(`${this.dyn}::Array(runtime::array_sort_by_snapshot(array, |left, right| sc_dyn_sort_compare(left, right, comparator)))`);
    this.close("}");
  }

  private emitThisHelpers(): void {
    this.context.line("std::thread_local! {");
    this.context.pushIndent();
    this.context.line(`static SC_DYN_THIS: std::cell::RefCell<Vec<${this.dyn}>> = const { std::cell::RefCell::new(Vec::new()) };`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("struct ScDynThisGuard;");
    this.open("impl Drop for ScDynThisGuard {");
    this.open("fn drop(&mut self) {");
    this.context.line("SC_DYN_THIS.with(|stack| { stack.borrow_mut().pop(); });");
    this.close("}");
    this.close("}");
    this.open(`fn sc_dyn_this_push(value: ${this.dyn}) -> ScDynThisGuard {`);
    this.context.line("SC_DYN_THIS.with(|stack| stack.borrow_mut().push(value));");
    this.context.line("ScDynThisGuard");
    this.close("}");
    this.open(`fn sc_dyn_this_get() -> ${this.dyn} {`);
    this.context.line(`SC_DYN_THIS.with(|stack| stack.borrow().last().cloned().unwrap_or(${this.dyn}::Undefined))`);
    this.close("}");
  }

  private emitDefinePropertiesHelper(): void {
    const callableTarget = this.functionPatterns === ""
      ? `${this.dyn}::Object(..)`
      : `${this.dyn}::Object(..) | ${this.functionPatterns}`;
    this.open(`fn sc_dyn_define_properties(target: &${this.dyn}, descriptors: &${this.dyn}) -> ${this.dyn} {`);
    this.context.line(`if !matches!(target, ${callableTarget}) { runtime::throw_type_error("Object.defineProperties called on non-object".to_owned()); }`);
    this.context.line(`let ${this.dyn}::Object(descriptors) = descriptors else { runtime::throw_type_error("Object.defineProperties called on non-object".to_owned()); };`);
    this.context.line("let mut index = 0.0;");
    this.open("while index < runtime::map_iter_count(descriptors) {");
    this.open("if runtime::map_iter_live(descriptors, index) {");
    this.context.line("let key = runtime::map_iter_key(descriptors, index);");
    this.context.line("let descriptor = runtime::map_iter_value(descriptors, index);");
    this.context.line(`let ${this.dyn}::Object(fields) = &descriptor else { runtime::throw_type_error(format!("Property description must be an object: {}", sc_dyn_to_string(&descriptor))); };`);
    this.context.line("if runtime::map_has_by(fields, &runtime::string(\"get\"), |left, right| left.as_ref() == right.as_ref()) || runtime::map_has_by(fields, &runtime::string(\"set\"), |left, right| left.as_ref() == right.as_ref()) { runtime::throw_error(\"accessor (get/set) property descriptors on a dynamic value are not supported yet\".to_owned()); }");
    this.context.line(`let value = runtime::map_get_by(fields, &runtime::string("value"), |left, right| left.as_ref() == right.as_ref()).unwrap_or(${this.dyn}::Undefined);`);
    this.context.line("sc_dyn_key_set(target, key, value);");
    this.close("}");
    this.context.line("index += 1.0;");
    this.close("}");
    this.context.line("target.clone()");
    this.close("}");
  }

  private emitFunctionCacheHelpers(): void {
    this.context.line("std::thread_local! {");
    this.context.pushIndent();
    this.context.line(`static SC_DYN_FUNCTION_CACHE: std::cell::RefCell<Vec<(usize, ${this.dyn})>> = const { std::cell::RefCell::new(Vec::new()) };`);
    this.context.popIndent();
    this.context.line("}");
    for (const shape of this.boxedShapes) {
      const variant = this.context.dynFunctionVariant(shape);
      this.open(`fn sc_dyn_box_function_${shape.index}(value: runtime::Gc<${this.context.closureName(shape)}>, function_name: runtime::JsString) -> ${this.dyn} {`);
      this.context.line("let identity = value.identity();");
      this.context.line("if let Some(cached) = SC_DYN_FUNCTION_CACHE.with(|cache| cache.borrow().iter().find(|(candidate, _)| *candidate == identity).map(|(_, value)| value.clone())) { return cached; }");
      this.context.line(`let boxed = ${this.dyn}::${variant}(value, function_name, runtime::map_new());`);
      this.context.line("SC_DYN_FUNCTION_CACHE.with(|cache| cache.borrow_mut().push((identity, boxed.clone())));");
      this.context.line("boxed");
      this.close("}");
    }
    this.open("fn sc_dyn_function_cache_clear() {");
    this.context.line("SC_DYN_FUNCTION_CACHE.with(|cache| cache.borrow_mut().clear());");
    this.close("}");
  }

  private emitDispatcher(): void {
    this.open(`fn sc_dyn_invoke(recv: &${this.dyn}, method: &str, args: &[${this.dyn}], callee_name: &str) -> ${this.dyn} {`);
    this.open("match recv {");
    this.context.line(`${this.dyn}::Undefined | ${this.dyn}::Null => runtime::throw_type_error(format!("Cannot read properties of {} (reading '{method}')", sc_dyn_kind(recv))),`);
    this.emitObjectArm();
    this.emitFunctionArm();
    this.emitStringArm();
    this.emitArrayArm();
    this.emitBytesArm();
    this.emitBufferArm();
    this.emitPromiseArm();
    this.emitNetSocketArm();
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
    this.close("}");
    this.close("}");
  }

  private emitObjectArm(): void {
    this.open(`${this.dyn}::Object(object) => {`);
    this.context.line(`let member = runtime::map_get_by(object, &runtime::string(method), |left, right| left.as_ref() == right.as_ref()).unwrap_or(${this.dyn}::Undefined);`);
    this.context.line("let _this_guard = sc_dyn_this_push(recv.clone());");
    this.context.line("sc_dyn_call(&member, args, callee_name)");
    this.close("},");
  }

  private emitPromiseArm(): void {
    this.open(`${this.dyn}::Promise(promise) => {`);
    this.open("match method {");
    this.context.line(`"catch" => { let callback = args.first().cloned().unwrap_or(${this.dyn}::Undefined); let next = runtime::promise_handle_catch(promise, Box::new(move |reason| { let reason = sc_dyn_from_caught(reason); let _ = sc_dyn_call(&callback, &[reason], "handler"); })); ${this.dyn}::Promise(next) },`);
    this.context.line(`_ => runtime::throw_type_error(format!("recv.{method} is not a function")),`);
    this.close("}");
    this.close("},");
  }

  private emitFunctionArm(): void {
    if (this.functionPatterns === "") return;
    this.open(`value @ (${this.functionPatterns}) => {`);
    this.open("match method {");
    this.context.line("\"apply\" => {");
    this.context.pushIndent();
    this.context.line(`let _this_guard = sc_dyn_this_push(args.first().cloned().unwrap_or(${this.dyn}::Undefined));`);
    this.open("match args.get(1) {");
    this.context.line(`None | Some(${this.dyn}::Undefined) | Some(${this.dyn}::Null) => sc_dyn_call(value, &[], callee_name),`);
    this.context.line(`Some(${this.dyn}::Array(array)) => { let mut call_args = Vec::new(); let mut index = 0.0; while index < runtime::array_len(array) { call_args.push(runtime::array_get(array, index)); index += 1.0; } sc_dyn_call(value, &call_args, callee_name) },`);
    this.context.line("_ => runtime::throw_type_error(\"CreateListFromArrayLike called on non-object\".to_owned()),");
    this.close("}");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`"call" => { let _this_guard = sc_dyn_this_push(args.first().cloned().unwrap_or(${this.dyn}::Undefined)); sc_dyn_call(value, args.get(1..).unwrap_or(&[]), callee_name) },`);
    this.context.line("_ => { let member = sc_dyn_key_get(value, &runtime::string(method), false); let _this_guard = sc_dyn_this_push(value.clone()); sc_dyn_call(&member, args, callee_name) },");
    this.close("}");
    this.close("},");
  }

  private emitStringArm(): void {
    this.open(`${this.dyn}::String(text) => {`);
    this.open("match method {");
    this.context.line(`"slice" => ${this.dyn}::String(runtime::string_slice(text, sc_dyn_index_arg(args, 0, 0.0, callee_name), sc_dyn_index_arg(args, 1, runtime::string_len(text), callee_name))),`);
    this.context.line(`"at" => { let index = sc_dyn_index_arg(args, 0, 0.0, callee_name); let actual = if index < 0.0 { runtime::string_len(text) + index } else { index }; if actual < 0.0 || actual >= runtime::string_len(text) { ${this.dyn}::Undefined } else { ${this.dyn}::String(runtime::string_at(text, index)) } },`);
    this.context.line(`"concat" => { let mut output = text.to_string(); for arg in args { output.push_str(sc_dyn_to_string(arg).as_ref()); } ${this.dyn}::String(runtime::string(&output)) },`);
    this.context.line(`"indexOf" => match args.first() { Some(${this.dyn}::String(search)) => ${this.dyn}::Number(runtime::string_index_of(text, search, 0.0)), _ => runtime::throw_error("'String.prototype.indexOf' on a dynamic value is not supported yet".to_owned()), },`);
    this.context.line(`"lastIndexOf" => match args.first() { Some(${this.dyn}::String(search)) => ${this.dyn}::Number(runtime::string_last_index_of(text, search)), _ => runtime::throw_error("'String.prototype.lastIndexOf' on a dynamic value is not supported yet".to_owned()), },`);
    this.context.line(`"includes" => match args.first() { Some(${this.dyn}::String(search)) => ${this.dyn}::Boolean(runtime::string_includes(text, search, 0.0)), _ => runtime::throw_error("'String.prototype.includes' on a dynamic value is not supported yet".to_owned()), },`);
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
    this.close("}");
    this.close("},");
  }

  private emitArrayArm(): void {
    this.open(`${this.dyn}::Array(array) => {`);
    this.context.line("let length = runtime::array_len(array);");
    this.open("match method {");
    this.context.line(`"push" => { for arg in args { runtime::array_push(array, arg.clone()); } ${this.dyn}::Number(runtime::array_len(array)) },`);
    this.context.line(`"pop" => if length == 0.0 { ${this.dyn}::Undefined } else { runtime::array_pop(array) },`);
    this.context.line(`"shift" => if length == 0.0 { ${this.dyn}::Undefined } else { runtime::array_shift(array) },`);
    this.context.line(`"unshift" => ${this.dyn}::Number(runtime::array_unshift(array, args.to_vec())),`);
    this.context.line(`"slice" => ${this.dyn}::Array(runtime::array_slice(array, sc_dyn_index_arg(args, 0, 0.0, callee_name), sc_dyn_index_arg(args, 1, length, callee_name))),`);
    this.context.line(`"at" => { let index = sc_dyn_index_arg(args, 0, 0.0, callee_name); let actual = if index < 0.0 { length + index } else { index }; if actual < 0.0 || actual >= length { ${this.dyn}::Undefined } else { runtime::array_get(array, actual) } },`);
    this.context.line(`"indexOf" => { let needle = args.first().cloned().unwrap_or(${this.dyn}::Undefined); ${this.dyn}::Number(runtime::array_index_of_by(array, &needle, sc_dyn_strict_equal)) },`);
    this.context.line(`"lastIndexOf" => { let needle = args.first().cloned().unwrap_or(${this.dyn}::Undefined); let mut index = length; let mut found = -1.0; while index > 0.0 { index -= 1.0; if sc_dyn_strict_equal(&runtime::array_get(array, index), &needle) { found = index; break; } } ${this.dyn}::Number(found) },`);
    this.context.line(`"includes" => { let needle = args.first().cloned().unwrap_or(${this.dyn}::Undefined); ${this.dyn}::Boolean(runtime::array_includes_by(array, &needle, sc_dyn_same_value_zero)) },`);
    this.context.line(`"join" => { let separator = match args.first() { None | Some(${this.dyn}::Undefined) => runtime::string(","), Some(value) => sc_dyn_to_string(value), }; ${this.dyn}::String(runtime::array_join_by(array, &separator, |element, output| { if !matches!(element, ${this.dyn}::Undefined | ${this.dyn}::Null) { output.push_str(sc_dyn_to_string(element).as_ref()); } })) },`);
    this.context.line(`"concat" => { let output = runtime::array_slice(array, 0.0, length); for arg in args { match arg { ${this.dyn}::Array(items) => { runtime::array_extend(&output, items); }, value => { runtime::array_push(&output, value.clone()); }, } } ${this.dyn}::Array(output) },`);
    this.context.line(`"reverse" => ${this.dyn}::Array(runtime::array_reverse(array)),`);
    this.context.line('"sort" => sc_dyn_array_sort(array, args),');
    this.context.line("\"forEach\" | \"map\" | \"filter\" | \"some\" | \"every\" | \"find\" | \"findIndex\" => sc_dyn_array_iterate(array, method, args),");
    this.context.line("\"splice\" | \"reduce\" | \"reduceRight\" | \"flat\" | \"fill\" | \"copyWithin\" | \"keys\" | \"values\" | \"entries\" | \"toReversed\" | \"toSorted\" | \"toSpliced\" | \"with\" | \"toString\" | \"toLocaleString\" => runtime::throw_error(format!(\"'Array.prototype.{method}' on a dynamic value is not supported yet\")),");
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
    this.close("}");
    this.close("},");
  }

  private emitBytesArm(): void {
    this.open(`${this.dyn}::Bytes(bytes) => {`);
    this.context.line("let length = runtime::bytes_len(bytes);");
    this.open("match method {");
    this.context.line(`"at" => { let index = sc_dyn_index_arg(args, 0, 0.0, callee_name); let actual = if index < 0.0 { length + index } else { index }; if actual < 0.0 || actual >= length { ${this.dyn}::Undefined } else { ${this.dyn}::Number(runtime::bytes_get(bytes, actual)) } },`);
    this.context.line(`"slice" | "subarray" => ${this.dyn}::Bytes(runtime::bytes_slice(bytes, sc_dyn_index_arg(args, 0, 0.0, callee_name), sc_dyn_index_arg(args, 1, length, callee_name), false)),`);
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
    this.close("}");
    this.close("},");
  }

  private emitBufferArm(): void {
    this.open(`${this.dyn}::Buffer(bytes) => {`);
    this.context.line("let length = runtime::bytes_len(bytes);");
    this.open("match method {");
    this.context.line(`"at" => { let index = sc_dyn_index_arg(args, 0, 0.0, callee_name); let actual = if index < 0.0 { length + index } else { index }; if actual < 0.0 || actual >= length { ${this.dyn}::Undefined } else { ${this.dyn}::Number(runtime::bytes_get(bytes, actual)) } },`);
    this.context.line(`"slice" | "subarray" => ${this.dyn}::Buffer(runtime::bytes_slice(bytes, sc_dyn_index_arg(args, 0, 0.0, callee_name), sc_dyn_index_arg(args, 1, length, callee_name), false)),`);
    this.context.line(`"toString" => { let encoding = match args.first() { None | Some(${this.dyn}::Undefined) => runtime::string("utf8"), Some(${this.dyn}::String(value)) => value.clone(), value => sc_dyn_arg_type_fail("encoding", "of type string", value.unwrap_or(&${this.dyn}::Undefined)), }; ${this.dyn}::String(runtime::bytes_to_string(bytes, &encoding)) },`);
    this.context.line(`_ => runtime::throw_type_error(format!("{callee_name} is not a function")),`);
    this.close("}");
    this.close("},");
  }

  private emitNetSocketArm(): void {
    this.open(`${this.dyn}::NetSocket(socket) => {`);
    this.open("match method {");
    this.context.line(`"write" => { match args.first() { Some(${this.dyn}::String(value)) => runtime::net_socket_write_str(socket, value), Some(${this.dyn}::Bytes(value) | ${this.dyn}::Buffer(value)) => runtime::net_socket_write_bytes(socket, value), value => sc_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", value.unwrap_or(&${this.dyn}::Undefined)), }; let callback = match (args.get(1), args.get(2)) { (_, Some(value)) => Some(value.clone()), (Some(${this.dyn}::String(_)) | None | Some(${this.dyn}::Undefined), None) => None, (Some(value), None) => Some(value.clone()), }; if let Some(callback) = callback { let traced = callback.clone(); runtime::net_socket_after_write(socket, std::rc::Rc::new(move || { let _ = sc_dyn_call(&callback, &[], "callback"); }), std::rc::Rc::new(move |tracer| runtime::Trace::trace(&traced, tracer))); } ${this.dyn}::Boolean(true) },`);
    this.context.line(`"end" => { match args.first() { None | Some(${this.dyn}::Undefined) => runtime::net_socket_end(socket), Some(${this.dyn}::String(value)) => runtime::net_socket_end_str(socket, value), Some(${this.dyn}::Bytes(value) | ${this.dyn}::Buffer(value)) => runtime::net_socket_end_bytes(socket, value), value => sc_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", value.unwrap_or(&${this.dyn}::Undefined)), }; let callback = match (args.get(1), args.get(2)) { (_, Some(value)) => Some(value.clone()), (Some(${this.dyn}::String(_)) | None | Some(${this.dyn}::Undefined), None) => None, (Some(value), None) => Some(value.clone()), }; if let Some(callback) = callback { let traced = callback.clone(); runtime::net_socket_on_finish(socket, std::rc::Rc::new(move || { let _ = sc_dyn_call(&callback, &[], "callback"); }), std::rc::Rc::new(move |tracer| runtime::Trace::trace(&traced, tracer))); } recv.clone() },`);
    this.context.line(`"destroy" => { runtime::net_socket_destroy(socket); recv.clone() },`);
    this.context.line(`"destroySoon" => { runtime::net_socket_destroy_soon(socket); recv.clone() },`);
    this.context.line(`"pause" => { let _ = runtime::net_socket_pause(socket); recv.clone() },`);
    this.context.line(`"resume" => { let _ = runtime::net_socket_resume(socket); recv.clone() },`);
    this.context.line(`"setNoDelay" => { let enabled = match args.first() { None | Some(${this.dyn}::Undefined) => true, Some(${this.dyn}::Boolean(value)) => *value, _ => true }; let _ = runtime::net_socket_set_no_delay(socket, enabled); recv.clone() },`);
    this.context.line(`"on" | "once" | "addListener" => {`);
    this.context.pushIndent();
    this.context.line(`let event = match args.first() { Some(${this.dyn}::String(value)) => value.as_ref(), _ => runtime::throw_type_error(format!("{callee_name} is not a function")), };`);
    this.context.line(`let callback = args.get(1).cloned().unwrap_or(${this.dyn}::Undefined);`);
    this.context.line("let traced = callback.clone();");
    this.context.line("let once = method == \"once\";");
    this.open("match event {");
    this.context.line(`"data" => runtime::net_socket_on_data(socket, std::rc::Rc::new(move |chunk, encoding_utf8| { let value = if encoding_utf8 { ${this.dyn}::String(runtime::bytes_to_string(&chunk, &runtime::string("utf8"))) } else { ${this.dyn}::Buffer(chunk) }; let _ = sc_dyn_call(&callback, &[value], "listener"); }), std::rc::Rc::new(move |tracer| runtime::Trace::trace(&traced, tracer)), once),`);
    for (const [event, runtime] of [["end", "net_socket_on_end"], ["close", "net_socket_on_close"], ["connect", "net_socket_on_connect"]] as const) {
      this.context.line(`"${event}" => runtime::${runtime}(socket, std::rc::Rc::new(move || { let _ = sc_dyn_call(&callback, &[], "listener"); }), std::rc::Rc::new(move |tracer| runtime::Trace::trace(&traced, tracer)), once),`);
    }
    this.context.line('_ => runtime::throw_error(format!("dynamic socket event \'{event}\' is not supported yet")),');
    this.close("}");
    this.context.line("recv.clone()");
    this.context.popIndent();
    this.context.line("},");
    this.context.line(`_ => runtime::throw_type_error(format!("{callee_name} is not a function")),`);
    this.close("}");
    this.close("},");
  }

  private functionVariants(): string[] {
    if (this.functionPatterns === "") return [];
    return this.functionPatterns
      .split(" | ")
      .map((pattern) => pattern.slice(`${this.dyn}::`.length, -4));
  }

  private open(line: string): void {
    this.context.line(line);
    this.context.pushIndent();
  }

  private close(line: string): void {
    this.context.popIndent();
    this.context.line(line);
  }
}
