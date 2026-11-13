/** Server-side credential-field guard for browser_act.
 *
 * The agent must never enter passwords, one-time codes, or card data for the
 * person. A prompt rule is not enforcement, so this inspects the page's form
 * fields before a `type` or `fill` and refuses a credential target.
 *
 * Limits, stated so nobody later assumes this is airtight:
 * - Bladebro's `see extract forms` exposes tag/type/name/label, not the
 *   `autocomplete` attribute. Matching therefore uses type, name, and label.
 * - Cross-origin iframes (Stripe-style card fields) are invisible to the
 *   driver by design. `fill` fails closed: it refuses when form introspection
 *   is unavailable or a requested field cannot be found in the inspected form.
 * - The check and the act are separate calls; the page can change between
 *   them. This closes the ordinary path, not a deliberately racing page.
 */
import type { BrowserActInput } from "./bladebro.js";

const CREDENTIAL_PATTERN =
  /(password|passwd|passcode|one[-_ ]?time|otp|verification code|security code|2fa|mfa|totp|card[-_ ]?number|credit[-_ ]?card|debit[-_ ]?card|cc[-_ ]?(num|number|cvc|cvv|exp)|cvc|cvv|expir(y|ation)|social security|ssn|routing number|iban|account number)/i;

interface FormField {
  tag?: unknown;
  type?: unknown;
  name?: unknown;
  label?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parse Bladebro's `extract forms` payload: `extract forms:\n[{...}]`. */
export function parseFormFields(raw: string | null): FormField[] | null {
  if (!raw) return null;
  const start = raw.indexOf("[");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(start)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const fields: FormField[] = [];
    for (const form of parsed) {
      if (!form || typeof form !== "object") continue;
      const formFields = (form as { fields?: unknown }).fields;
      if (!Array.isArray(formFields)) continue;
      for (const field of formFields) {
        if (field && typeof field === "object") fields.push(field as FormField);
      }
    }
    return fields;
  } catch {
    return null;
  }
}

function isCredentialField(field: FormField): boolean {
  const type = text(field.type);
  const name = text(field.name);
  const label = text(field.label);
  return type === "password" || CREDENTIAL_PATTERN.test(name) || CREDENTIAL_PATTERN.test(label);
}

function fieldMatches(field: FormField, target: string): boolean {
  const needle = target.trim().toLowerCase();
  if (!needle) return false;
  const haystack = [text(field.name), text(field.label), text(field.tag)].join(" ").toLowerCase();
  return haystack.includes(needle) || (haystack.length > 0 && needle.includes(haystack));
}

export interface PageRef {
  ref: string;
  role: string;
  label: string;
  type?: string;
}

/** Parse Bladebro `see model` lines: `e1 textbox "Email address" [email] *`. */
export function parsePageRefs(raw: string | null): PageRef[] | null {
  if (!raw) return null;
  const refs: PageRef[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*(e\d+)\s+(\w+)\s+"([^"]*)"(?:\s+\[([^\]]+)\])?/.exec(line);
    if (!match) continue;
    refs.push({
      ref: match[1]!,
      role: match[2]!,
      label: match[3]!,
      ...(match[4] ? { type: match[4] } : {}),
    });
  }
  return refs.length ? refs : null;
}

function refIsCredential(ref: PageRef): boolean {
  return ref.type === "password" || ref.role === "password" ||
    CREDENTIAL_PATTERN.test(ref.type ?? "") || CREDENTIAL_PATTERN.test(ref.label);
}

function refMatches(ref: PageRef, target: string): boolean {
  const needle = target.trim().toLowerCase();
  if (!needle) return false;
  const haystack = `${ref.ref} ${ref.label} ${ref.type ?? ""}`.toLowerCase();
  return haystack.includes(needle) || (haystack.length > 0 && needle.includes(haystack));
}

function resolveRef(refs: PageRef[], target: string): PageRef | null {
  const exact = refs.find((ref) => ref.ref === target.trim());
  if (exact) return exact;
  const matches = refs.filter((ref) => refMatches(ref, target));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`more than one field matches ${JSON.stringify(target)}; use a ref from browser_open`);
  return null;
}

/** Resolve a fill/type to the page's refs, verify every target is not a
 * credential field, and return the input Bladebro expects (ref-addressed). */
export function resolveActTargets(input: BrowserActInput, pageModel: string | null): BrowserActInput {
  if (input.action !== "type" && input.action !== "fill") return input;
  const refs = parsePageRefs(pageModel);
  if (!refs) {
    throw new Error("the page model is unavailable; call browser_open or browser_read before filling a field");
  }
  if (input.action === "fill") {
    const entries = Object.entries(input.fields ?? {});
    if (!entries.length) throw new Error("browser_act fill needs a fields object");
    const resolved: Record<string, string> = {};
    for (const [key, value] of entries) {
      const ref = resolveRef(refs, key);
      if (!ref) throw new Error(`field ${JSON.stringify(key)} was not found on the current page; use a ref from browser_open`);
      if (refIsCredential(ref)) throw new Error(`${ref.ref} is a password/OTP/card field; use browser_request_human`);
      resolved[ref.ref] = value;
    }
    return { ...input, fields: resolved };
  }
  const target = input.target ?? input.selector;
  if (!target) throw new Error("browser_act type needs a target or selector");
  const ref = resolveRef(refs, target);
  if (!ref) throw new Error(`field ${JSON.stringify(target)} was not found on the current page; use a ref from browser_open`);
  if (refIsCredential(ref)) throw new Error(`${ref.ref} is a password/OTP/card field; use browser_request_human`);
  const { selector: _selector, ...rest } = input;
  return { ...rest, target: ref.ref };
}

/** Throws when the action would enter credentials. Callers run this before
 * the act; the form snapshot is best-effort by nature. */
export function assertCredentialSafe(input: BrowserActInput, formsText: string | null): void {
  if (input.action !== "type" && input.action !== "fill") return;
  const fields = parseFormFields(formsText);
  if (input.action === "fill") {
    if (!fields) {
      throw new Error(
        "this form could not be inspected (it may be inside a cross-origin frame); use browser_request_human",
      );
    }
    const entries = Object.entries(input.fields ?? {});
    if (entries.length === 0) throw new Error("browser_act fill needs a fields object");
    if (fields.some(isCredentialField)) {
      throw new Error("credential and payment fields must be completed by the person; use browser_request_human");
    }
    for (const [name] of entries) {
      if (CREDENTIAL_PATTERN.test(name) || !fields.some((field) => fieldMatches(field, name))) {
        throw new Error("this field could not be verified as non-credential; use browser_request_human");
      }
    }
    return;
  }
  if (CREDENTIAL_PATTERN.test(input.target ?? "")) {
    throw new Error("credential and payment fields must be completed by the person; use browser_request_human");
  }
  if (!fields) return;
  if (fields.some((field) => isCredentialField(field) && fieldMatches(field, input.target ?? ""))) {
    throw new Error("credential and payment fields must be completed by the person; use browser_request_human");
  }
}
