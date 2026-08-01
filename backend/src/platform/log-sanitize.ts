/**
 * Log sanitization utilities — SF-1 fix.
 *
 * sanitizeForLog() scrubs sensitive credential patterns from text before
 * the text is written to structured log output.  It is intentionally
 * conservative: it only removes what is clearly a credential, leaving
 * enough context (scheme, host, error class names) for operational diagnosis.
 *
 * Patterns redacted:
 *   1. DB / service connection-URL credentials:
 *        scheme://user:password@host  →  scheme://[REDACTED]@host
 *      Schemes: postgresql, postgres, mysql, redis, mongodb, amqp, amqps
 *   2. Key=value credential assignments:
 *        password=<value>, pwd=<value>, passwd=<value>  →  <key>=[REDACTED]
 *      Matching is case-insensitive and stops at whitespace / end-of-string.
 */

const REDACTED = "[REDACTED]";

/**
 * Regex that matches the userinfo segment (user:pass@) inside a service URL.
 * Capture group 1 = scheme prefix up to "://", group 2 = host and beyond.
 *
 * Example:
 *   postgresql://secret:pass@host:5432/db
 *   →  postgresql://[REDACTED]@host:5432/db
 */
const URL_CREDENTIALS_RE =
  /\b(postgresql|postgres|mysql|redis(?:s)?|mongodb(?:\+srv)?|amqps?):\/\/[^@\s]+@/gi;

/**
 * Regex that matches key=value pairs where the key is a known credential name.
 * Stops value capture at whitespace or end-of-string.
 *
 * Examples:
 *   password=secret  →  password=[REDACTED]
 *   PWD=hunter2      →  PWD=[REDACTED]
 *   passwd=foo       →  passwd=[REDACTED]
 */
const KEY_VALUE_CREDENTIALS_RE = /\b(password|passwd|pwd)=\S+/gi;

/**
 * Sanitize a string for safe log output by redacting credential patterns.
 *
 * @param text  The raw string to sanitize (typically err.message or err.stack).
 * @returns     The sanitized string with credentials replaced by [REDACTED].
 *
 * Non-sensitive text is returned unchanged.  The function never throws.
 */
export function sanitizeForLog(text: string): string {
  // Replace URL credentials: keep scheme and host, redact user:password
  let result = text.replace(URL_CREDENTIALS_RE, (match) => {
    // match is e.g. "postgresql://user:pass@"
    // Extract scheme prefix up to "://"
    const schemeEnd = match.indexOf("://") + 3;
    const scheme = match.slice(0, schemeEnd);
    return `${scheme}${REDACTED}@`;
  });

  // Replace key=value credential pairs
  result = result.replace(KEY_VALUE_CREDENTIALS_RE, (match) => {
    const eqIndex = match.indexOf("=");
    const key = match.slice(0, eqIndex + 1); // includes "="
    return `${key}${REDACTED}`;
  });

  return result;
}
