import "server-only";
import { randomBytes } from "node:crypto";

// Content-Security-Policy and the other security headers of every response.

// 16 random bytes per request: a script injected into the page cannot guess it.
export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

export interface CspOptions {
  nonce: string;
  mediaOrigin: string;
  uploadOrigin: string;
  // APP_ORIGIN is https.
  secure: boolean;
  // `next dev` only: React rebuilds server error stacks in the browser with eval. A production build never has it, and
  // nothing ever gets 'unsafe-inline'.
  dev: boolean;
  // Absolute URL browsers send violation reports to (see cspReportEndpoint); null sends none.
  reportEndpoint: string | null;
}

/**
 * The URL of POST /monitoring when error reporting is on (a DSN is set), else null: the route answers 404 without a
 * DSN, so the policy then names no endpoint at all. Absolute, from APP_ORIGIN: the Reporting API sends only to a
 * potentially trustworthy origin (https, or localhost).
 */
export function cspReportEndpoint(appOrigin: string, sentryDsn: string | null): string | null {
  return sentryDsn === null ? null : `${appOrigin}/monitoring`;
}

export function contentSecurityPolicy({
  nonce,
  mediaOrigin,
  uploadOrigin,
  secure,
  dev,
  reportEndpoint,
}: CspOptions): string {
  // The upload origin is listed once when it is the media origin (one object store serves both in compose).
  const connect = uploadOrigin === mediaOrigin ? mediaOrigin : `${mediaOrigin} ${uploadOrigin}`;
  const directives = [
    "default-src 'self'",
    // 'self' is only the fallback for browsers that do not know 'strict-dynamic'.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' ${mediaOrigin} data: blob:`,
    // hls.js feeds MediaSource through blob: URLs; without MSE the playlist URL goes straight into <video>.
    `media-src 'self' ${mediaOrigin} blob:`,
    // hls.js loads playlists and segments with XHR; the upload page posts the file to storage with XHR.
    `connect-src 'self' ${connect}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secure ? ["upgrade-insecure-requests"] : []),
    // A browser with the Reporting API uses report-to (the endpoint of Reporting-Endpoints) and ignores report-uri;
    // one without it, as WebKit, posts to report-uri.
    ...(reportEndpoint === null ? [] : ["report-to csp", `report-uri ${reportEndpoint}`]),
  ];
  return directives.join("; ");
}

export function setSecurityHeaders(
  headers: Headers,
  csp: string,
  secure: boolean,
  reportEndpoint: string | null,
): void {
  headers.set("Content-Security-Policy", csp);
  if (reportEndpoint !== null) {
    headers.set("Reporting-Endpoints", `csp="${reportEndpoint}"`);
  }
  if (secure) {
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
}
