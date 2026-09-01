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
    this.functionPatterns = [
      `${this.dyn}::NativeMethod(..)`,
      ...boxedShapes.map((shape) => `${this.dyn}::${context.dynFunctionVariant(shape)}(..)`),
    ].join(" | ");
  }

  emit(): void {
    this.emitIndexHelpers();
    this.emitValueHelpers();
    this.emitThisHelpers();
    this.emitNativeMethodHelper();
    this.emitFunctionCacheHelpers();
    this.emitDefinePropertiesHelper();
    this.emitArrayCallbacks();
    this.emitArraySortHelpers();
    this.emitPromiseHelpers();
    this.emitDispatcher();
  }

  private emitIndexHelpers(): void {
    this.open(`fn sc_dyn_index_arg(args: &[${this.dyn}], index: usize, default: f64, callee_name: &str) -> f64 {`);
    this.context.line("let _ = callee_name;");
    this.context.line(`let Some(value) = args.get(index) else { return default; };`);
    this.context.line(`if matches!(value, ${this.dyn}::Undefined) { return default; }`);
    this.context.line("let number = sc_dyn_to_number(value);");
    this.context.line("if number.is_nan() { 0.0 } else { number.trunc() }");
    this.close("}");
    this.open(`fn sc_dyn_last_index_arg(args: &[${this.dyn}], callee_name: &str) -> f64 {`);
    this.context.line("let _ = callee_name;");
    this.context.line(`let Some(value) = args.get(1) else { return f64::INFINITY; };`);
    this.context.line(`if matches!(value, ${this.dyn}::Undefined) { return f64::INFINITY; }`);
    this.context.line("let number = sc_dyn_to_number(value);");
    this.context.line("if number.is_nan() { f64::INFINITY } else { number.trunc() }");
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

    this.context.line(`fn sc_dyn_same_value_zero(left: &${this.dyn}, right: &${this.dyn}) -> bool {`);
    this.context.pushIndent();
    this.context.line(`matches!((left, right), (${this.dyn}::Number(a), ${this.dyn}::Number(b)) if a.is_nan() && b.is_nan()) || sc_dyn_strict_equal(left, right)`);
    this.context.popIndent();
    this.context.line("}");
    this.open(`fn sc_dyn_string_array(values: runtime::JsArray<runtime::JsString>) -> ${this.dyn} {`);
    this.context.line(`let output: runtime::JsArray<${this.dyn}> = runtime::array_new(Vec::new());`);
    this.context.line("let mut index = 0.0;");
    this.context.line(`while index < runtime::array_len(&values) { runtime::array_push(&output, ${this.dyn}::String(runtime::array_get(&values, index))); index += 1.0; }`);
    this.context.line(`${this.dyn}::Array(output)`);
    this.close("}");
  }

  private emitArrayCallbacks(): void {
    this.open(`fn sc_dyn_array_flat_into(array: &runtime::JsArray<${this.dyn}>, depth: f64, output: &runtime::JsArray<${this.dyn}>) {`);
    this.open("for item in runtime::array_values(array) {");
    this.context.line(`match item { ${this.dyn}::Array(items) if depth > 0.0 => sc_dyn_array_flat_into(&items, depth - 1.0, output), value => { runtime::array_push(output, value); }, }`);
    this.close("}");
    this.close("}");

    this.open(`fn sc_dyn_array_flat(array: &runtime::JsArray<${this.dyn}>, depth: f64) -> ${this.dyn} {`);
    this.context.line(`let output: runtime::JsArray<${this.dyn}> = runtime::array_new(Vec::new());`);
    this.context.line("sc_dyn_array_flat_into(array, depth.max(0.0), &output);");
    this.context.line(`${this.dyn}::Array(output)`);
    this.close("}");

    this.open(`fn sc_dyn_array_callback(callback: &${this.dyn}, item: ${this.dyn}, index: f64, array: &runtime::JsArray<${this.dyn}>) -> ${this.dyn} {`);
    this.context.line(`let args = [item, ${this.dyn}::Number(index), ${this.dyn}::Array(array.clone())];`);
    this.context.line("let callback_name = sc_dyn_to_string(callback);");
    this.context.line("sc_dyn_call(callback, &args, callback_name.as_ref())");
    this.close("}");

    this.open(`fn sc_dyn_array_reduce(array: &runtime::JsArray<${this.dyn}>, args: &[${this.dyn}], reverse: bool) -> ${this.dyn} {`);
    this.context.line(`let callback = args.first().cloned().unwrap_or(${this.dyn}::Undefined);`);
    this.context.line("let length = runtime::array_len(array);");
    this.open("let (mut accumulator, mut index) = match args.get(1) {");
    this.context.line("Some(initial) => (initial.clone(), if reverse { length } else { 0.0 }),");
    this.context.line("None if length > 0.0 && reverse => (runtime::array_get(array, length - 1.0), length - 1.0),");
    this.context.line("None if length > 0.0 => (runtime::array_get(array, 0.0), 1.0),");
    this.context.line('None => runtime::throw_type_error("Reduce of empty array with no initial value".to_owned()),');
    this.close("};");
    this.context.line("let callback_name = sc_dyn_to_string(&callback);");
    this.open("loop {");
    this.open("if reverse {");
    this.context.line("if index <= 0.0 { break; }");
    this.context.line("index -= 1.0;");
    this.close("} else if index >= length || index >= runtime::array_len(array) { break; }");
    this.open("if index < runtime::array_len(array) {");
    this.context.line(`let callback_args = [accumulator, runtime::array_get(array, index), ${this.dyn}::Number(index), ${this.dyn}::Array(array.clone())];`);
    this.context.line("accumulator = sc_dyn_call(&callback, &callback_args, callback_name.as_ref());");
    this.close("}");
    this.context.line("if !reverse { index += 1.0; }");
    this.close("}");
    this.context.line("accumulator");
    this.close("}");

    this.open(`fn sc_dyn_array_find_last(array: &runtime::JsArray<${this.dyn}>, args: &[${this.dyn}], index_result: bool) -> ${this.dyn} {`);
    this.context.line(`let callback = args.first().cloned().unwrap_or(${this.dyn}::Undefined);`);
    this.context.line("let mut index = runtime::array_len(array);");
    this.open("while index > 0.0 {");
    this.context.line("index -= 1.0;");
    this.context.line(`let item = if index < runtime::array_len(array) { runtime::array_get(array, index) } else { ${this.dyn}::Undefined };`);
    this.context.line("let result = sc_dyn_array_callback(&callback, item.clone(), index, array);");
    this.context.line(`if sc_dyn_truthy(&result) { return if index_result { ${this.dyn}::Number(index) } else { item }; }`);
    this.close("}");
    this.context.line(`if index_result { ${this.dyn}::Number(-1.0) } else { ${this.dyn}::Undefined }`);
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
    this.context.line(`"flatMap" => { match result { ${this.dyn}::Array(items) => { runtime::array_extend(&output, &items); }, value => { runtime::array_push(&output, value); }, } },`);
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
    this.context.line(`"map" | "flatMap" | "filter" => ${this.dyn}::Array(output),`);
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

    const callable = `${this.dyn}::Undefined | ${this.functionPatterns}`;
    this.open(`fn sc_dyn_array_sort(array: &runtime::JsArray<${this.dyn}>, args: &[${this.dyn}], copy_first: bool) -> ${this.dyn} {`);
    this.context.line(`let comparator = args.first().cloned().unwrap_or(${this.dyn}::Undefined);`);
    this.context.line(`if !matches!(&comparator, ${callable}) { runtime::throw_type_error(format!("The comparison function must be either a function or undefined: {}", sc_dyn_to_string(&comparator))); }`);
    this.context.line(`let comparator = if matches!(&comparator, ${this.dyn}::Undefined) { None } else { Some(&comparator) };`);
    this.context.line("let target = if copy_first { runtime::array_slice(array, 0.0, f64::INFINITY) } else { array.clone() };");
    this.context.line(`${this.dyn}::Array(runtime::array_sort_by_snapshot(&target, |left, right| sc_dyn_sort_compare(left, right, comparator)))`);
    this.close("}");
  }

  private emitPromiseHelpers(): void {
    this.open(`fn sc_dyn_promise_settle(target: &runtime::JsPromise<${this.dyn}>, outcome: Result<${this.dyn}, runtime::Caught>) {`);
    this.open("match outcome {");
    this.context.line("Ok(value) => { let _ = runtime::promise_fulfill(target, value); },");
    this.context.line("Err(reason) => { let _ = runtime::promise_reject(target, reason); },");
    this.close("}");
    this.close("}");

    this.open(`fn sc_dyn_promise_adopt(target: &runtime::JsPromise<${this.dyn}>, value: ${this.dyn}) {`);
    this.open("match value {");
    this.context.line(`${this.dyn}::Promise(handle) => {`);
    this.context.pushIndent();
    this.context.line("if runtime::promise_handle_identity(&handle) == target.identity() { let reason = runtime::caught_value(runtime::error_new(\"TypeError\", runtime::string(\"Chaining cycle detected for promise #<Promise>\"))); let _ = runtime::promise_reject(target, reason); return; }");
    this.context.line(`let inner = runtime::promise_from_handle::<${this.dyn}>(&handle);`);
    this.context.line("let forwarded = target.clone();");
    this.context.line("runtime::promise_then(&inner, Box::new(move |outcome| sc_dyn_promise_settle(&forwarded, outcome)));");
    this.context.popIndent();
    this.context.line("},");
    this.context.line("value => { let _ = runtime::promise_fulfill(target, value); },");
    this.close("}");
    this.close("}");

    this.open(`fn sc_dyn_promise_react(target: runtime::JsPromise<${this.dyn}>, callback: ${this.dyn}, argument: ${this.dyn}) {`);
    this.context.line("let guard = target.clone();");
    this.open("runtime::promise_run_segment(&guard, move || {");
    this.context.line("let value = sc_dyn_call(&callback, &[argument], \"handler\");");
    this.context.line("sc_dyn_promise_adopt(&target, value);");
    this.close("});");
    this.close("}");

    this.open(`fn sc_dyn_promise_chain(handle: &runtime::JsPromiseHandle, on_fulfilled: ${this.dyn}, on_rejected: ${this.dyn}) -> ${this.dyn} {`);
    this.context.line(`let source = runtime::promise_from_handle::<${this.dyn}>(handle);`);
    this.context.line(`let result = runtime::promise_new::<${this.dyn}>();`);
    this.context.line("let target = result.clone();");
    this.open("runtime::promise_then(&source, Box::new(move |outcome| match outcome {");
    this.context.line("Ok(value) => { if sc_dyn_function_identity(&on_fulfilled).is_some() { sc_dyn_promise_react(target, on_fulfilled, value); } else { let _ = runtime::promise_fulfill(&target, value); } },");
    this.context.line("Err(reason) => { if sc_dyn_function_identity(&on_rejected).is_some() { sc_dyn_promise_react(target, on_rejected, sc_dyn_from_caught(reason)); } else { let _ = runtime::promise_reject(&target, reason); } },");
    this.close("}));");
    this.context.line(`${this.dyn}::Promise(runtime::promise_to_handle(&result))`);
    this.close("}");

    this.open(`fn sc_dyn_promise_finish_after(target: &runtime::JsPromise<${this.dyn}>, outcome: Result<${this.dyn}, runtime::Caught>, cleanup: ${this.dyn}) {`);
    this.open("match cleanup {");
    this.context.line(`${this.dyn}::Promise(handle) => {`);
    this.context.pushIndent();
    this.context.line("if runtime::promise_handle_identity(&handle) == target.identity() { let reason = runtime::caught_value(runtime::error_new(\"TypeError\", runtime::string(\"Chaining cycle detected for promise #<Promise>\"))); let _ = runtime::promise_reject(target, reason); return; }");
    this.context.line(`let inner = runtime::promise_from_handle::<${this.dyn}>(&handle);`);
    this.context.line("let forwarded = target.clone();");
    this.open("runtime::promise_then(&inner, Box::new(move |cleanup_outcome| match cleanup_outcome {");
    this.context.line("Ok(_) => sc_dyn_promise_settle(&forwarded, outcome),");
    this.context.line("Err(reason) => { let _ = runtime::promise_reject(&forwarded, reason); },");
    this.close("}));");
    this.context.popIndent();
    this.context.line("},");
    this.context.line("_ => sc_dyn_promise_settle(target, outcome),");
    this.close("}");
    this.close("}");

    this.open(`fn sc_dyn_promise_finally(handle: &runtime::JsPromiseHandle, callback: ${this.dyn}) -> ${this.dyn} {`);
    this.context.line(`let source = runtime::promise_from_handle::<${this.dyn}>(handle);`);
    this.context.line(`let result = runtime::promise_new::<${this.dyn}>();`);
    this.context.line("let target = result.clone();");
    this.open("runtime::promise_then(&source, Box::new(move |outcome| {");
    this.open("if sc_dyn_function_identity(&callback).is_none() {");
    this.context.line("sc_dyn_promise_settle(&target, outcome);");
    this.context.line("return;");
    this.close("}");
    this.context.line("let guard = target.clone();");
    this.open("runtime::promise_run_segment(&guard, move || {");
    this.context.line("let cleanup = sc_dyn_call(&callback, &[], \"onFinally\");");
    this.context.line("sc_dyn_promise_finish_after(&target, outcome, cleanup);");
    this.close("});");
    this.close("}));");
    this.context.line(`${this.dyn}::Promise(runtime::promise_to_handle(&result))`);
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
    const callableTarget = `${this.dyn}::Object(..) | ${this.functionPatterns}`;
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

  private emitNativeMethodHelper(): void {
    this.open(`fn sc_dyn_invoke_number(number: f64, method: &str, args: &[${this.dyn}], callee_name: &str) -> ${this.dyn} {`);
    this.open("match method {");
    this.context.line(`"toString" => { let radix = match args.first() { None | Some(${this.dyn}::Undefined) => 10.0, Some(value) => sc_dyn_to_number(value), }; ${this.dyn}::String(runtime::number_to_radix_string(number, radix)) },`);
    this.context.line(`"toLocaleString" => match args { [${this.dyn}::String(locale)] if locale.as_ref() == "en-US" => ${this.dyn}::String(runtime::intl_number_format_en_us(number)), _ => runtime::throw_error("dynamic Number.prototype.toLocaleString supports the explicit en-US locale with default options".to_owned()), },`);
    this.context.line(`"toFixed" => ${this.dyn}::String(runtime::number_to_fixed(number, sc_dyn_index_arg(args, 0, 0.0, callee_name))),`);
    this.context.line(`"valueOf" => ${this.dyn}::Number(number),`);
    this.context.line(`_ => runtime::throw_type_error(format!("{callee_name} is not a function")),`);
    this.close("}");
    this.close("}");
    this.open(`fn sc_dyn_call_native_method(method: ScDynNativeMethod, args: &[${this.dyn}]) -> ${this.dyn} {`);
    this.context.line("let receiver = sc_dyn_this_get();");
    this.open("match (method, receiver) {");
    this.context.line(`(method, ${this.dyn}::Number(number)) => sc_dyn_invoke_number(number, method.name(), args, method.name()),`);
    this.context.line(`(method, _) => runtime::throw_type_error(format!("Number.prototype.{} requires that 'this' be a Number", method.name())),`);
    this.close("}");
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
    this.emitNumberArm();
    this.emitBooleanArm();
    this.emitStringArm();
    this.emitRegexArm();
    this.emitArrayArm();
    this.emitArrayIteratorArm();
    this.emitBytesArm();
    this.emitTypedBytesArm();
    this.emitBufferArm();
    this.emitPromiseArm();
    this.emitNetSocketArm();
    this.emitHttpRequestArm();
    this.emitHttpResponseArm();
    this.emitHttpAgentArm();
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
    this.close("}");
    this.close("}");
  }

  private emitObjectArm(): void {
    this.open(`${this.dyn}::Object(object) => {`);
    this.context.line("let _ = object;");
    this.context.line("let member = sc_dyn_key_get(recv, &runtime::string(method), false);");
    this.context.line("let _this_guard = sc_dyn_this_push(recv.clone());");
    this.context.line("sc_dyn_call(&member, args, callee_name)");
    this.close("},");
  }

  private emitPromiseArm(): void {
    this.open(`${this.dyn}::Promise(promise) => {`);
    this.open("match method {");
    this.context.line(`"then" => sc_dyn_promise_chain(promise, args.first().cloned().unwrap_or(${this.dyn}::Undefined), args.get(1).cloned().unwrap_or(${this.dyn}::Undefined)),`);
    this.context.line(`"catch" => sc_dyn_promise_chain(promise, ${this.dyn}::Undefined, args.first().cloned().unwrap_or(${this.dyn}::Undefined)),`);
    this.context.line(`"finally" => sc_dyn_promise_finally(promise, args.first().cloned().unwrap_or(${this.dyn}::Undefined)),`);
    this.context.line(`_ => runtime::throw_type_error(format!("recv.{method} is not a function")),`);
    this.close("}");
    this.close("},");
  }

  private emitFunctionArm(): void {
    const pattern = this.boxedShapes.length === 0 ? this.functionPatterns : `(${this.functionPatterns})`;
    this.open(`value @ ${pattern} => {`);
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
    this.context.line(`"toLowerCase" => ${this.dyn}::String(runtime::string_to_lower_case(text)),`);
    this.context.line(`"toUpperCase" => ${this.dyn}::String(runtime::string_to_upper_case(text)),`);
    this.context.line(`"slice" => ${this.dyn}::String(runtime::string_slice(text, sc_dyn_index_arg(args, 0, 0.0, callee_name), sc_dyn_index_arg(args, 1, runtime::string_len(text), callee_name))),`);
    this.context.line(`"at" => { let index = sc_dyn_index_arg(args, 0, 0.0, callee_name); let actual = if index < 0.0 { runtime::string_len(text) + index } else { index }; if actual < 0.0 || actual >= runtime::string_len(text) { ${this.dyn}::Undefined } else { ${this.dyn}::String(runtime::string_at(text, index)) } },`);
    this.context.line(`"charAt" => ${this.dyn}::String(runtime::string_char_at(text, sc_dyn_index_arg(args, 0, 0.0, callee_name))),`);
    this.context.line(`"split" => { let limit = match args.get(1) { None | Some(${this.dyn}::Undefined) => u32::MAX as f64, Some(value) => runtime::to_uint32(sc_dyn_to_number(value)) as f64, }; let pieces = match args.first() { None | Some(${this.dyn}::Undefined) => if limit == 0.0 { runtime::array_new(Vec::new()) } else { runtime::array_new(vec![text.clone()]) }, Some(${this.dyn}::Regex(separator)) => runtime::regex_split(text, separator, limit), Some(separator) => runtime::string_split(text, &sc_dyn_to_string(separator), limit), }; sc_dyn_string_array(pieces) },`);
    this.context.line(`"concat" => { let mut output = text.to_string(); for arg in args { output.push_str(sc_dyn_to_string(arg).as_ref()); } ${this.dyn}::String(runtime::string(&output)) },`);
    this.context.line(`"toLocaleString" => ${this.dyn}::String(text.clone()),`);
    this.context.line(`"indexOf" => match args.first() { Some(search) => ${this.dyn}::Number(runtime::string_index_of(text, &sc_dyn_to_string(search), sc_dyn_index_arg(args, 1, 0.0, callee_name))), None => runtime::throw_error("'String.prototype.indexOf' without a search value is not supported yet".to_owned()), },`);
    this.context.line(`"lastIndexOf" => match args.first() { Some(${this.dyn}::String(search)) => ${this.dyn}::Number(runtime::string_last_index_of(text, search, sc_dyn_last_index_arg(args, callee_name))), _ => runtime::throw_error("'String.prototype.lastIndexOf' on a dynamic value is not supported yet".to_owned()), },`);
    this.context.line(`"includes" => match args.first() { Some(search) => ${this.dyn}::Boolean(runtime::string_includes(text, &sc_dyn_to_string(search), sc_dyn_index_arg(args, 1, 0.0, callee_name))), None => ${this.dyn}::Boolean(runtime::string_includes(text, &runtime::string("undefined"), 0.0)), },`);
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
    this.close("}");
    this.close("},");
  }

  private emitNumberArm(): void {
    this.open(`${this.dyn}::Number(number) => {`);
    this.context.line("sc_dyn_invoke_number(*number, method, args, callee_name)");
    this.close("},");
  }

  private emitBooleanArm(): void {
    this.open(`${this.dyn}::Boolean(value) => {`);
    this.open("match method {");
    this.context.line(`"toLocaleString" => ${this.dyn}::String(runtime::bool_to_string(*value)),`);
    this.context.line(`_ => runtime::throw_type_error(format!("{callee_name} is not a function")),`);
    this.close("}");
    this.close("},");
  }

  private emitRegexArm(): void {
    this.open(`${this.dyn}::Regex(regex) => {`);
    this.open("match method {");
    this.context.line(`"test" => { let value = args.first().cloned().unwrap_or(${this.dyn}::Undefined); ${this.dyn}::Boolean(runtime::regex_test(regex, &sc_dyn_to_string(&value))) },`);
    this.context.line(`"toString" => ${this.dyn}::String(runtime::string(&format!("/{}/{}", runtime::regex_source(regex), runtime::regex_flags(regex)))),`);
    this.context.line(`_ => runtime::throw_type_error(format!("{callee_name} is not a function")),`);
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
    this.context.line(`"splice" => { let start = sc_dyn_index_arg(args, 0, 0.0, callee_name); let delete_count = if args.is_empty() { 0.0 } else if args.len() < 2 { f64::INFINITY } else { sc_dyn_index_arg(args, 1, 0.0, callee_name) }; ${this.dyn}::Array(runtime::array_splice_with_items(array, start, delete_count, args.get(2..).unwrap_or(&[]).to_vec())) },`);
    this.context.line(`"at" => { let index = sc_dyn_index_arg(args, 0, 0.0, callee_name); let actual = if index < 0.0 { length + index } else { index }; if actual < 0.0 || actual >= length { ${this.dyn}::Undefined } else { runtime::array_get(array, actual) } },`);
    this.context.line(`"indexOf" => { let needle = args.first().cloned().unwrap_or(${this.dyn}::Undefined); let from_index = sc_dyn_index_arg(args, 1, 0.0, callee_name); ${this.dyn}::Number(runtime::array_index_of_from_by(array, &needle, from_index, sc_dyn_strict_equal)) },`);
    this.context.line(`"lastIndexOf" => { let needle = args.first().cloned().unwrap_or(${this.dyn}::Undefined); let mut index = length; let mut found = -1.0; while index > 0.0 { index -= 1.0; if sc_dyn_strict_equal(&runtime::array_get(array, index), &needle) { found = index; break; } } ${this.dyn}::Number(found) },`);
    this.context.line(`"includes" => { let needle = args.first().cloned().unwrap_or(${this.dyn}::Undefined); ${this.dyn}::Boolean(runtime::array_includes_by(array, &needle, sc_dyn_same_value_zero)) },`);
    this.context.line(`"join" => { let separator = match args.first() { None | Some(${this.dyn}::Undefined) => runtime::string(","), Some(value) => sc_dyn_to_string(value), }; ${this.dyn}::String(runtime::array_join_by(array, &separator, |element, output| { if !matches!(element, ${this.dyn}::Undefined | ${this.dyn}::Null) { output.push_str(sc_dyn_to_string(element).as_ref()); } })) },`);
    this.context.line(`"concat" => { let output = runtime::array_slice(array, 0.0, length); for arg in args { match arg { ${this.dyn}::Array(items) => { runtime::array_extend(&output, items); }, value => { runtime::array_push(&output, value.clone()); }, } } ${this.dyn}::Array(output) },`);
    this.context.line('"flat" => sc_dyn_array_flat(array, sc_dyn_index_arg(args, 0, 1.0, callee_name)),');
    this.context.line(`"reverse" => ${this.dyn}::Array(runtime::array_reverse(array)),`);
    this.context.line(`"toReversed" => ${this.dyn}::Array(runtime::array_to_reversed(array)),`);
    this.context.line(`"toSpliced" => { let start = sc_dyn_index_arg(args, 0, 0.0, callee_name); let delete_count = if args.is_empty() { 0.0 } else if args.len() < 2 { f64::INFINITY } else { sc_dyn_index_arg(args, 1, 0.0, callee_name) }; let items = runtime::array_new(args.get(2..).unwrap_or(&[]).to_vec()); ${this.dyn}::Array(runtime::array_to_spliced(array, start, delete_count, &items)) },`);
    this.context.line(`"with" => { let index = sc_dyn_index_arg(args, 0, 0.0, callee_name); let value = args.get(1).cloned().unwrap_or(${this.dyn}::Undefined); ${this.dyn}::Array(runtime::array_with(array, index, value)) },`);
    this.context.line(`"fill" => { let value = args.first().cloned().unwrap_or(${this.dyn}::Undefined); let start = sc_dyn_index_arg(args, 1, 0.0, callee_name); let end = sc_dyn_index_arg(args, 2, length, callee_name); ${this.dyn}::Array(runtime::array_fill(array, value, start, end)) },`);
    this.context.line(`"copyWithin" => { let target = sc_dyn_index_arg(args, 0, 0.0, callee_name); let start = sc_dyn_index_arg(args, 1, 0.0, callee_name); let end = sc_dyn_index_arg(args, 2, length, callee_name); ${this.dyn}::Array(runtime::array_copy_within(array, target, start, end)) },`);
    this.context.line('"reduce" => sc_dyn_array_reduce(array, args, false),');
    this.context.line('"reduceRight" => sc_dyn_array_reduce(array, args, true),');
    this.context.line('"findLast" => sc_dyn_array_find_last(array, args, false),');
    this.context.line('"findLastIndex" => sc_dyn_array_find_last(array, args, true),');
    this.context.line('"sort" => sc_dyn_array_sort(array, args, false),');
    this.context.line('"toSorted" => sc_dyn_array_sort(array, args, true),');
    this.context.line(`"entries" => ${this.dyn}::ArrayIterator(runtime::array_iterator_new(array, runtime::ArrayIteratorKind::Entries)),`);
    this.context.line(`"keys" => ${this.dyn}::ArrayIterator(runtime::array_iterator_new(array, runtime::ArrayIteratorKind::Keys)),`);
    this.context.line(`"values" => ${this.dyn}::ArrayIterator(runtime::array_iterator_new(array, runtime::ArrayIteratorKind::Values)),`);
    this.context.line("\"forEach\" | \"map\" | \"flatMap\" | \"filter\" | \"some\" | \"every\" | \"find\" | \"findIndex\" => sc_dyn_array_iterate(array, method, args),");
    this.context.line(`"toString" => ${this.dyn}::String(sc_dyn_to_string(&${this.dyn}::Array(array.clone()))),`);
    this.context.line(`"toLocaleString" => ${this.dyn}::String(runtime::array_join_by(array, &runtime::string(","), |element, output| { if !matches!(element, ${this.dyn}::Undefined | ${this.dyn}::Null) { let localized = sc_dyn_invoke(element, "toLocaleString", args, "Array element.toLocaleString"); output.push_str(sc_dyn_to_string(&localized).as_ref()); } })),`);
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
    this.close("}");
    this.close("},");
  }

  private emitArrayIteratorArm(): void {
    this.open(`${this.dyn}::ArrayIterator(iterator) => {`);
    this.open("match method {");
    this.context.line(`"next" => { let (value, done) = match runtime::array_iterator_next(iterator) { Some(runtime::ArrayIteratorItem::Entry(index, value)) => (${this.dyn}::Array(runtime::array_new(vec![${this.dyn}::Number(index), value])), false), Some(runtime::ArrayIteratorItem::Key(index)) => (${this.dyn}::Number(index), false), Some(runtime::ArrayIteratorItem::Value(value)) => (value, false), None => (${this.dyn}::Undefined, true), }; let result = runtime::map_new(); runtime::map_set_by(&result, runtime::string("value"), value, |left, right| left.as_ref() == right.as_ref()); runtime::map_set_by(&result, runtime::string("done"), ${this.dyn}::Boolean(done), |left, right| left.as_ref() == right.as_ref()); ${this.dyn}::Object(result) },`);
    this.context.line(`_ => runtime::throw_type_error(format!("{callee_name} is not a function")),`);
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

  private emitTypedBytesArm(): void {
    this.open(`${this.dyn}::TypedBytes(bytes) => {`);
    this.context.line("let length = runtime::typed_bytes_len(bytes);");
    this.open("match method {");
    this.context.line(`"at" => { let index = sc_dyn_index_arg(args, 0, 0.0, callee_name); let actual = if index < 0.0 { length + index } else { index }; if actual < 0.0 || actual >= length { ${this.dyn}::Undefined } else { ${this.dyn}::Number(runtime::typed_bytes_get(bytes, actual)) } },`);
    this.context.line(`"slice" | "subarray" => ${this.dyn}::TypedBytes(runtime::typed_bytes_slice(bytes, sc_dyn_index_arg(args, 0, 0.0, callee_name), sc_dyn_index_arg(args, 1, length, callee_name))),`);
    this.context.line("_ => runtime::throw_type_error(format!(\"{callee_name} is not a function\")),");
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

  private emitHttpRequestArm(): void {
    this.context.line(`${this.dyn}::HttpRequest(request) => sc_dyn_http_request_invoke(request, recv, method, args, callee_name),`);
  }

  private emitHttpResponseArm(): void {
    this.context.line(`${this.dyn}::HttpResponse(response) => sc_dyn_http_response_invoke(response, recv, method, args, callee_name),`);
  }

  private emitHttpAgentArm(): void {
    this.context.line(`${this.dyn}::HttpAgent(agent) => sc_dyn_http_agent_invoke(agent, method, args, callee_name),`);
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
