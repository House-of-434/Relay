import assert from "node:assert/strict";
import { test } from "node:test";

import { assertCredentialSafe, parseFormFields } from "./credential-guard.js";

const FORMS = `extract forms:
[{"action":"https://example.com/login","method":"post","fields":[
  {"tag":"input","type":"email","name":"email","label":"Email"},
  {"tag":"input","type":"password","name":"password","label":"Password"},
  {"tag":"input","type":"text","name":"otp","label":"One-time code"}
]}]`;

test("parses Bladebro form fields", () => {
  const fields = parseFormFields(FORMS);
  assert.equal(fields?.length, 3);
  assert.equal(fields?.[1]?.type, "password");
});

test("refuses a password target and a one-time-code target", () => {
  assert.throws(() => assertCredentialSafe({ action: "type", target: "password", text: "x" }, FORMS), /browser_request_human/);
  assert.throws(() => assertCredentialSafe({ action: "type", target: "otp", text: "123456" }, FORMS), /browser_request_human/);
});

test("allows typing into an ordinary field", () => {
  assert.doesNotThrow(() => assertCredentialSafe({ action: "type", target: "email", text: "a@b.com" }, FORMS));
});

test("refuses a fill that touches the credential form", () => {
  assert.throws(
    () => assertCredentialSafe({ action: "fill", fields: { email: "a@b.com" } }, FORMS),
    /browser_request_human/,
  );
});

test("fill fails closed when the form cannot be inspected", () => {
  assert.throws(
    () => assertCredentialSafe({ action: "fill", fields: { search: "shoes" } }, null),
    /browser_request_human/,
  );
});

test("refuses a fill field that the inspected form does not contain", () => {
  const plain = `extract forms:\n[{"fields":[{"tag":"input","type":"text","name":"search","label":"Search"}]}]`;
  assert.throws(
    () => assertCredentialSafe({ action: "fill", fields: { cardnumber: "4242" } }, plain),
    /browser_request_human/,
  );
  assert.doesNotThrow(() => assertCredentialSafe({ action: "fill", fields: { search: "shoes" } }, plain));
});
