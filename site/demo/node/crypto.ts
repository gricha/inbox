// Ids and content hashes for an in-memory demo: random from the browser, hashes FNV-1a (not for security, only stable).
type Bytes = Uint8Array & { toString(enc?: string): string };

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (b: Uint8Array): Bytes =>
  Object.assign(b, {
    toString: (enc?: string) => (enc === "base64url" ? btoa(String.fromCodePoint(...b)).replaceAll(/[+/=]/g, "") : hex(b)),
  });

export const randomBytes = (n: number): Bytes => bytes(crypto.getRandomValues(new Uint8Array(n)));
export const randomUUID = (): string => crypto.randomUUID();

export const createHash = (_algo: string) => {
  let s = "";
  const h = {
    update(d: string | Uint8Array) {
      s += typeof d === "string" ? d : new TextDecoder().decode(d);
      return h;
    },
    digest(enc?: string) {
      const out = new Uint8Array(32);
      for (let round = 0; round < 4; round++) {
        let x = 0xcbf29ce484222325n ^ BigInt(round);
        for (let i = 0; i < s.length; i++) x = BigInt.asUintN(64, (x ^ BigInt(s.codePointAt(i) ?? 0)) * 0x100000001b3n);
        for (let j = 0; j < 8; j++) out[round * 8 + j] = Number((x >> BigInt(j * 8)) & 0xffn);
      }
      const b = bytes(out);
      return enc ? b.toString(enc) : b;
    },
  };
  return h;
};
export default { randomBytes, randomUUID, createHash };
