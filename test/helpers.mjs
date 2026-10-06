import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tmp = () => mkdtempSync(join(tmpdir(), "cc-test-"));
// Secret-shaped fixtures are assembled at runtime from split literals so no real-looking token sits in the source.
export const FAKE = {
  aws: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  github: "gh" + "p_" + "a1B2c3D4e5".repeat(4),
  slack: "xo" + "xb-" + "1234567890-abcdefghij",
  sk: "s" + "k-" + "a1B2c3D4e5".repeat(3),
  google: "AI" + "za" + "SyA1B2c3D4e5F6g7H8i9J0k1L2m3N4o5",
  jwt: "ey" + "J" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "abcDEF123456_-abcDEF",
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----",
  bearer: "Bear" + "er " + "a1B2c3D4e5".repeat(3),
};
