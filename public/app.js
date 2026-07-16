"use strict";
(function () {
  const E = window.ethers;
  const $ = (id) => document.getElementById(id);

  // ---------- chain presets ----------
  const CHAINS = {
    "rh-main": {
      name: "Robinhood Mainnet", chainId: 4663, coingecko: "ethereum",
      explorerApi: "https://robinhoodchain.blockscout.com/api",
      sequencer: "https://sequencer.mainnet.chain.robinhood.com",
      providers: [
        { name: "Public (rate-limited)", url: "https://rpc.mainnet.chain.robinhood.com", on: true },
        { name: "Alchemy", url: "https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY" },
        { name: "QuickNode", url: "https://ENDPOINT.robinhood-mainnet.quiknode.pro/TOKEN/" },
        { name: "dRPC", url: "https://lb.drpc.org/ogrpc?network=robinhood&dkey=YOUR_KEY" },
        { name: "Custom", url: "" },
      ],
    },
    "rh-test": {
      name: "Robinhood Testnet", chainId: 46630, coingecko: "ethereum",
      explorerApi: "https://explorer.testnet.chain.robinhood.com/api",
      sequencer: "https://sequencer.testnet.chain.robinhood.com",
      providers: [
        { name: "Public (rate-limited)", url: "https://rpc.testnet.chain.robinhood.com", on: true },
        { name: "Alchemy", url: "https://robinhood-testnet.g.alchemy.com/v2/YOUR_KEY" },
        { name: "Custom", url: "" },
      ],
    },
    "custom": { name: "Custom", chainId: 1, coingecko: "ethereum", explorerApi: "", providers: [{ name: "Custom", url: "", on: true }] },
  };

  // BulkMinter creation bytecode — constructor(address target, uint256 count, bytes data) payable.
  // Relays the mint call `count` times in ONE tx. Compiled solc 0.8.24 (paris, opt 200);
  // deploy verified via eth_call against Robinhood mainnet.
  const MINTER_BYTECODE = "0x608060405260405161026938038061026983398101604081905261002291610107565b600082156100395761003483346101de565b61003c565b60005b905060005b838110156100c357600080866001600160a01b031684866040516100659190610200565b60006040518083038185875af1925050503d80600081146100a2576040519150601f19603f3d011682016040523d82523d6000602084013e6100a7565b606091505b5091509150816100b957805160208201fd5b5050600101610041565b505050505061021c565b634e487b7160e01b600052604160045260246000fd5b60005b838110156100fe5781810151838201526020016100e6565b50506000910152565b60008060006060848603121561011c57600080fd5b83516001600160a01b038116811461013357600080fd5b6020850151604086015191945092506001600160401b038082111561015757600080fd5b818601915086601f83011261016b57600080fd5b81518181111561017d5761017d6100cd565b604051601f8201601f19908116603f011681019083821181831017156101a5576101a56100cd565b816040528281528960208487010111156101be57600080fd5b6101cf8360208301602088016100e3565b80955050505050509250925092565b6000826101fb57634e487b7160e01b600052601260045260246000fd5b500490565b600082516102128184602087016100e3565b9190910192915050565b603f8061022a6000396000f3fe6080604052600080fdfea26469706673582212206ffc3a20774c8a7f252e64f51bcc9411268868e416216c6f6ef53e3aca3e7d4c64736f6c63430008180033";

  // ---------- state (memory only) ----------
  let currentPreset = "rh-main";
  let chainId = 4663n;
  let wallets = [];          // [{wallet, address}]
  let pool = [];             // [{url, provider, coolUntil, ok, latency, chainId}]
  let rr = 0;
  let contractAddr = null;
  let abiFragments = [];     // available FunctionFragment list
  let selectedFrag = null;
  let contractIface = null;  // full ABI interface (incl. custom errors) for revert decoding
  let encodedCalldata = null;
  let gasMode = "market";
  let gasAuto = true;        // auto-estimate the gas limit on-chain
  let gasTimer = null;
  let ethUsd = null, ethUsdAt = 0;
  let feeGp = null, feeGpAt = 0;
  let running = false, stopFlag = false;
  let rpcRows = [];          // [{url, on}] — the RPC selector state

  // ---------- logging ----------
  const logEl = $("log");
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  const now = () => { const d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); };
  function log(msg, cls) {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.textContent = "[" + now() + "] " + msg + "\n";
    logEl.appendChild(s); logEl.scrollTop = logEl.scrollHeight;
  }
  $("clearLog").onclick = () => { logEl.textContent = ""; };
  $("copyLog").onclick = () => { navigator.clipboard && navigator.clipboard.writeText(logEl.textContent); };
  const shrink = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  const round4 = (s) => { const n = parseFloat(s); return (Math.round(n * 10000) / 10000).toString(); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shortHost = (u) => { try { return new URL(u).host; } catch (e) { return u; } };
  // decode a revert into a human reason: contract's own custom errors, Error(string), or known selectors
  const KNOWN_ERRORS = { "0x15e26ff3": "OnlyAllowedSeaDrop() — mint through the SeaDrop contract, not this one" };
  function decodeRevert(e) {
    const data = (e && (e.data || (e.info && e.info.error && e.info.error.data) || (e.error && e.error.data))) || null;
    if (data && data !== "0x") {
      if (contractIface) { try { const er = contractIface.parseError(data); return er.name + "(" + er.args.map(String).join(", ") + ")"; } catch (_) {} }
      if (data.slice(0, 10) === "0x08c379a0") { try { return '"' + E.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0] + '"'; } catch (_) {} }
      if (KNOWN_ERRORS[data.slice(0, 10)]) return KNOWN_ERRORS[data.slice(0, 10)];
      return "custom error " + data.slice(0, 10) + " (not in the loaded ABI)";
    }
    return e.shortMessage || e.reason || e.message || "reverted";
  }

  // ---------- key wiping ----------
  function wipeKeys() {
    wallets = [];
    $("keys").value = "";
    $("walletStatus").innerHTML = 'No wallets loaded. <span class="ok">keys wiped from memory.</span>';
    log("Keys wiped from memory + field.", "warn");
  }
  $("panic").onclick = wipeKeys;
  $("wipe2").onclick = wipeKeys;
  $("clearKeysField").onclick = () => { $("keys").value = ""; };
  window.addEventListener("beforeunload", () => { wallets = []; try { $("keys").value = ""; } catch (e) {} });
  $("toggleMask").onclick = () => {
    const t = $("keys"), b = $("toggleMask");
    if (t.classList.contains("mask")) { t.classList.remove("mask"); b.textContent = "Hide"; }
    else { t.classList.add("mask"); b.textContent = "Show"; }
  };

  // ---------- preset + RPC selector ----------
  function applyPreset(key) {
    currentPreset = key;
    const c = CHAINS[key];
    if (key !== "custom") { $("chainId").value = c.chainId; $("explorerApi").value = c.explorerApi; }
    chainId = BigInt($("chainId").value.trim() || "1");
    // seed the RPC selector with the providers marked on:true (the public endpoint by default)
    rpcRows = (c.providers || []).filter((p) => p.on).map((p) => ({ url: p.url, on: true }));
    if (!rpcRows.length && c.providers && c.providers[0]) rpcRows = [{ url: c.providers[0].url, on: true }];
    // fill the "add provider" dropdown
    const sel = $("rpcProvider");
    sel.innerHTML = (c.providers || [{ name: "Custom", url: "" }]).map((p, i) => '<option value="' + i + '">' + esc(p.name) + "</option>").join("");
    renderRpcRows();
  }
  function renderRpcRows() {
    $("rpcList").innerHTML = rpcRows.map((r, i) =>
      '<div class="rpcrow"><input type="checkbox" data-i="' + i + '" class="rchk"' + (r.on ? " checked" : "") + '>' +
      '<input type="text" data-i="' + i + '" class="rurl" value="' + esc(r.url) + '" placeholder="https://… RPC URL" spellcheck="false" autocomplete="off">' +
      '<button class="rm" data-i="' + i + '" title="remove">✕</button></div>'
    ).join("");
  }
  $("rpcList").addEventListener("input", (e) => {
    const i = +e.target.dataset.i;
    if (e.target.classList.contains("rchk")) rpcRows[i].on = e.target.checked;
    else if (e.target.classList.contains("rurl")) rpcRows[i].url = e.target.value.trim();
  });
  $("rpcList").addEventListener("click", (e) => {
    if (!e.target.classList.contains("rm")) return;
    rpcRows.splice(+e.target.dataset.i, 1); renderRpcRows();
  });
  $("addRpc").onclick = () => {
    const c = CHAINS[currentPreset]; const p = (c.providers || [])[+$("rpcProvider").value] || { url: "" };
    rpcRows.push({ url: p.url, on: true }); renderRpcRows();
  };
  $("preset").onchange = () => applyPreset($("preset").value);
  $("chainId").onchange = () => { chainId = BigInt($("chainId").value.trim() || "1"); };

  // ---------- RPC pool ----------
  function makeProvider(url) {
    const net = E.Network.from(BigInt($("chainId").value.trim() || "1"));
    if (url.startsWith("ws")) return new E.WebSocketProvider(url, net);
    return new E.JsonRpcProvider(url, net, { staticNetwork: net, batchMaxCount: 1 });
  }
  function parseRpcList() {
    return rpcRows.filter((r) => r.on && r.url && !/YOUR_KEY|ENDPOINT|TOKEN|YOUR_ALCHEMY/i.test(r.url)).map((r) => r.url);
  }
  function buildPool() {
    const urls = parseRpcList();
    pool = urls.map((url) => ({ url, provider: makeProvider(url), coolUntil: 0, ok: null, latency: null, chainId: null }));
    rr = 0;
    return pool;
  }
  function activeProviders() { const t = Date.now(); return pool.filter((p) => p.ok !== false && p.coolUntil <= t); }
  function pickEndpoint() {
    let a = activeProviders();
    if (!a.length) { pool.forEach((p) => (p.coolUntil = 0)); a = pool.filter((p) => p.ok !== false); }
    if (!a.length) a = pool;
    if (!a.length) return null;
    rr = (rr + 1) % a.length;
    return a[rr];
  }
  const RETRYABLE = /rate|429|limit|timeout|failed to fetch|networkerror|load failed|econn|fetch|503|502|504|bad gateway|too many/i;
  const DETERMINISTIC = /revert|insufficient funds|nonce|already known|underpriced|intrinsic|gas required/i;
  async function rpc(fn, tries) {
    tries = tries || Math.max(3, pool.length + 1);
    if (!pool.length) buildPool();
    let lastErr;
    for (let i = 0; i < tries; i++) {
      const ep = pickEndpoint();
      if (!ep) throw new Error("no RPC endpoints configured");
      try { return await fn(ep.provider); }
      catch (e) {
        lastErr = e;
        const msg = (e.shortMessage || e.info?.error?.message || e.message || "").toLowerCase();
        if (DETERMINISTIC.test(msg)) throw e;           // deterministic → don't shop around
        if (RETRYABLE.test(msg)) ep.coolUntil = Date.now() + 8000;
      }
    }
    throw lastErr;
  }

  $("testRpcs").onclick = async () => {
    buildPool();
    if (!pool.length) { log("Add at least one RPC URL.", "bad"); return; }
    $("netStatus").textContent = "Testing " + pool.length + " endpoint(s)…";
    const rows = [];
    await Promise.all(pool.map(async (ep) => {
      const t0 = Date.now();
      try {
        // query the REAL chain id (send bypasses staticNetwork, which would just echo the configured value)
        const [cidHex, bn] = await Promise.all([ep.provider.send("eth_chainId", []), ep.provider.getBlockNumber()]);
        ep.latency = Date.now() - t0; ep.chainId = BigInt(cidHex); ep.ok = true; ep.block = bn;
      } catch (e) { ep.ok = false; ep.err = (e.shortMessage || e.message || "").slice(0, 60); }
    }));
    const want = BigInt($("chainId").value.trim() || "1");
    for (const ep of pool) {
      if (ep.ok) {
        const mism = ep.chainId !== want ? ' <span class="bad">chainId ' + ep.chainId + " ≠ " + want + "</span>" : "";
        rows.push("<tr><td class='ok'>OK</td><td>" + ep.latency + "ms</td><td>blk " + ep.block + "</td><td><b>" + esc(ep.url) + "</b>" + mism + "</td></tr>");
      } else {
        rows.push("<tr><td class='bad'>FAIL</td><td>—</td><td>—</td><td><b>" + esc(ep.url) + "</b> " + esc(ep.err || "") + "</td></tr>");
      }
    }
    $("rpcTable").innerHTML = "<table class='rpc'>" + rows.join("") + "</table>";
    const okc = pool.filter((p) => p.ok).length;
    const fast = pool.filter((p) => p.ok).sort((a, b) => a.latency - b.latency)[0];
    $("netStatus").innerHTML = '<span class="' + (okc ? "ok" : "bad") + '">' + okc + "/" + pool.length + " live.</span>" +
      (fast ? " fastest <b>" + fast.latency + "ms</b> · block <b>" + fast.block + "</b> · chainId <b>" + fast.chainId + "</b>" : "");
    log(okc + "/" + pool.length + " RPC endpoints live.", okc ? "ok" : "bad");
    refreshGas();
    maybeAutoGas();
  };

  // ---------- wallets ----------
  function normKey(k) { k = k.trim(); if (!k || k[0] === "#") return null; if (!k.startsWith("0x")) k = "0x" + k; return k; }
  $("loadKeys").onclick = async () => {
    const next = []; let idx = 0;
    for (const raw of $("keys").value.split("\n")) {
      const k = normKey(raw); if (!k) continue; idx++;
      try { const w = new E.Wallet(k); next.push({ wallet: w, address: w.address }); }
      catch (e) { log("Line " + idx + ": invalid private key — skipped.", "bad"); }
    }
    if (!next.length) {
      $("walletStatus").innerHTML = wallets.length
        ? '<span class="warn">No new keys parsed — keeping ' + wallets.length + " loaded.</span>"
        : '<span class="bad">No valid keys loaded.</span>';
      return;
    }
    wallets = next;
    $("keys").value = ""; // hold keys in memory only; clear the field to shorten on-screen exposure
    let html = '<span class="ok">' + wallets.length + " wallet(s) loaded.</span> <span class=\"kv\">input cleared — held in memory</span><br>";
    for (const w of wallets) html += '<span class="pill">' + shrink(w.address) + "</span>";
    $("walletStatus").innerHTML = html;
    log(wallets.length + " wallet(s) loaded; key field cleared.", "ok");
    if (pool.length) {
      for (const w of wallets) {
        try { const bal = await rpc((p) => p.getBalance(w.address)); log("  " + shrink(w.address) + " balance " + E.formatEther(bal) + " ETH", ""); } catch (e) {}
      }
    }
    updateTotal();
    maybeAutoGas();
  };

  // ---------- contract: address + ABI ----------
  function parseAddr(s) { const m = s.match(/0x[a-fA-F0-9]{40}/); if (!m) return null; try { return E.getAddress(m[0]); } catch (e) { return null; } }

  function classify(name) {
    const n = name.toLowerCase();
    if (/whitelist|allowlist|presale|allow_?list|_wl|wlmint|earlymint/.test(n)) return "wl";
    if (/mint|claim|purchase|buy|drop|publicsale|public_?mint/.test(n)) return "pub";
    if (/owner|admin|withdraw|setbaseuri|reveal|pause|teammint|reservemint|airdrop|setprice|toggle/.test(n)) return "adm";
    return null;
  }

  async function fetchAbi(addr) {
    const api = $("explorerApi").value.trim();
    if (api) {
      try {
        const url = api + (api.includes("?") ? "&" : "?") + "module=contract&action=getabi&address=" + addr;
        const j = await (await fetch(url)).json();
        if (j.status === "1" && typeof j.result === "string" && j.result.trim().startsWith("[")) return { abi: JSON.parse(j.result), source: "explorer getabi" };
      } catch (e) {}
      try {
        const base = api.replace(/\/api\/?$/, "");
        const r = await fetch(base + "/api/v2/smart-contracts/" + addr);
        if (r.ok) { const j = await r.json(); if (j.abi) return { abi: j.abi, source: "explorer v2" }; }
      } catch (e) {}
    }
    try {
      const r = await fetch("https://sourcify.dev/server/v2/contract/" + chainId + "/" + addr + "?fields=abi");
      if (r.ok) { const j = await r.json(); if (j.abi) return { abi: j.abi, source: "sourcify v2" }; }
    } catch (e) {}
    // unverified: pull selectors from bytecode, resolve names
    try {
      const code = await rpc((p) => p.getCode(addr));
      if (code && code !== "0x") {
        const sels = extractSelectors(code);
        const resolved = await resolveSelectors(sels);
        return { abi: null, selectors: resolved, source: "unverified (bytecode selectors)" };
      }
    } catch (e) {}
    return { abi: null, selectors: [], source: "not found" };
  }
  function extractSelectors(code) {
    const hex = code.slice(2); const set = new Set();
    for (let i = 0; i + 10 <= hex.length; i += 2) {
      if (hex.substr(i, 2) === "63") set.add("0x" + hex.substr(i + 2, 8).toLowerCase());
    }
    return [...set];
  }
  async function resolveSelectors(sels) {
    const out = [];
    try {
      const q = sels.slice(0, 300).join(",");
      const j = await (await fetch("https://api.openchain.xyz/signature-database/v1/lookup?function=" + encodeURIComponent(q) + "&filter=true")).json();
      const map = (j.result && j.result.function) || {};
      for (const s of sels) { const arr = map[s]; if (arr && arr.length) out.push(arr[0].name); }
    } catch (e) {}
    return out;
  }

  $("fetchFns").onclick = () => fetchFunctions();
  async function fetchFunctions() {
    const addr = parseAddr($("contract").value);
    if (!addr) { log("Couldn't find a contract address in that input.", "bad"); return; }
    contractAddr = addr;
    if (!pool.length) buildPool();
    $("abiStatus").textContent = "Fetching ABI for " + shrink(addr) + " …";
    abiFragments = []; selectedFrag = null; encodedCalldata = null;
    $("fnParams").classList.add("hidden"); $("fnList").innerHTML = "";
    try {
      const res = await fetchAbi(addr);
      let frags = [];
      contractIface = null;
      if (res.abi) {
        const iface = new E.Interface(res.abi);
        contractIface = iface;   // keep the full interface so we can decode this contract's custom errors
        iface.forEachFunction((f) => { if (f.stateMutability !== "view" && f.stateMutability !== "pure") frags.push(f); });
        // SeaDrop collections must be minted THROUGH the SeaDrop contract, not directly
        if (frags.some((f) => f.name === "mintSeaDrop")) {
          log("⚠ SeaDrop collection: don't call mintSeaDrop directly (reverts OnlyAllowedSeaDrop). Mint via the SeaDrop contract's mintPublic — set the contract field to the SeaDrop address.", "warn");
        }
      } else if (res.selectors && res.selectors.length) {
        for (const sig of res.selectors) {
          try { const f = E.FunctionFragment.from("function " + sig); frags.push(f); } catch (e) {}
        }
      }
      if (!frags.length) {
        $("abiStatus").innerHTML = '<span class="warn">No callable functions found (' + res.source + "). Use manual raw calldata / import from a mint tx below.</span>";
        return;
      }
      // rank: pub, wl first; adm last
      const rank = (f) => { const c = classify(f.name); return c === "pub" ? 0 : c === "wl" ? 1 : c === "adm" ? 3 : 2; };
      frags.sort((a, b) => rank(a) - rank(b));
      abiFragments = frags;
      const chips = frags.map((f, i) => {
        const c = classify(f.name);
        const tag = c === "pub" ? '<span class="tag pub">public</span>' : c === "wl" ? '<span class="tag wl">whitelist</span>' : c === "adm" ? '<span class="tag adm">admin?</span>' : "";
        return '<span class="chip" data-i="' + i + '">' + esc(f.format("sighash")) + tag + "</span>";
      }).join("");
      $("fnList").innerHTML = chips;
      $("abiStatus").innerHTML = '<span class="ok">Loaded ' + frags.length + " functions</span> via " + res.source + ". Pick the mint function:";
      log("ABI loaded (" + res.source + "): " + frags.length + " callable functions.", "ok");
      maybeAutoGas();
    } catch (e) {
      $("abiStatus").innerHTML = '<span class="bad">ABI fetch failed: ' + esc(e.shortMessage || e.message) + "</span>";
    }
  }

  $("fnList").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip"); if (!chip) return;
    for (const c of $("fnList").children) c.classList.toggle("on", c === chip);
    selectFn(parseInt(chip.dataset.i, 10));
  });

  function selectFn(i) {
    selectedFrag = abiFragments[i];
    $("fnPickedLbl").textContent = "▸ " + selectedFrag.format("full");
    const rows = selectedFrag.inputs.map((inp, k) => {
      const name = esc(inp.name || "arg" + k);
      const ph = inp.type.endsWith("[]") || inp.type.startsWith("tuple") ? "JSON, e.g. [\"0x..\"]" : inp.type === "address" ? "0x…" : inp.type.startsWith("uint") ? "e.g. 1" : "";
      return '<div class="f" style="margin-top:6px"><label>' + name + " <span class='kv'>(" + esc(inp.type) + ")</span></label>" +
        '<input id="p' + k + '" placeholder="' + esc(ph) + '" spellcheck="false" autocomplete="off"></div>';
    }).join("");
    $("paramInputs").innerHTML = rows || '<div class="hint">No arguments.</div>';
    $("fnParams").classList.remove("hidden");
    selectedFrag.inputs.forEach((inp, k) => { $("p" + k).addEventListener("input", encodeSelected); });
    encodeSelected();
  }

  function coerceArg(v, type) {
    v = (v || "").trim();
    if (type.endsWith("[]") || type.startsWith("tuple")) return JSON.parse(v || "[]");
    if (type === "bool") return v === "true" || v === "1";
    return v; // uint/int/address/bytes/string — ethers coerces strings
  }
  function encodeSelected() {
    if (!selectedFrag) return;
    try {
      const iface = new E.Interface([selectedFrag.format("full")]);
      const args = selectedFrag.inputs.map((inp, k) => coerceArg($("p" + k).value, inp.type));
      encodedCalldata = iface.encodeFunctionData(selectedFrag.name, args);
      $("calldataOut").value = encodedCalldata;
    } catch (e) { encodedCalldata = null; $("calldataOut").value = "⚠ " + (e.shortMessage || e.message); }
    updateTotal();
    maybeAutoGas();
  }

  function getCalldata() {
    const raw = $("calldata").value.trim();
    if (raw) return raw.startsWith("0x") ? raw : "0x" + raw;
    if (encodedCalldata) return encodedCalldata;
    throw new Error("No calldata — pick a function or paste raw calldata.");
  }

  $("importTx").onclick = async () => {
    if (!pool.length) buildPool();
    const h = $("txhash").value.trim(); if (!h) { log("Enter a tx hash.", "bad"); return; }
    try {
      const tx = await rpc((p) => p.getTransaction(h));
      if (!tx) { log("Tx not found on these RPCs.", "bad"); return; }
      contractAddr = tx.to; $("contract").value = tx.to || "";
      $("calldata").value = tx.data || "0x"; $("value").value = E.formatEther(tx.value || 0n);
      log("Imported from " + shrink(h) + " → to " + shrink(tx.to) + " value " + E.formatEther(tx.value || 0n) + " calldata " + (tx.data || "0x").slice(0, 10) + "…", "ok");
      maybeAutoGas();
    } catch (e) { log("Import failed: " + (e.shortMessage || e.message), "bad"); }
  };

  // ---------- gas ----------
  const GAS_PRESETS = [
    { k: "floor", lbl: "Floor", mult: 1 },
    { k: "market", lbl: "Market", mult: 2 },
    { k: "fast", lbl: "Fast", mult: 4 },
    { k: "aggr", lbl: "Aggr", mult: 10 },
  ];
  // the chart bars ARE the preset selector — click a bar to pick that gas level
  $("gasChart").addEventListener("click", (e) => {
    const col = e.target.closest(".barcol"); if (!col) return;
    gasMode = col.dataset.g;
    $("customFees").classList.add("hidden"); $("gasCustomBtn").classList.remove("on");
    refreshGas(false);
  });
  $("gasCustomBtn").onclick = () => {
    const custom = gasMode !== "custom";
    gasMode = custom ? "custom" : "market";
    $("customFees").classList.toggle("hidden", !custom);
    $("gasCustomBtn").classList.toggle("on", custom);
    refreshGas(false);
  };
  $("refreshGas").onclick = () => refreshGas(true);

  // draw the gas-cost bar chart: max $ per preset (gasLimit × preset maxFee × ETH price)
  function renderGasChart(gp, gl, px) {
    const floor = E.parseUnits("0.02", "gwei");
    const bars = GAS_PRESETS.map((p) => {
      const mf = p.k === "floor" ? (gp > floor ? gp : floor) : gp * BigInt(p.mult);
      const eth = gl > 0n ? Number(E.formatEther(gl * mf)) : 0;
      return { ...p, mf, usd: px ? eth * px : null, eth };
    });
    const maxUsd = Math.max(...bars.map((b) => b.usd || b.eth || 0), 1e-12);
    $("gasChart").innerHTML = bars.map((b) => {
      const h = Math.max(3, Math.round(((b.usd || b.eth || 0) / maxUsd) * 100));
      const val = b.usd != null ? "$" + b.usd.toFixed(4) : (gl > 0n ? b.eth.toFixed(6) : "—");
      return '<div class="barcol' + (gasMode === b.k ? " on" : "") + '" data-g="' + b.k + '">' +
        '<div class="barval">' + val + "</div>" +
        '<div class="bartrack"><div class="bar" style="height:' + h + '%"></div></div>' +
        '<div class="barlbl">' + b.lbl + "</div>" +
        '<div class="bargwei">' + round4(E.formatUnits(b.mf, "gwei")) + "</div></div>";
    }).join("");
  }

  // cache the network gas price with a short TTL so per-keystroke recompute doesn't spam the RPC
  async function getGasPrice(force) {
    if (!force && feeGp && Date.now() - feeGpAt < 8000) return feeGp;
    try { const fd = await rpc((p) => p.getFeeData()); const gp = fd.gasPrice || fd.maxFeePerGas; if (gp) { feeGp = gp; feeGpAt = Date.now(); } } catch (e) {}
    return feeGp;
  }

  async function computeFees(force) {
    let gp = await getGasPrice(force);
    if (!gp) gp = E.parseUnits("0.047", "gwei");
    let maxFee, prio = 0n;
    if (gasMode === "custom") {
      maxFee = E.parseUnits($("maxfee").value.trim() || "0", "gwei");
      prio = E.parseUnits($("prio").value.trim() || "0", "gwei");
    } else {
      const mult = { floor: 1n, market: 2n, fast: 4n, aggr: 10n }[gasMode] || 2n;
      maxFee = gasMode === "floor" ? (gp > E.parseUnits("0.02", "gwei") ? gp : E.parseUnits("0.02", "gwei")) : gp * mult;
      $("maxfee").value = round4(E.formatUnits(maxFee, "gwei"));
      $("prio").value = "0";
    }
    return { type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, gasPrice: gp };
  }

  async function getEthUsd() {
    if (ethUsd && Date.now() - ethUsdAt < 60000) return ethUsd;
    const id = (CHAINS[currentPreset] && CHAINS[currentPreset].coingecko) || "ethereum";
    try { const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + id + "&vs_currencies=usd")).json(); ethUsd = j[id].usd; ethUsdAt = Date.now(); } catch (e) {}
    return ethUsd;
  }

  async function refreshGas(force) {
    const glStr = $("gaslimit").value.trim();
    const gl = glStr ? BigInt(glStr) : 0n;
    let fees;
    try { fees = await computeFees(force === true); }
    catch (e) { $("gasStatus").innerHTML = 'Est. cost per tx: <span class="usd bad">fee fetch failed</span> — ' + esc(e.shortMessage || e.message); return; }
    const px = await getEthUsd();
    if (gl > 0n) {
      const maxWei = gl * fees.maxFeePerGas;
      const realWei = gl * (fees.gasPrice || fees.maxFeePerGas);
      const maxEth = Number(E.formatEther(maxWei)), realEth = Number(E.formatEther(realWei));
      $("gasEth").textContent = "~" + realEth.toFixed(8) + " ETH (max " + maxEth.toFixed(8) + ")";
      $("gasUsd").textContent = px ? "$" + (realEth * px).toFixed(4) + " (max $" + (maxEth * px).toFixed(4) + ")" : "$? (price unavailable)";
    } else {
      $("gasEth").textContent = "set a gas limit"; $("gasUsd").textContent = "—";
    }
    renderGasChart(fees.gasPrice || E.parseUnits("0.047", "gwei"), gl, px);
    updateTotal(px);
  }
  $("gaslimit").addEventListener("input", () => { gasAuto = false; $("gasAutoBtn").classList.remove("on"); $("gasAutoLbl").textContent = "(manual)"; refreshGas(false); });
  $("count").addEventListener("input", () => { updateTotal(); maybeAutoGas(); });

  async function updateTotal(px) {
    const gl = $("gaslimit").value.trim() ? BigInt($("gaslimit").value.trim()) : 0n;
    const count = Math.max(1, parseInt($("count").value.trim() || "1", 10));
    const w = Math.max(1, wallets.length);
    const bulk = $("method") && $("method").value === "bulk";
    const mints = count * w;
    const onchainTx = bulk ? w : mints;
    const perTxGas = gl; // gas limit is per on-chain tx (auto-estimate already accounts for bulk's N mints)
    let costStr = "";
    if (gl > 0n) {
      try {
        const fees = await computeFees();
        px = px || await getEthUsd();
        const gasEth = Number(E.formatEther(perTxGas * (fees.gasPrice || fees.maxFeePerGas))) * onchainTx;
        const valEth = parseFloat($("value").value.trim() || "0") * mints;
        const totEth = gasEth + valEth;
        costStr = " · <b>" + mints + " mint(s)</b> / " + onchainTx + " tx · gas ~" + gasEth.toFixed(8) + " ETH" + (valEth ? " + value " + valEth + " ETH" : "") +
          (px ? ' = <span class="usd">$' + (totEth * px).toFixed(2) + "</span>" : "");
      } catch (e) {}
    }
    $("totalStatus").innerHTML = wallets.length + " wallet(s) × " + count + costStr;
  }

  // ---------- auto gas limit ----------
  function defaultGasLimit() {
    const count = Math.max(1, parseInt($("count").value.trim() || "1", 10));
    return $("method").value === "bulk" ? BigInt(140000 + 70000 * count) : 300000n;
  }
  // estimate the gas for ONE on-chain tx of the current mint (deploy for bulk); null if it can't
  async function estimateGasLimit() {
    if (!wallets.length || !contractAddr) return null;
    if (!pool.length) buildPool();
    try {
      const data = getCalldata();
      const value = E.parseEther($("value").value.trim() || "0");
      let g;
      if ($("method").value === "bulk") {
        const count = Math.max(1, parseInt($("count").value.trim() || "1", 10));
        const args = E.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes"], [contractAddr, BigInt(count), data]);
        g = await rpc((p) => p.estimateGas({ from: wallets[0].address, data: MINTER_BYTECODE + args.slice(2), value: value * BigInt(count) }));
      } else {
        g = await rpc((p) => p.estimateGas({ from: wallets[0].address, to: contractAddr, data, value }));
      }
      return (g * 130n) / 100n; // +30% buffer
    } catch (e) { return null; }
  }
  function setGasLimit(v) { $("gaslimit").value = String(v); refreshGas(false); }
  // debounced auto-fill when the config is ready
  function maybeAutoGas() {
    if (!gasAuto) return;
    clearTimeout(gasTimer);
    gasTimer = setTimeout(async () => {
      if (!gasAuto || !wallets.length || !contractAddr) return;
      const g = await estimateGasLimit();
      if (!gasAuto) return;
      setGasLimit((g || defaultGasLimit()).toString());
      $("gasAutoLbl").textContent = g ? "(auto: estimated)" : "(auto: default — call not estimatable yet)";
    }, 400);
  }
  $("gasAutoBtn").onclick = () => {
    gasAuto = !gasAuto;
    $("gasAutoBtn").classList.toggle("on", gasAuto);
    $("gaslimit").readOnly = gasAuto;
    if (gasAuto) { $("gasAutoLbl").textContent = "(auto)"; maybeAutoGas(); }
    else { $("gasAutoLbl").textContent = "(manual)"; $("gaslimit").focus(); }
  };

  // ---------- execute ----------
  const METHOD_HINTS = {
    spray: "Each wallet signs its own mint tx (Txs/wallet each), all raced across your RPC pool. Works even when the contract requires tx.origin == msg.sender. Beat per-wallet caps by loading more wallets.",
    seq: "Same per-wallet txs, but submitted straight to the chain's sequencer endpoint — bypasses public RPC rate-limits and is the lowest-latency path on this FCFS chain. Reads (nonce/gas) still use your RPC pool.",
    bulk: "Deploys a throwaway contract that relays your mint call N times in ONE transaction (Txs/wallet = mints per tx). Bypasses per-TX limits for one gas payment. ⚠ Set the mint's recipient arg to YOUR address, and it REVERTS if the contract requires tx.origin == msg.sender.",
  };
  function applyMethodUI() {
    const m = $("method").value;
    $("methodHint").textContent = METHOD_HINTS[m] || "";
    $("countLbl").textContent = m === "bulk" ? "Mints per tx" : "Txs / wallet";
    updateTotal();
    maybeAutoGas();
  }
  $("method").onchange = applyMethodUI;

  // sequencer submission endpoint (submission-only JSON-RPC)
  let seqEps = null;
  function getSequencerEps() {
    const url = (CHAINS[currentPreset] || {}).sequencer;
    if (!url) return null;
    if (!seqEps || seqEps[0].url !== url) seqEps = [{ url, provider: makeProvider(url), coolUntil: 0, ok: null }];
    return seqEps;
  }

  $("loopMode").onchange = () => {
    const rep = $("loopMode").value === "repeat";
    $("untilBox").style.display = rep ? "" : "none";
    $("intervalBox").style.display = rep ? "" : "none";
  };
  $("trigger").onchange = () => {
    const t = $("trigger").value;
    $("triggerValBox").style.display = t === "now" ? "none" : "";
    $("triggerValLbl").textContent = t === "block" ? "Block number" : "Unix time (s)";
  };
  $("value").addEventListener("input", () => { updateTotal(); maybeAutoGas(); });
  $("calldata").addEventListener("input", () => maybeAutoGas());
  $("stop").onclick = () => { stopFlag = true; log("Stop requested.", "warn"); };

  async function waitTrigger() {
    const mode = $("trigger").value; if (mode === "now") return;
    const target = Number($("triggerVal").value.trim()); if (!target) { log("Trigger empty → firing now.", "warn"); return; }
    if (mode === "block") {
      log("Waiting for block ≥ " + target + " …", "warn");
      while (!stopFlag) { const bn = await rpc((p) => p.getBlockNumber()); if (bn >= target) { log("Reached block " + bn, "ok"); return; } await sleep(100); }
    } else {
      log("Waiting for unix time ≥ " + target + " …", "warn");
      while (!stopFlag) { if (Math.floor(Date.now() / 1000) >= target) { log("Reached target time", "ok"); return; } await sleep(200); }
    }
  }

  // Pre-open TLS/keepalive connections so fire-time broadcasts skip the handshake.
  async function warmPool() {
    const eps = activeProviders();
    if (!eps.length) return;
    log("Warming " + eps.length + " connection(s)…", "");
    await Promise.allSettled(eps.map((ep) => ep.provider.getBlockNumber().catch(() => {})));
  }

  // Race the signed tx to EVERY healthy endpoint at once — fastest path to the single FCFS
  // sequencer wins, and it dedupes by tx hash so duplicates are harmless. Resolves
  // { ok, hash, spent }: ok = accepted or our tx already mined; spent = nonce consumed by another tx.
  function broadcastRace(raw, label, targets) {
    const eps = (targets && targets.length) ? targets : (activeProviders().length ? activeProviders() : pool);
    if (!eps.length) { log("FAIL " + label + ": no submission endpoints", "bad"); return Promise.resolve({ ok: false, hash: null }); }
    let hash = null;
    try { hash = E.Transaction.from(raw).hash; } catch (e) {}
    return new Promise((resolve) => {
      let settled = false, fails = 0, spentSeen = false;
      const done = (r) => { if (!settled) { settled = true; clearTimeout(guard); resolve(r); } };
      const guard = setTimeout(() => { log("FAIL " + label + ": broadcast timeout", "bad"); done({ ok: false, hash }); }, 4000);
      const maybeFail = (m) => { if (++fails >= eps.length) { if (!spentSeen) log("FAIL " + label + ": " + m, "bad"); done({ ok: false, hash, spent: spentSeen }); } };
      eps.forEach((ep) => {
        // bare eth_sendRawTransaction returns the hash directly — skips ethers' extra block-number RTT
        ep.provider.send("eth_sendRawTransaction", [raw]).then((h) => {
          log("SENT " + label + " → " + h + " via " + shortHost(ep.url), "ok"); done({ ok: true, hash: h });
        }).catch(async (e) => {
          const m = (e.shortMessage || (e.info && e.info.error && e.info.error.message) || e.message || "");
          if (/already known|already exists|replacement transaction underpriced/i.test(m)) { log("dup " + label + " (already in) via " + shortHost(ep.url), "warn"); done({ ok: true, hash }); return; }
          if (/nonce too low|nonce has already been used|nonce expired/i.test(m)) {
            spentSeen = true;
            try { if (hash) { const rc = await rpc((p) => p.getTransactionReceipt(hash)); if (rc && rc.status === 1) { log("dup " + label + " (our tx already mined)", "warn"); done({ ok: true, hash }); return; } } } catch (_) {}
            log("SPENT " + label + ": nonce already consumed — will resync", "bad"); maybeFail(m); return;
          }
          if (RETRYABLE.test(m.toLowerCase())) ep.coolUntil = Date.now() + 8000;
          maybeFail(m);
        });
      });
    });
  }

  function intField(id, min) {
    const raw = $(id).value.trim();
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < min) throw new Error("'" + id + "' must be a whole number ≥ " + min + " (got '" + raw + "')");
    $(id).value = String(n);
    return n;
  }

  $("fire").onclick = async () => {
    if (running) { log("Already running.", "warn"); return; }
    if (!pool.length) buildPool();
    if (!pool.length) { log("Add RPC endpoints first.", "bad"); return; }
    if (!wallets.length) { log("Load a wallet first.", "bad"); return; }
    if (!contractAddr) { log("Set the contract address.", "bad"); return; }

    const repeat = $("loopMode").value === "repeat";
    let data, value, gasLimit, count, untilN, interval, cid, fees;
    try {
      data = getCalldata();
      value = E.parseEther($("value").value.trim() || "0");
      count = intField("count", 1);
      untilN = repeat ? intField("untilN", 0) : 0;
      interval = repeat ? intField("interval", 0) : 0;
      cid = BigInt($("chainId").value.trim() || "0"); if (cid <= 0n) throw new Error("Set a valid Chain ID.");
      fees = await computeFees(true); // force-fresh fee data for the actual broadcast
      // gas limit: auto-estimate fresh on-chain, else use the manual field
      if (gasAuto) {
        const g = await estimateGasLimit();
        gasLimit = g || defaultGasLimit();
        setGasLimit(gasLimit.toString());
        log("Gas limit " + gasLimit + (g ? " (auto-estimated)" : " (default — call not estimatable yet)"), "");
      } else {
        const gl = $("gaslimit").value.trim(); if (!gl) throw new Error("Set a gas limit, or turn Auto on.");
        gasLimit = BigInt(gl);
      }
    } catch (e) { log("Config error: " + (e.shortMessage || e.message), "bad"); return; }

    // ----- mint method: how the tx is built + submitted -----
    const method = $("method").value;
    const isBulk = method === "bulk";
    const mints = count * wallets.length;                 // NFTs attempted
    const onchainTx = isBulk ? wallets.length : mints;    // actual on-chain txs
    const perTxValue = isBulk ? value * BigInt(count) : value;
    const perTxGas = gasLimit; // per on-chain tx (auto-estimate/default already account for bulk's N mints)
    let submitEps = method === "seq" ? getSequencerEps() : null;
    if (method === "seq" && !submitEps) { log("No sequencer endpoint for this chain — using RPC pool.", "warn"); }

    // Guard: confirm the configured chainId matches what the RPC actually reports
    // (staticNetwork would otherwise let a wrong Chain ID sign an unbroadcastable tx).
    let realCid = null;
    for (const ep of (activeProviders().length ? activeProviders() : pool)) {
      try { realCid = BigInt(await ep.provider.send("eth_chainId", [])); break; } catch (e) {}
    }
    if (realCid == null) { log("Can't reach any RPC to confirm the chain — test the pool first.", "bad"); return; }
    if (realCid !== cid) { log("Chain ID mismatch: field=" + cid + " but RPC reports " + realCid + ". Fix Chain ID before firing.", "bad"); return; }

    // pre-flight: simulate the exact mint once so we don't spend gas on a guaranteed revert
    let preflight = "";
    try { await simulateOnce(); preflight = "✅ pre-flight simulate OK.\n"; }
    catch (e) { preflight = "⛔ PRE-FLIGHT SIMULATE REVERTS: " + decodeRevert(e) + "\nThis will fail on-chain and waste gas. Fire anyway?\n"; }

    const totalEth = value * BigInt(mints);
    const ok = window.confirm(
      "FIRE MINT · " + method.toUpperCase() + "\n\n" + preflight + "\n" + mints + " mint(s) via " + onchainTx + " tx" +
      (isBulk ? " (bulk: 1 tx × " + count + " mints × " + wallets.length + " wallet)" : " (" + wallets.length + " wallet × " + count + ")") +
      "\nto " + contractAddr + "\nchainId " + cid + "\nTOTAL VALUE ≈ " + E.formatEther(totalEth) + " ETH\n" +
      (isBulk ? "⚠ BULK: set the mint recipient to YOUR address in the args; reverts if the contract requires tx.origin==msg.sender.\n" : "") +
      (method === "seq" && submitEps ? "Submitting via sequencer endpoint.\n" : "") +
      (repeat ? "REPEAT until " + (untilN || "stopped") + " minted, " + interval + "ms interval\n" : "") +
      "\n" + ($("trigger").value === "now" ? "Broadcasts immediately." : "Armed; fires on trigger.") + "\n\nProceed?");
    if (!ok) { log("Fire cancelled.", "warn"); return; }

    running = true; stopFlag = false; $("fire").disabled = true;
    let broadcastN = 0, confirmedN = 0, revertedN = 0, round = 0;
    const nonceMap = {};   // per-wallet next nonce, tracked client-side (no public mempool to poll)
    const resync = new Set();
    try {
      // pre-sign a round BEFORE the trigger; nonces come from nonceMap, only fetched round 1 or on resync
      async function buildRound() {
        await Promise.all(wallets.map(async (w) => {
          if (nonceMap[w.address] === undefined || resync.has(w.address)) {
            try { nonceMap[w.address] = await rpc((p) => p.getTransactionCount(w.address, "pending")); resync.delete(w.address); }
            catch (e) { log("nonce fetch failed " + shrink(w.address) + ": " + (e.shortMessage || e.message), "bad"); }
          }
        }));
        const batches = [];
        for (const w of wallets) {
          const start = nonceMap[w.address];
          if (start === undefined) continue;
          const signed = [];
          if (isBulk) {
            // ONE deploy tx per wallet: BulkMinter(target, count, calldata) relays the mint `count` times
            const args = E.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes"], [contractAddr, BigInt(count), data]);
            const tx = { chainId: cid, data: MINTER_BYTECODE + args.slice(2), value: perTxValue, gasLimit: perTxGas, nonce: start, type: 2, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
            signed.push({ raw: await w.wallet.signTransaction(tx), label: shrink(w.address) + " bulk×" + count + " n" + start });
          } else {
            for (let i = 0; i < count; i++) {
              const tx = { chainId: cid, to: contractAddr, data, value: perTxValue, gasLimit: perTxGas, nonce: start + i, type: 2, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
              signed.push({ raw: await w.wallet.signTransaction(tx), label: shrink(w.address) + " n" + (start + i) });
            }
          }
          batches.push({ address: w.address, signed });
        }
        return batches;
      }

      log("── Pre-signing round 1 (" + onchainTx + " tx, " + method + ") ──", "ok");
      let batches = await buildRound();
      await warmPool();               // warm connections DURING the wait, not after the trigger
      await waitTrigger();
      if (stopFlag) { log("Aborted before send.", "warn"); return; }

      do {
        round++;
        if (round > 1) { batches = await buildRound(); }
        const via = method === "seq" && submitEps ? "sequencer-direct" : "racing " + activeProviders().length + " RPC";
        log("── Broadcasting round " + round + " (" + via + ") ──", "ok");
        const sends = [];
        for (const b of batches) for (const s of b.signed) { if (stopFlag) break; sends.push(broadcastRace(s.raw, s.label, submitEps).then((r) => ({ addr: b.address, r }))); }
        const res = await Promise.all(sends);
        const roundHashes = [];
        for (const x of res) { if (x.r.ok) { broadcastN++; if (x.r.hash) roundHashes.push(x.r.hash); } if (x.r.spent) resync.add(x.addr); }
        for (const b of batches) nonceMap[b.address] = (nonceMap[b.address] || 0) + b.signed.length; // advance; resync corrects drift

        // Confirm receipts off the send path so the loop stays low-latency, but count truthfully.
        if (roundHashes.length) {
          await Promise.allSettled(roundHashes.map(async (h) => {
            try {
              const rc = await rpc((p) => p.waitForTransaction(h, 1, 6000));
              if (rc) { if (rc.status === 1) { confirmedN++; log("MINTED " + shrink(h) + " blk " + rc.blockNumber, "ok"); } else { revertedN++; log("REVERTED " + shrink(h) + " blk " + rc.blockNumber, "bad"); } }
              else log("pending " + shrink(h) + " (no receipt in 6s)", "warn");
            } catch (e) {}
          }));
        }

        if (!repeat) break;
        if (untilN && confirmedN >= untilN) { log("Reached " + confirmedN + " minted — stopping.", "ok"); break; }
        if (stopFlag) break;
        if (interval) await sleep(interval);
      } while (repeat && !stopFlag);

      log("── Done. " + broadcastN + " broadcast · " + confirmedN + " minted · " + revertedN + " reverted over " + round + " round(s). ──", confirmedN ? "ok" : "warn");
    } catch (e) { log("Fire error: " + (e.shortMessage || e.message), "bad"); }
    finally { running = false; $("fire").disabled = false; }
  };

  // one eth_call of the exact mint the current settings would fire; throws on revert
  async function simulateOnce() {
    const data = getCalldata();
    const value = E.parseEther($("value").value.trim() || "0");
    if ($("method").value === "bulk") {
      const count = Math.max(1, parseInt($("count").value.trim() || "1", 10));
      const args = E.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes"], [contractAddr, BigInt(count), data]);
      await rpc((p) => p.call({ from: wallets[0].address, data: MINTER_BYTECODE + args.slice(2), value: value * BigInt(count) }));
    } else {
      await rpc((p) => p.call({ from: wallets[0].address, to: contractAddr, data, value }));
    }
  }
  $("simulate").onclick = async () => {
    if (!pool.length) buildPool();
    if (!wallets.length) { log("Load a wallet first.", "bad"); return; }
    if (!contractAddr) { log("Set the contract address.", "bad"); return; }
    try { await simulateOnce(); log("Simulate OK — this mint would not revert.", "ok"); }
    catch (e) { log("Simulate reverted: " + decodeRevert(e), "bad"); }
  };

  // ---------- live SeaDrop drops feed ----------
  const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
  const OS_FEE = "0x0000a26b00c1F0DF003000390027140000fAa719"; // OpenSea's default allowed fee recipient
  const ZERO = "0x0000000000000000000000000000000000000000";
  const SD_EVENTS = new E.Interface([
    "event PublicDropUpdated(address indexed nftContract, tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients) publicDrop)",
    "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
  ]);
  const SD_READ = new E.Interface([
    "function getPublicDrop(address) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))",
    "function getAllowedFeeRecipients(address) view returns (address[])",
  ]);
  const NFT_MINI = ["function name() view returns (string)", "function totalSupply() view returns (uint256)", "function maxSupply() view returns (uint256)"];
  const EXPLORER_BASE = "https://robinhoodchain.blockscout.com";
  const fmtPrice = (wei) => wei === 0n ? "FREE" : E.formatEther(wei) + " ETH";
  let feedItems = [], feedTimer = null, feedUnitPrice = 0n;

  async function throttle(arr, n, fn) {
    const out = []; let i = 0;
    const worker = async () => { while (i < arr.length) { const k = i++; out[k] = await fn(arr[k]); } };
    await Promise.all(Array.from({ length: Math.min(n, arr.length || 1) }, worker));
    return out;
  }

  async function enrichCollection(nft) {
    try {
      const [name, pd] = await Promise.all([
        rpc((p) => new E.Contract(nft, NFT_MINI, p).name()).catch(() => "?"),
        rpc((p) => new E.Contract(SEADROP, SD_READ, p).getPublicDrop(nft)),
      ]);
      let minted = null, max = null;
      try { minted = await rpc((p) => new E.Contract(nft, NFT_MINI, p).totalSupply()); } catch (e) {}
      try { max = await rpc((p) => new E.Contract(nft, NFT_MINI, p).maxSupply()); } catch (e) {}
      const now = Math.floor(Date.now() / 1000);
      const start = Number(pd[1]), end = Number(pd[2]);
      let status = "closed";
      if (max != null && minted != null && max > 0n && minted >= max) status = "sold";
      else if (now < start) status = "soon";
      else if (now >= start && now <= end) status = "live";
      return { nft, name, price: pd[0], start, end, maxWallet: Number(pd[3]), restrictFee: pd[5], minted, max, status };
    } catch (e) { return null; }
  }

  async function loadFeed() {
    if (!pool.length) buildPool();
    $("feedRefresh").disabled = true;
    $("feedStatus").textContent = "Scanning SeaDrop activity on-chain…";
    try {
      const seen = new Set(), order = [];
      // recent activity (mints + config updates) — captures what's minting now
      let next = null;
      for (let page = 0; page < 2; page++) {
        const qs = next ? "?" + new URLSearchParams(next).toString() : "";
        const j = await (await fetch(EXPLORER_BASE + "/api/v2/addresses/" + SEADROP + "/logs" + qs)).json();
        for (const it of (j.items || [])) {
          try { const pl = SD_EVENTS.parseLog({ topics: (it.topics || []).filter(Boolean), data: it.data }); const nft = pl.args.nftContract; if (!seen.has(nft)) { seen.add(nft); order.push(nft); } } catch (e) {}
        }
        next = j.next_page_params; if (!next) break;
      }
      // newest configured drops (may have no mints yet)
      try {
        const t0 = SD_EVENTS.getEvent("PublicDropUpdated").topicHash;
        const j2 = await (await fetch(EXPLORER_BASE + "/api?module=logs&action=getLogs&address=" + SEADROP + "&topic0=" + t0 + "&fromBlock=0&toBlock=latest")).json();
        for (const lg of (j2.result || []).reverse()) { const nft = E.getAddress("0x" + lg.topics[1].slice(26)); if (!seen.has(nft)) { seen.add(nft); order.push(nft); } if (order.length > 40) break; }
      } catch (e) {}

      const top = order.slice(0, 18);
      $("feedStatus").textContent = "Reading " + top.length + " collections…";
      const rank = { live: 0, soon: 1, closed: 2, sold: 3 };
      feedItems = (await throttle(top, 4, enrichCollection)).filter(Boolean).sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4));
      renderFeed(feedItems);
      const liveN = feedItems.filter((i) => i.status === "live").length;
      $("feedStatus").innerHTML = feedItems.length + " collections · <span class='ok'>" + liveN + " live now</span> · click one to load it into the bot.";
    } catch (e) { $("feedStatus").innerHTML = "<span class='bad'>Feed failed: " + esc(e.shortMessage || e.message) + "</span>"; }
    finally { $("feedRefresh").disabled = false; }
  }

  function renderFeed(items) {
    if (!items.length) { $("feedList").innerHTML = '<div class="hint">No SeaDrop drops found.</div>'; return; }
    const badges = { live: '<span class="badge live">LIVE</span>', soon: '<span class="badge soon">SOON</span>', sold: '<span class="badge sold">SOLD OUT</span>', closed: '<span class="badge closed">closed</span>' };
    $("feedList").innerHTML = items.map((it, i) => {
      const supply = (it.minted != null && it.max != null && it.max > 0n) ? it.minted + "/" + it.max : (it.minted != null ? it.minted + " minted" : "—");
      return '<div class="drop" data-i="' + i + '">' + (badges[it.status] || "") +
        '<div class="dn">' + esc(it.name || "?") + "</div>" +
        '<div class="dm"><b>' + fmtPrice(it.price) + "</b> · " + supply + " · max " + it.maxWallet + "/wallet</div>" +
        '<div class="dm">' + shrink(it.nft) + "</div></div>";
    }).join("");
  }
  $("feedList").addEventListener("click", (e) => { const d = e.target.closest(".drop"); if (d) loadCollectionIntoBot(feedItems[+d.dataset.i]); });

  async function loadCollectionIntoBot(item) {
    if (!item) return;
    log("Loading " + (item.name || shrink(item.nft)) + " …", "");
    let fee = OS_FEE;
    try { if (item.restrictFee) { const fr = await rpc((p) => new E.Contract(SEADROP, SD_READ, p).getAllowedFeeRecipients(item.nft)); if (fr && fr.length) fee = fr[0]; } } catch (e) {}
    $("contract").value = SEADROP;
    await fetchFunctions(); // loads SeaDrop ABI + chips (also sets contractIface for error decoding)
    const idx = abiFragments.findIndex((f) => f.name === "mintPublic" && f.inputs.length === 4);
    if (idx < 0) { log("mintPublic not found on the SeaDrop ABI — use raw calldata.", "bad"); return; }
    for (const c of $("fnList").children) c.classList.toggle("on", +c.dataset.i === idx);
    selectFn(idx);
    $("p0").value = item.nft; $("p1").value = fee; $("p2").value = ZERO; $("p3").value = "1";
    encodeSelected();
    feedUnitPrice = item.price;
    $("value").value = E.formatEther(item.price); // exact per-1 price; SeaDrop requires exact payment
    $("value").dispatchEvent(new Event("input"));
    // keep value = price × quantity as the user edits quantity
    $("p3").addEventListener("input", () => { try { const q = BigInt($("p3").value.trim() || "0"); $("value").value = E.formatEther(feedUnitPrice * q); $("value").dispatchEvent(new Event("input")); } catch (e) {} });
    const live = item.status === "live";
    log("Loaded " + (item.name || "collection") + " — mintPublic ready · " + fmtPrice(item.price) + " each · max " + item.maxWallet + "/wallet. " + (live ? "🟢 LIVE — set quantity and Fire." : "⚠ not live right now (" + item.status + ")."), live ? "ok" : "warn");
    document.getElementById("fire").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  $("feedRefresh").onclick = loadFeed;
  $("feedAuto").onchange = () => { clearInterval(feedTimer); if ($("feedAuto").checked) { loadFeed(); feedTimer = setInterval(loadFeed, 30000); } };

  // ---------- init ----------
  $("preset").value = "rh-main";
  applyPreset("rh-main");
  applyMethodUI();
  renderGasChart(E.parseUnits("0.047", "gwei"), 0n, null); // draw bars immediately (no network call)
  log("Ready. Client-side only — nothing is stored. Test RPCs, load a burner key, fetch functions, fire.", "ok");
})();
