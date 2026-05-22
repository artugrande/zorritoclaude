// zorritov2/api/self-verify.js
// Self.xyz ZK passport proof endpoint.
// Self's TEE calls this after the user completes passport verification.
// MUST return { status, result } — any other shape causes a serde decode error in Self's Rust TEE.

const { SelfBackendVerifier, AllIds, DefaultConfigStore } = require("@selfxyz/core");
const { kv }     = require("@vercel/kv");
const { ethers } = require("ethers");

const SCOPE    = "zorrito-v2";
const ENDPOINT = "https://www.zorrito.app/api/self-verify";
const RPC      = "https://forno.celo.org";
const ABI      = ["function setSelfVerified(address user) external"];

const configStore = new DefaultConfigStore({
  excludedCountries: [],
  ofac: false,
});

// Singleton verifier — matches the working zorrito.app pattern exactly
let _verifier = null;
function getVerifier() {
  if (!_verifier) {
    _verifier = new SelfBackendVerifier(
      SCOPE,
      ENDPOINT,
      false,      // mainnet (not devMode)
      AllIds,     // accept all passport types
      configStore,
      "uuid",     // userIdType
    );
  }
  return _verifier;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // GET — health check, Self relay validates the endpoint before sending proofs
  if (req.method === "GET") {
    return res.status(200).json({ status: "ready", scope: SCOPE });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CRITICAL: Self's Rust TEE deserializes the response strictly as { status, result }
  try {
    // Self sends publicSignals (not pubSignals)
    const { attestationId, proof, publicSignals, userContextData, userDefinedData } = req.body || {};

    // Handshake POST — Self checks endpoint is alive before sending proof
    if (!proof && !publicSignals) {
      return res.status(200).json({ status: "ready" });
    }

    // ── Verify ZK proof ───────────────────────────────────────────────────────
    let verifyResult;
    try {
      verifyResult = await getVerifier().verify(
        attestationId,
        proof,
        publicSignals,
        userContextData || ""
      );
    } catch (verifyErr) {
      console.error("[self-verify] proof invalid:", verifyErr.message);
      return res.status(200).json({ status: "error", result: false });
    }

    // Check isValidDetails.isValid — matches the working zorrito.app pattern
    const isValid = verifyResult?.isValidDetails?.isValid === true;

    if (!isValid) {
      console.warn("[self-verify] isValid=false, details:", verifyResult?.isValidDetails);
      return res.status(200).json({ status: "error", result: false });
    }

    // ── Extract wallet address from userDefinedData ───────────────────────────
    // Self encodes userDefinedData as a hex string inside userContextData.
    // verifyResult.userData.userDefinedData is the hex slice after decoding.
    // We try three sources in order of reliability:
    //  1. verifyResult.userData.userDefinedData decoded from hex → UTF-8
    //  2. verifyResult.userData.userDefinedData as-is (if it's already the address)
    //  3. raw userDefinedData field from req.body (fallback)
    let walletAddr = null;

    const extractWallet = (raw) => {
      if (!raw) return null;
      // Try hex-decode to utf8 (Self encodes the wallet address string as hex bytes)
      try {
        const decoded = Buffer.from(raw.replace(/^0x/, ""), "hex")
          .toString("utf8")
          .replace(/\0/g, "")
          .trim();
        if (decoded && ethers.isAddress(decoded)) return decoded.toLowerCase();
      } catch {}
      // Try as raw string
      if (ethers.isAddress(raw)) return raw.toLowerCase();
      return null;
    };

    walletAddr = extractWallet(verifyResult?.userData?.userDefinedData)
      || extractWallet(userDefinedData);

    console.log("[self-verify] userData:", JSON.stringify(verifyResult?.userData));
    console.log("[self-verify] body.userDefinedData:", userDefinedData);
    console.log("[self-verify] resolved walletAddr:", walletAddr);

    if (walletAddr) {
      // Store in KV immediately — frontend polling checks this for fast UX
      await kv.set(
        `self:addr:${walletAddr}`,
        { verified: true, ts: Date.now() },
        { ex: 86400 * 30 }
      );
      console.log(`[self-verify] ✅ KV stored for ${walletAddr}`);

      // Call contract.setSelfVerified(walletAddr) via keeper
      const keeperKey    = (process.env.KEEPER_PRIVATE_KEY || "").trim();
      const contractAddr = (process.env.V2_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS || "").trim();

      if (keeperKey && contractAddr) {
        try {
          const provider = new ethers.JsonRpcProvider(RPC);
          const signer   = new ethers.Wallet(keeperKey, provider);
          const contract = new ethers.Contract(contractAddr, ABI, signer);
          const tx = await contract.setSelfVerified(walletAddr, {
            type: 0,
            gasLimit: 250_000,
          });
          await tx.wait();
          console.log("[self-verify] on-chain verified:", walletAddr, "tx:", tx.hash);
        } catch (chainErr) {
          if (!chainErr.message?.includes("Already verified")) {
            console.warn("[self-verify] on-chain error:", chainErr.message);
          }
        }
      }
    }

    // Self's TEE requires exactly this shape
    return res.status(200).json({ status: "success", result: true });

  } catch (err) {
    console.error("[self-verify] unhandled:", err);
    return res.status(200).json({ status: "error", result: false });
  }
};
