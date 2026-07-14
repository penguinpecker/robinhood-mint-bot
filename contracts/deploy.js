// Deploy Robinhood Mint Bot Pass. Your key stays local — nothing is sent anywhere but the deploy tx.
//   PRIVATE_KEY=0x<deployer key>  [RPC_URL=...]  [BASE_URI=...]  node deploy.js
// Testnet (recommended for testing, free faucet ETH):
//   RPC_URL=https://rpc.testnet.chain.robinhood.com PRIVATE_KEY=0x... node deploy.js
const { ethers } = require("ethers");
const { abi, bytecode } = require("./RobinhoodMintBotPass.json");

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const KEY = process.env.PRIVATE_KEY;
const BASE_URI = process.env.BASE_URI || "";

(async () => {
  if (!KEY) throw new Error("Set PRIVATE_KEY (deployer key, funded with a little ETH for gas).");
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(KEY, provider);
  const net = await provider.getNetwork();
  const bal = await provider.getBalance(wallet.address);
  console.log("Deployer :", wallet.address);
  console.log("Network  : chainId", net.chainId.toString(), "· balance", ethers.formatEther(bal), "ETH");
  if (bal === 0n) throw new Error("Deployer has 0 balance — fund it first.");

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const c = await factory.deploy(BASE_URI);
  console.log("Deploy tx:", c.deploymentTransaction().hash, "— waiting…");
  await c.waitForDeployment();
  const addr = await c.getAddress();
  const explorer = net.chainId === 4663n
    ? "https://robinhoodchain.blockscout.com/address/" + addr
    : "https://explorer.testnet.chain.robinhood.com/address/" + addr;

  console.log("\n✅ Robinhood Mint Bot Pass deployed");
  console.log("   Address :", addr);
  console.log("   Explorer:", explorer);
  console.log("   Supply  : 10,000 · Price: 0.0001 ETH · all public");
  console.log("\nTest with the bot (robinhood-mint-bot.vercel.app):");
  console.log("  1. Paste this address, Fetch functions.");
  console.log("  2. spray / sequencer-direct → pick mint(uint256), value 0.0001 per mint.");
  console.log("  3. bulk → pick mintTo(address,uint256), set the address arg to YOUR wallet.");
})().catch((e) => { console.error("Deploy failed:", e.shortMessage || e.message); process.exit(1); });
