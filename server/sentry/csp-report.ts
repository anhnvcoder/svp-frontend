import "server-only";
import type { ErrorEvent } from "@sentry/nextjs";
import { z } from "zod";
import { routeTemplate } from "./browser-report";

// A browser's Content-Security-Policy violation report to POST /monitoring, by the media type browsers send. All become
// one small shape holding only what tells where the policy blocked what. Left out on purpose: `sample` (the first
// characters of the blocked script or style, page content), `originalPolicy` (the policy itself, with the page's
// nonce) and `referrer` (the page the user came from, often another site). URLs keep their origin and path only.

/** Media type of the Reporting API's reports. */
export const reportsMediaType = "application/reports+json";
/** Media type of a report-uri report. */
export const cspReportMediaType = "application/csp-report";

// Violation reports taken from one request; the rest are ignored. A page that breaks the policy many times at once
// sends them in one batch, and they are all the same problem.
export const maxCspReportsPerRequest = 10;

/** One violation, as it goes to the error tracker. */
export interface CspReport {
  // Path of the page the violation happened on, without query.
  path: string;
  // What was blocked: an http(s) or ws(s) URL without query and fragment, the scheme of any other URL (`data`, `blob`),
  // or the browser's keyword (`inline`, `eval`, `wasm-eval`...).
  blocked: string;
  // Directive that blocked it: `img-src`, `script-src-elem`...
  directive: string;
  // `report` for a report-only policy.
  disposition: "enforce" | "report";
  // Script that caused it, without query, when the browser names one.
  sourceFile?: string;
  line?: number;
  column?: number;
  // HTTP status of the page.
  statusCode?: number;
}

const url = z.string().max(2_000);
const keyword = /^[a-z][a-z0-9-]{0,63}$/;
const position = z.number().int().nonnegative().nullish();

// Reporting API body of a `csp-violation` report (CSP Level 3, CSPViolationReportBody). Keys not named here, among
// them sample, originalPolicy and referrer, are dropped by the parse.
const reportingBodySchema = z.object({
  documentURL: url,
  blockedURL: url.nullish(),
  effectiveDirective: z.string().regex(keyword),
  disposition: z.enum(["enforce", "report"]),
  sourceFile: url.nullish(),
  lineNumber: position,
  columnNumber: position,
  statusCode: position,
});

// One Reporting API report, of any type.
const reportEntrySchema = z.object({ type: z.string().max(100), body: z.unknown() });
// A Reporting API upload: one entry per report.
const reportsSchema = z.array(reportEntrySchema).max(100);

// CSP Level 2 body. Browsers before CSP Level 3 leave out effective-directive and disposition; violated-directive then
// names the directive (`img-src`, or the directive and its sources).
const cspReportSchema = z.object({
  "csp-report": z.object({
    "document-uri": url,
    "blocked-uri": url.nullish(),
    "effective-directive": z.string().regex(keyword).nullish(),
    "violated-directive": z.string().max(2_000).nullish(),
    disposition: z.enum(["enforce", "report"]).nullish(),
    "source-file": url.nullish(),
    "line-number": position,
    "column-number": position,
    "status-code": position,
  }),
});

// An http(s) or ws(s) URL without query and fragment, or undefined for anything else.
function networkURL(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function blockedTarget(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "inline";
  }
  const network = networkURL(value);
  if (network !== undefined) {
    return network.origin + network.pathname;
  }
  // Any other URL keeps its scheme only: a data: URL holds the content itself.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1];
  if (scheme !== undefined) {
    return scheme.toLowerCase();
  }
  return keyword.test(value) ? value : "other";
}

interface RawViolation {
  documentURL: string;
  blockedURL: string | null | undefined;
  directive: string | undefined;
  disposition: "enforce" | "report" | null | undefined;
  sourceFile: string | null | undefined;
  line: number | null | undefined;
  column: number | null | undefined;
  statusCode: number | null | undefined;
}

