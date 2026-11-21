// @ts-nocheck
/// <reference types="node" />
const removed = () => console.log("removed");
const kept = () => console.log("kept");
let monitor = null;
monitor = () => console.log("monitor");

process.on("exit", removed);
process.off("exit", removed);
process.on("exit", kept);
process.on("uncaughtExceptionMonitor", monitor);
if (monitor) process.off("uncaughtExceptionMonitor", monitor);
console.log("body");
