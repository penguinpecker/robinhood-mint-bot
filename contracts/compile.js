// Compiles RobinhoodMintBotPass.sol (resolving erc721a + OpenZeppelin from node_modules)
// and writes RobinhoodMintBotPass.json { abi, bytecode }.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const SRC = "RobinhoodMintBotPass.sol";

function findImports(importPath) {
  const candidates = [
    path.join(__dirname, importPath),
    path.join(__dirname, "node_modules", importPath),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { contents: fs.readFileSync(p, "utf8") };
  }
  return { error: "File not found: " + importPath };
}

const input = {
  language: "Solidity",
  sources: { [SRC]: { content: fs.readFileSync(path.join(__dirname, SRC), "utf8") } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
let failed = false;
for (const e of out.errors || []) {
  if (e.severity === "error") { failed = true; console.error(e.formattedMessage); }
}
if (failed) process.exit(1);

const c = out.contracts[SRC]["RobinhoodMintBotPass"];
const bytecode = "0x" + c.evm.bytecode.object;
fs.writeFileSync(
  path.join(__dirname, "RobinhoodMintBotPass.json"),
  JSON.stringify({ abi: c.abi, bytecode }, null, 2)
);
console.log("compiled OK");
console.log("runtime deploy size (bytes):", bytecode.length / 2 - 1, "(EIP-170 limit 24576)");
const fns = c.abi.filter((x) => x.type === "function").map((x) => x.name);
console.log("functions:", fns.join(", "));
