// Acting as the site's own GitHub App, for the weekly update (src/worker/update.js): the app's
// private key (kept in KV when the app was created, see auth.js) signs a short JSON Web Token,
// which GitHub swaps for a token that may change this site's repository for an hour.
//
// GitHub hands the key over as PKCS#1 ("BEGIN RSA PRIVATE KEY"); Web Crypto only imports PKCS#8,
// so the key is wrapped first. Everything here works in Workers and in Node 22.

const UA = "alt-pages-site-update";
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// DER length: short form below 128, long form above.
function derLength(n) {
  if (n < 0x80) return [n];
  const out = [];
  for (let x = n; x > 0; x >>= 8) out.unshift(x & 0xff);
  return [0x80 | out.length, ...out];
}
const der = (tag, body) => Uint8Array.from([tag, ...derLength(body.length), ...body]);

// PKCS#1 RSAPrivateKey → PKCS#8 PrivateKeyInfo { version 0, rsaEncryption, OCTET STRING pkcs1 }.
export function pkcs1ToPkcs8(pkcs1) {
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return der(0x30, [...version, ...algorithm, ...der(0x04, [...pkcs1])]);
}

// The key's bytes from PEM text, as PKCS#8 whichever form it came in.
export function pemToPkcs8(pem) {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(String(pem || ""));
  if (!m) throw new Error("No private key");
  const bytes = fromB64(m[2].replace(/\s+/g, ""));
  return m[1] ? pkcs1ToPkcs8(bytes) : bytes;
}

// A JSON Web Token for the app, valid for nine minutes (GitHub allows ten), a minute back-dated
// for clock drift.
export async function appJwt(appId, pem, now = Date.now()) {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const t = Math.floor(now / 1000);
  const head = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: t - 60, exp: t + 540, iss: String(appId) })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head));
  return `${head}.${b64url(sig)}`;
}

// A token for `repo` ("owner/name"), from the app installed on it.
export async function installationToken({ appId, pem, repo, fetch: f = fetch, now }) {
  const jwt = await appJwt(appId, pem, now);
  const call = async (method, path) => {
    const res = await f(`https://api.github.com${path}`, { method, headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": UA } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}${body.message ? `: ${body.message}` : ""}`);
    return body;
  };
  const inst = await call("GET", `/repos/${repo}/installation`);
  const tok = await call("POST", `/app/installations/${inst.id}/access_tokens`);
  return tok.token;
}
