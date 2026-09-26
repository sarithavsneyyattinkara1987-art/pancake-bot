/**
 * Secret redaction.
 *
 * Every credential is registered here the moment it is loaded, and every log
 * line the bot produces passes through `redact()`. Leaking a configured
 * password into logs or a dashboard is then structurally impossible rather
 * than a per-call-site discipline.
 */

const secrets = new Set<string>();
const extraNeedles = new Set<string>();

export const REDACTED = "[redacted]";

/** Register a secret value so it can never appear in output. */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const trimmed = value.trim();
  // Very short strings would redact ordinary text; require a real secret.
  if (trimmed.length < 3) return;
  secrets.add(trimmed);
  extraNeedles.add(trimmed);
}

/** Register several secrets at once. */
export function registerSecrets(values: Array<string | undefined | null>): void {
  for (const v of values) registerSecret(v);
}

/** Register an extra literal (e.g. a token fragment) to hide. */
export function registerNeedle(value: string | undefined | null): void {
  if (value && value.trim().length >= 3) extraNeedles.add(value.trim());
}

export function forgetSecrets(): void {
  secrets.clear();
  extraNeedles.clear();
}

export function secretCount(): number {
  return secrets.size;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact known secrets plus common secret-bearing shapes
 * (`/login hunter2`, `password=...`, `token ...`) from any text.
 */
export function redact(text: string): string {
  let out = text;
  for (const needle of extraNeedles) {
    if (needle && out.includes(needle)) {
      out = out.split(needle).join(REDACTED);
    }
  }
  // Command style: /login <secret>  /register <secret> <secret>
  out = out.replace(
    /(\/(?:login|register|changepassword|changepass|auth|password)\s+)(\S+)(\s+\S+)?/gi,
    (_m, cmd: string, a: string, b?: string) => `${cmd}${REDACTED}${b ? " " + REDACTED : ""}`,
  );
  // key=value / key: value style
  out = out.replace(
    /\b(password|passwd|pass|pwd|secret|token|access[_-]?token|session|auth)["']?\s*[:=]\s*["']?([^\s"',}]+)/gi,
    (_m, key: string) => `${key}=${REDACTED}`,
  );
  return out;
}

/** Deep-redact structured data for logs/dashboards. */
export function redactData<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactData(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyLower = k.toLowerCase();
      if (
        secrets.size > 0 &&
        /password|passwd|secret|token|credential/.test(keyLower) &&
        typeof v === "string"
      ) {
        out[k] = REDACTED;
      } else {
        out[k] = redactData(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/** True when the text contains a registered secret (used by tests). */
export function containsSecret(text: string): boolean {
  for (const needle of secrets) {
    if (text.includes(needle)) return true;
  }
  return false;
}
