# RH Mint Bot

A fast, client-side NFT minting bot for **Robinhood Chain** (works on any EVM chain). Deploys to Vercel as a
static site, but runs **entirely in the user's browser** — private keys never touch the server.

> **Unofficial / community tool.** Not affiliated with, endorsed by, or operated by Robinhood. "Robinhood Chain"
> refers to the public EVM L2; this is an independent utility that talks to it over standard JSON-RPC.

## Security model (the important part)
- **Client-side only.** The page is static. All logic — key handling, signing, RPC calls — runs in the browser.
- **Keys never leave the browser.** Private keys are held in memory only. They are **never** sent to this site,
  any server, disk, `localStorage`/`sessionStorage`/cookies/IndexedDB. They only ever leave as a **signed
  transaction**, sent from the **user's own IP** directly to the RPCs they configure. (Verified in-browser: after
  connecting and loading a key, all storage stays empty and no cookies are set.)
- **No runtime CDN.** ethers v6.13.4 is vendored (`public/vendor/`) and self-hosted. `Content-Security-Policy`
  blocks all external scripts, so nothing can be injected to exfiltrate a key.
- **RPC from the user's IP, not the site's.** Because all calls are client-side, each user's requests come from
  their own IP with their own rate limit — the site can never be IP-blocked by an RPC, and there is no shared
  server key to exhaust. This is why we do **not** embed a shared Alchemy key: it would be publicly readable and
  every user would contend for one quota. Users bring their own RPCs instead.

## Features
- **Rotating RPC pool** — paste multiple endpoints (one per line); the bot round-robins and cools down any that
  rate-limit, so continuous minting doesn't get blocked. Pre-seeded with Robinhood's public RPC + Alchemy/QuickNode
  templates. "Test / connect pool" shows per-endpoint latency, block, and chainId.
- **Auto-fetch mint functions** — paste the contract's explorer link (or address) and it pulls the ABI (Blockscout
  `getabi` → Blockscout v2 → Sourcify → bytecode-selector fallback via openchain), lists the callable functions
  tagged **public** / **whitelist** / **admin?**, and renders typed inputs for the one you pick. Falls back to raw
  calldata / "import from an existing mint tx" for unverified contracts.
- **Gas selector with live $ estimate** — Floor / Market / Fast 2× / Aggressive 5× / Custom, priced in USD from the
  live chain gas price × gas limit × ETH price (CoinGecko). On Robinhood's FCFS sequencer, tip buys no priority —
  the UI reflects this (tip 0, latency wins).
- **Multi-wallet** — one key per line; per-wallet pending-nonce batching.
- **Selectable mint methods** — the same mint, sent three different ways on-chain:
  - **Spray** (default) — each wallet signs its own mint tx, all raced across the RPC pool. Works even when the
    contract enforces `tx.origin == msg.sender`. Beat per-wallet caps with more wallets.
  - **Sequencer-direct** — same per-wallet txs, submitted straight to the chain's sequencer endpoint (bypasses
    public-RPC rate limits; lowest latency on the single FCFS sequencer). Reads still use the RPC pool.
  - **Bulk** — deploys a throwaway `BulkMinter` contract that relays the mint call **N times in one transaction**
    (bytecode embedded, verified via `eth_call` deploy-simulation). Bypasses per-*tx* limits for one gas payment.
    Set the mint's recipient arg to your own address; it **reverts** if the contract requires `tx.origin == msg.sender`.
  - Advanced methods not shipped by default (documented for reference): a **CREATE2 disposable-minter army** (fresh
    `msg.sender` per child to defeat per-wallet caps + `extcodesize` gates) and **EIP-7702 self-delegation** (the only
    contract-style method that survives a `tx.origin == msg.sender` gate).
- **Continuous / triggered firing** — fire once or repeat until N successes / until stopped, with an interval;
  optional trigger at a block height or unix time. All transactions are **pre-signed before the trigger** for the
  lowest possible fire-time latency.
- **Simulate** (`eth_call`) and **Estimate gas** before firing.

## Robinhood Chain facts (live-verified 2026-07-14)
- Mainnet chain ID **4663** (`0x1237`), testnet **46630**. Native gas **ETH**. Arbitrum-Orbit / Nitro L2.
- Public RPC `https://rpc.mainnet.chain.robinhood.com` (rate-limited). Alchemy `robinhood-mainnet.g.alchemy.com`,
  QuickNode, dRPC, Blockdaemon also support it.
- Explorer: Blockscout `https://robinhoodchain.blockscout.com`.
- Single centralized **FCFS sequencer, no public mempool**, ~100 ms blocks, gas ≈ 0.047 gwei (floor 0.02).
  A mint costs a fraction of a cent. **Latency wins, not gas bidding.**
- Permissionless: anyone can deploy ERC-721/1155 and transact (only Robinhood's own stock tokens are restricted).

## Run locally
Serve `public/` (needed so `script-src 'self'` resolves — don't just double-click the file):
```
npm run dev          # python3 -m http.server 8080 --directory public
# open http://localhost:8080
```

## Deploy to Vercel
Static, zero-build. `vercel.json` sets `outputDirectory: public` and adds hardened security headers (CSP, nosniff,
no-referrer, X-Frame-Options DENY, Permissions-Policy).
```
vercel            # preview
vercel --prod     # production
```
> Note: this hosts a tool where users paste private keys. Treat the URL as sensitive and intended for the operator's
> own use. The app is safe by construction (client-side, no exfiltration path), but a public key-input URL should not
> be shared casually.

## Files
- `public/index.html` — UI + inline CSS.
- `public/app.js` — all logic (RPC pool, ABI fetch, gas, signing, firing).
- `public/vendor/ethers.umd.min.js` — pinned ethers v6.13.4.
- `vercel.json`, `package.json` — deploy config.
