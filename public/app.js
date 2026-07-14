"use strict";
(function () {
  const E = window.ethers;
  const $ = (id) => document.getElementById(id);

  // ---------- chain presets ----------
  const CHAINS = {
    "rh-main": {
      name: "Robinhood Mainnet", chainId: 4663, coingecko: "ethereum",
      explorerApi: "https://robinhoodchain.blockscout.com/api",
      rpcs: [
        "https://rpc.mainnet.chain.robinhood.com",
        "# Public RPC above is rate-limited. For continuous minting add your own key(s):",
        "# https://robinhood-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY",
        "# https://your-endpoint.robinhood-mainnet.quiknode.pro/YOUR_TOKEN/",
      ],
    },
    "rh-test": {
      name: "Robinhood Testnet", chainId: 46630, coingecko: "ethereum",
      explorerApi: "https://explorer.testnet.chain.robinhood.com/api",
      rpcs: ["https://rpc.testnet.chain.robinhood.com"],
    },
    "custom": { name: "Custom", chainId: 1, coingecko: "ethereum", explorerApi: "", rpcs: [""] },
  };

  // ---------- state (memory only) ----------
  let currentPreset = "rh-main";
  let chainId = 4663n;
  let wallets = [];          // [{wallet, address}]
  let pool = [];             // [{url, provider, coolUntil, ok, latency, chainId}]
  let rr = 0;
  let contractAddr = null;
  let abiFragments = [];     // available FunctionFragment list
  let selectedFrag = null;
  let encodedCalldata = null;
  let gasMode = "market";
  let ethUsd = null, ethUsdAt = 0;
  let feeGp = null, feeGpAt = 0;
  let running = false, stopFlag = false;

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

  // ---------- preset ----------
  function applyPreset(key) {
    currentPreset = key;
    const c = CHAINS[key];
    if (key !== "custom") {
      $("chainId").value = c.chainId;
      $("explorerApi").value = c.explorerApi;
      $("rpcs").value = c.rpcs.join("\n");
    }
    chainId = BigInt($("chainId").value.trim() || "1");
  }
  $("preset").onchange = () => applyPreset($("preset").value);
  $("chainId").onchange = () => { chainId = BigInt($("chainId").value.trim() || "1"); };

  // ---------- RPC pool ----------
  function makeProvider(url) {
    const net = E.Network.from(BigInt($("chainId").value.trim() || "1"));
    if (url.startsWith("ws")) return new E.WebSocketProvider(url, net);
    return new E.JsonRpcProvider(url, net, { staticNetwork: net, batchMaxCount: 1 });
  }
  function parseRpcList() {
    return $("rpcs").value.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
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

  $("fetchFns").onclick = async () => {
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
      if (res.abi) {
        const iface = new E.Interface(res.abi);
        iface.forEachFunction((f) => { if (f.stateMutability !== "view" && f.stateMutability !== "pure") frags.push(f); });
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
    } catch (e) {
      $("abiStatus").innerHTML = '<span class="bad">ABI fetch failed: ' + esc(e.shortMessage || e.message) + "</span>";
    }
  };

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
    } catch (e) { log("Import failed: " + (e.shortMessage || e.message), "bad"); }
  };

  // ---------- gas ----------
  $("gasSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    gasMode = b.dataset.g;
    for (const btn of $("gasSeg").children) btn.classList.toggle("on", btn === b);
    const custom = gasMode === "custom";
    $("maxfee").readOnly = !custom; $("prio").readOnly = !custom;
    refreshGas();
  });
  $("refreshGas").onclick = () => refreshGas(true);

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
    updateTotal(px);
  }
  $("gaslimit").addEventListener("input", refreshGas);
  $("count").addEventListener("input", () => updateTotal());

  async function updateTotal(px) {
    const gl = $("gaslimit").value.trim() ? BigInt($("gaslimit").value.trim()) : 0n;
    const count = Math.max(1, parseInt($("count").value.trim() || "1", 10));
    const w = Math.max(1, wallets.length);
    const per = count * w;
    let costStr = "";
    if (gl > 0n) {
      try {
        const fees = await computeFees();
        px = px || await getEthUsd();
        const roundEth = Number(E.formatEther(gl * (fees.gasPrice || fees.maxFeePerGas))) * per;
        const valEth = parseFloat($("value").value.trim() || "0") * per;
        const totEth = roundEth + valEth;
        costStr = " · per round: <b>" + per + " tx</b> · gas ~" + roundEth.toFixed(8) + " ETH" + (valEth ? " + mint value " + valEth + " ETH" : "") +
          (px ? ' = <span class="usd">$' + (totEth * px).toFixed(2) + "</span>" : "");
      } catch (e) {}
    }
    $("totalStatus").innerHTML = wallets.length + " wallet(s) × " + count + " tx" + costStr;
  }

  $("estGas").onclick = async () => {
    if (!wallets.length) { log("Load a wallet first (used as the from address).", "bad"); return; }
    if (!contractAddr) { log("Set the contract address first.", "bad"); return; }
    try {
      const g = await rpc((p) => p.estimateGas({ from: wallets[0].address, to: contractAddr, data: getCalldata(), value: E.parseEther($("value").value.trim() || "0") }));
      const buffered = (g * 130n) / 100n;
      $("gaslimit").value = buffered.toString();
      log("estimateGas " + g + " → set " + buffered + " (+30%)", "ok"); refreshGas();
    } catch (e) {
      log("Estimate failed (mint may not be live / would revert): " + (e.shortMessage || e.message), "warn");
      log("Set a gas limit manually (e.g. 200000–300000) and skip estimation.", "warn");
    }
  };

  // ---------- execute ----------
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
  $("value").addEventListener("input", () => updateTotal());
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
  function broadcastRace(raw, label) {
    const eps = activeProviders().length ? activeProviders() : pool;
    if (!eps.length) { log("FAIL " + label + ": no RPC endpoints", "bad"); return Promise.resolve({ ok: false, hash: null }); }
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
      const gl = $("gaslimit").value.trim(); if (!gl) throw new Error("Set a gas limit.");
      gasLimit = BigInt(gl);
      count = intField("count", 1);
      untilN = repeat ? intField("untilN", 0) : 0;
      interval = repeat ? intField("interval", 0) : 0;
      cid = BigInt($("chainId").value.trim() || "0"); if (cid <= 0n) throw new Error("Set a valid Chain ID.");
      fees = await computeFees(true); // force-fresh fee data for the actual broadcast
    } catch (e) { log("Config error: " + (e.shortMessage || e.message), "bad"); return; }

    // Guard: confirm the configured chainId matches what the RPC actually reports
    // (staticNetwork would otherwise let a wrong Chain ID sign an unbroadcastable tx).
    let realCid = null;
    for (const ep of (activeProviders().length ? activeProviders() : pool)) {
      try { realCid = BigInt(await ep.provider.send("eth_chainId", [])); break; } catch (e) {}
    }
    if (realCid == null) { log("Can't reach any RPC to confirm the chain — test the pool first.", "bad"); return; }
    if (realCid !== cid) { log("Chain ID mismatch: field=" + cid + " but RPC reports " + realCid + ". Fix Chain ID before firing.", "bad"); return; }

    const txCount = count * wallets.length;
    const totalEth = value * BigInt(txCount);
    const ok = window.confirm(
      "FIRE MINT\n\n" + txCount + " tx (" + wallets.length + " wallet × " + count + ")\nto " + contractAddr +
      "\nchainId " + cid + "\nvalue " + E.formatEther(value) + " ETH each\nTOTAL VALUE ≈ " + E.formatEther(totalEth) + " ETH\n" +
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
          for (let i = 0; i < count; i++) {
            const tx = { chainId: cid, to: contractAddr, data, value, gasLimit, nonce: start + i, type: 2, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
            signed.push({ raw: await w.wallet.signTransaction(tx), label: shrink(w.address) + " n" + (start + i) });
          }
          batches.push({ address: w.address, signed });
        }
        return batches;
      }

      log("── Pre-signing round 1 (" + txCount + " tx) ──", "ok");
      let batches = await buildRound();
      await warmPool();               // warm connections DURING the wait, not after the trigger
      await waitTrigger();
      if (stopFlag) { log("Aborted before send.", "warn"); return; }

      do {
        round++;
        if (round > 1) { batches = await buildRound(); }
        log("── Broadcasting round " + round + " (racing " + activeProviders().length + " RPC) ──", "ok");
        const sends = [];
        for (const b of batches) for (const s of b.signed) { if (stopFlag) break; sends.push(broadcastRace(s.raw, s.label).then((r) => ({ addr: b.address, r }))); }
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

  $("simulate").onclick = async () => {
    if (!pool.length) buildPool();
    if (!wallets.length) { log("Load a wallet first.", "bad"); return; }
    if (!contractAddr) { log("Set the contract address.", "bad"); return; }
    try {
      const res = await rpc((p) => p.call({ from: wallets[0].address, to: contractAddr, data: getCalldata(), value: E.parseEther($("value").value.trim() || "0") }));
      log("Simulate OK (no revert). return " + (res === "0x" ? "(empty)" : res.slice(0, 42) + "…"), "ok");
    } catch (e) { log("Simulate reverted: " + (e.shortMessage || e.reason || e.message), "bad"); }
  };

  // ---------- init ----------
  applyPreset("rh-main");
  $("preset").value = "rh-main";
  log("Ready. Client-side only — nothing is stored. Test the RPC pool, load a burner key, fetch functions, fire.", "ok");
})();
