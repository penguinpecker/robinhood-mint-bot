# Robinhood Mint Bot Pass — test collection

ERC721A test NFT for exercising the RH Mint Bot's mint methods.

- **Name / symbol:** Robinhood Mint Bot Pass / `RHMBP`
- **Supply:** 10,000 — **all public**, no allowlist, no reserve
- **Price:** 0.0001 ETH per mint
- **No per-wallet cap and no `tx.origin` gate** → spray, sequencer-direct, and bulk methods all work
- `mint(uint256 qty)` → mints to `msg.sender` (spray / sequencer-direct)
- `mintTo(address to, uint256 qty)` → mints to `to` (bulk: set `to` = your wallet)
- Owner-only: `setBaseURI`, `setMintOpen`, `withdraw`

Verified against Robinhood mainnet by `eth_call` deploy-simulation: constructor runs, `PRICE` = 1e14 wei
(0.0001 ETH), `MAX_SUPPLY` = 10000, runtime 5.4 KB (well under the 24 KB EIP-170 limit).

## Compile
```
cd contracts && npm install && node compile.js   # -> RobinhoodMintBotPass.json {abi, bytecode}
```

## Deploy
Your key stays on your machine — the script only sends the deploy tx.

```
# Testnet first (free faucet ETH, chainId 46630):
RPC_URL=https://rpc.testnet.chain.robinhood.com PRIVATE_KEY=0x<key> node deploy.js

# Mainnet (chainId 4663):
PRIVATE_KEY=0x<key> node deploy.js
```
Prints the deployed address + explorer link.

## Verify on Blockscout (optional, makes the bot's ABI auto-fetch work)
- Contract: `RobinhoodMintBotPass` · compiler **solc 0.8.24** · optimizer **on, 200 runs** · EVM **paris**
- Constructor arg: `baseURI` (string) — the value you passed (default empty `""`)
- Flatten with the `erc721a` + `@openzeppelin/contracts` imports, or use Blockscout standard-JSON verification.
- If you skip verification, the bot still works: use **Function + args** or paste raw calldata.

## Solidity
See `RobinhoodMintBotPass.sol`.
