// Constant-time secret compare (Aikido SAST timing-attack / password compare).
// Run: bun scripts/test-timing-safe.ts
//  or: node --experimental-strip-types scripts/test-timing-safe.ts

import { timingSafeEqualString, webhookSecretIsValid } from "../src/lib/security.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures += 1;
}

function main() {
  check("equal secrets match", timingSafeEqualString("uipath-webhook-secret", "uipath-webhook-secret"));
  check("different secrets reject", !timingSafeEqualString("uipath-webhook-secret", "uipath-webhook-secreX"));
  check("length mismatch rejects", !timingSafeEqualString("short", "much-longer-token"));
  check("empty vs secret rejects", !timingSafeEqualString("", "secret"));
  check("unicode secrets match", timingSafeEqualString("sëcret-🔑", "sëcret-🔑"));
  check("unicode secrets reject", !timingSafeEqualString("sëcret-🔑", "secret-🔑"));

  check("unset webhook secret remains open", webhookSecretIsValid(null, undefined));
  check("unset webhook secret remains open with header", webhookSecretIsValid("anything", ""));
  check("missing header rejects when secret set", !webhookSecretIsValid(null, "desk-secret"));
  check("matching header accepts", webhookSecretIsValid("desk-secret", "desk-secret"));
  check("wrong header rejects", !webhookSecretIsValid("desk-secreX", "desk-secret"));

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall timing-safe checks passed");
}

main();
