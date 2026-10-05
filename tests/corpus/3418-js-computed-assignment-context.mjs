var FieldPosition;
(function (FieldPosition) {
  FieldPosition[FieldPosition["HEADER"] = 0] = "HEADER";
  FieldPosition[FieldPosition["TRAILER"] = 1] = "TRAILER";
})(FieldPosition || (FieldPosition = {}));
console.log(FieldPosition.HEADER, FieldPosition.TRAILER, FieldPosition[0], FieldPosition[1]);

const SMITHY_CONTEXT_KEY = "__smithy_context";
const getSmithyContext = (context) => context[SMITHY_CONTEXT_KEY] || (context[SMITHY_CONTEXT_KEY] = {});
let context = {};
const first = getSmithyContext(context);
first.count = 7;
const second = getSmithyContext(context);
console.log(first === second, first === context[SMITHY_CONTEXT_KEY], second.count);

function checkAssignment(target) {
  const assigned = (target["nested"] = { value: 3 });
  assigned.value = 11;
  console.log(assigned === target.nested, target.nested.value);
  console.log((target["left"] = target["right"] = 42), target.left, target.right);
}
checkAssignment({});
