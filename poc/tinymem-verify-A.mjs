const { LiteCtx } = await import(process.env.LC + "/src/index.js");
const ctx = new LiteCtx({ root: "/tmp/claude-1000", dbPath: ":memory:" });
const A = ctx.scoped("A"), B = ctx.scoped("B");
await A.ingest(Buffer.from("alpha secret text"), { filename: "contract.txt" });
console.log("A recall before B:", (await A.recall("alpha secret", { kind: "doc" })).length);
await B.ingest(Buffer.from("beta other text"), { filename: "contract.txt" });
console.log("A recall after B:", (await A.recall("alpha secret", { kind: "doc" })).length);
console.log("B recall:", (await B.recall("beta other", { kind: "doc" })).length);
// remember doc same id
await A.remember("faq1","alpha faq text",{kind:"doc"});
await B.remember("faq1","beta faq text",{kind:"doc"});
console.log("A faq1:", (await A.recall("alpha faq", { kind: "doc" })).length, "B faq1:", (await B.recall("beta faq", { kind: "doc" })).length);