// The shape that leaves this module; null when the page URL or the directive cannot be read.
function toCspReport(raw: RawViolation): CspReport | null {
  let path: string;
  try {
    path = new URL(raw.documentURL).pathname;
  } catch {
    return null;
  }
  if (raw.directive === undefined || !keyword.test(raw.directive)) {
    return null;
  }
  const source = raw.sourceFile ? networkURL(raw.sourceFile) : undefined;
  return {
    path,
    blocked: blockedTarget(raw.blockedURL),
    directive: raw.directive,
    disposition: raw.disposition ?? "enforce",
    ...(source !== undefined && { sourceFile: source.origin + source.pathname }),
    ...(raw.line ? { line: raw.line } : {}),
    ...(raw.column ? { column: raw.column } : {}),
    ...(raw.statusCode ? { statusCode: raw.statusCode } : {}),
  };
}

/**
 * The violation reports of a body of the given media type, already stripped of what must not reach the error
 * tracker; null when the body is not a valid report of that type. Reporting API reports yield their `csp-violation`
 * reports only (at most {@link maxCspReportsPerRequest}), possibly none.
 */
export function parseCspReports(
  mediaType: typeof reportsMediaType | typeof cspReportMediaType,
  body: unknown,
): CspReport[] | null {
  if (mediaType === reportsMediaType) {
    const parsed = reportsSchema.safeParse(body);
    return parsed.success ? fromEntries(parsed.data) : null;
  }
  const level2 = cspReportSchema.safeParse(body);
  if (level2.success) {
    const raw = level2.data["csp-report"];
    const report = toCspReport({
      documentURL: raw["document-uri"],
      blockedURL: raw["blocked-uri"],
      directive: raw["effective-directive"] ?? raw["violated-directive"]?.split(" ")[0],
      disposition: raw.disposition,
      sourceFile: raw["source-file"],
      line: raw["line-number"],
      column: raw["column-number"],
      statusCode: raw["status-code"],
    });
    return report === null ? null : [report];
  }
  // WebKit posts one Reporting API report to report-uri, with this media type.
  const entry = reportEntrySchema.safeParse(body);
  return entry.success && entry.data.type === "csp-violation" ? fromEntries([entry.data]) : null;
}

// The `csp-violation` reports of a Reporting API upload, at most maxCspReportsPerRequest; null when one is invalid.
function fromEntries(entries: z.infer<typeof reportsSchema>): CspReport[] | null {
  const reports: CspReport[] = [];
  for (const entry of entries.filter(({ type }) => type === "csp-violation").slice(0, maxCspReportsPerRequest)) {
    const raw = reportingBodySchema.safeParse(entry.body);
    const report = raw.success
      ? toCspReport({
          documentURL: raw.data.documentURL,
          blockedURL: raw.data.blockedURL,
          directive: raw.data.effectiveDirective,
          disposition: raw.data.disposition,
          sourceFile: raw.data.sourceFile,
          line: raw.data.lineNumber,
          column: raw.data.columnNumber,
          statusCode: raw.data.statusCode,
        })
      : null;
    if (report === null) {
      return null;
    }
    reports.push(report);
  }
  return reports;
}

export interface CspEventOptions {
  appOrigin: string;
}

/**
 * The warning event for one violation. One issue per directive and blocked origin (or keyword): the full blocked URL
 * goes in the `csp` context, not the message. The scrubbing rules run on it later, in the SDK's beforeSend.
 */
export function cspEvent(report: CspReport, { appOrigin }: CspEventOptions): ErrorEvent {
  const blocked = networkURL(report.blocked)?.origin ?? report.blocked;
  return {
    type: undefined,
    platform: "javascript",
    level: "warning",
    message: `CSP ${report.directive} blocked ${blocked}`,
    request: { url: appOrigin + report.path },
    tags: {
      service: "web",
      runtime: "browser",
      route: routeTemplate(report.path),
      csp_directive: report.directive,
      csp_disposition: report.disposition,
    },
    contexts: {
      csp: {
        blocked_url: report.blocked,
        effective_directive: report.directive,
        disposition: report.disposition,
        ...(report.sourceFile !== undefined && { source_file: report.sourceFile }),
        ...(report.line !== undefined && { line_number: report.line }),
        ...(report.column !== undefined && { column_number: report.column }),
        ...(report.statusCode !== undefined && { status_code: report.statusCode }),
      },
    },
  };
}
