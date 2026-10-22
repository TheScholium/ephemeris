import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
// @ts-ignore no types
import ece from "http_ece";
import { encryptPayload, vapidAuth, generateVapidKeys, b64uToBytes, bytesToB64u } from "../src/push";

describe("web push crypto", () => {
  it("payload decrypts with the reference implementation (RFC 8291)", async () => {
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const msg = JSON.stringify({ title: "Read Lee ch. 3", body: "Planned now · 1h 30m" });
    const body = await encryptPayload(new TextEncoder().encode(msg), bytesToB64u(ua.getPublicKey()), bytesToB64u(auth));
    const plain = ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ua, authSecret: auth });
    expect(plain.toString("utf8")).toBe(msg);
  });

  it("VAPID JWT verifies with the public key", async () => {
    const k = await generateVapidKeys();
    const h = await vapidAuth("https://web.push.apple.com/abc", "mailto:test@example.org", k.publicKey, k.privateKey);
    const m = h.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(m[2]).toBe(k.publicKey);
    const [head, claims, sig] = m[1].split(".");
    const c = JSON.parse(Buffer.from(b64uToBytes(claims)).toString());
    expect(c.aud).toBe("https://web.push.apple.com");
    const pub = await crypto.webcrypto.subtle.importKey("raw", b64uToBytes(k.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64uToBytes(sig), new TextEncoder().encode(`${head}.${claims}`));
    expect(ok).toBe(true);
  });
});
