// Ordinary data records have the unmodified intrinsic Object.prototype.
// Prototype setters and symbol slots remain fenced at their write sites.
// rawJSON is handled separately: its object has a null prototype.
fn native_object_prototype_has_key(key: &runtime::JsString) -> bool {
    matches!(key.well_formed_utf8(), Some(
        "constructor" | "__defineGetter__" | "__defineSetter__" | "hasOwnProperty"
        | "__lookupGetter__" | "__lookupSetter__" | "isPrototypeOf"
        | "propertyIsEnumerable" | "toString" | "valueOf" | "__proto__" | "toLocaleString"
    ))
}

fn native_bytes_prototype_has_key(key: &runtime::JsString, buffer: bool) -> bool {
    let typed_array = matches!(key.well_formed_utf8(), Some(
        "at" | "buffer" | "byteLength" | "byteOffset" | "BYTES_PER_ELEMENT"
        | "entries" | "every" | "fill" | "filter" | "find" | "findIndex"
        | "findLast" | "findLastIndex" | "forEach" | "includes" | "indexOf"
        | "join" | "keys" | "lastIndexOf" | "length" | "map" | "reduce"
        | "reduceRight" | "reverse" | "set" | "slice" | "some" | "sort"
        | "subarray" | "toLocaleString" | "toReversed" | "toSorted"
        | "toString" | "values" | "with"
    ));
    let buffer_method = buffer && matches!(key.well_formed_utf8(), Some(
        "asciiSlice" | "asciiWrite" | "base64Slice" | "base64Write"
        | "compare" | "copy" | "equals" | "hexSlice" | "hexWrite"
        | "readBigInt64BE" | "readBigInt64LE" | "readBigUInt64BE"
        | "readBigUInt64LE" | "readDoubleBE" | "readDoubleLE" | "readFloatBE"
        | "readFloatLE" | "readInt8" | "readInt16BE" | "readInt16LE"
        | "readInt32BE" | "readInt32LE" | "readIntBE" | "readIntLE"
        | "readUInt8" | "readUInt16BE" | "readUInt16LE" | "readUInt32BE"
        | "readUInt32LE" | "readUIntBE" | "readUIntLE" | "swap16" | "swap32"
        | "swap64" | "toJSON" | "ucs2Slice" | "ucs2Write" | "utf8Slice"
        | "utf8Write" | "write" | "writeBigInt64BE" | "writeBigInt64LE"
        | "writeBigUInt64BE" | "writeBigUInt64LE" | "writeDoubleBE"
        | "writeDoubleLE" | "writeFloatBE" | "writeFloatLE" | "writeInt8"
        | "writeInt16BE" | "writeInt16LE" | "writeInt32BE" | "writeInt32LE"
        | "writeIntBE" | "writeIntLE" | "writeUInt8" | "writeUInt16BE"
        | "writeUInt16LE" | "writeUInt32BE" | "writeUInt32LE" | "writeUIntBE"
        | "writeUIntLE"
    ));
    typed_array || buffer_method || native_object_prototype_has_key(key)
}
