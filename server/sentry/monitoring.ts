import "server-only";
import type { ServerEnv } from "../env";
import { problem } from "../problem";
import { browserReportSchema, type BrowserReport } from "./browser-report";
import { cspReportMediaType, parseCspReports, reportsMediaType, type CspReport } from "./csp-report";
import { WindowBudget } from "./limiter";

// POST /monitoring: a browser's error report, or its reports of Content-Security-Policy violations. proxy.ts has
// already checked it comes from the app's own pages (CSRF); this checks the report and hands it to the SDK.

export const maxReportBytes = 32 * 1024;

export interface MonitoringDeps {
  // Browser error reports of this process: 20 a minute, whoever sends them (all clients may share one or two addresses).
  budget: WindowBudget;
  // CSP violations, on a budget of their own: a page that breaks its policy many times over must not make the error
  // reports answer 429.
  cspBudget: WindowBudget;
  capture(report: BrowserReport, env: ServerEnv): void;
  // A CSP violation, already stripped of the fields that must not reach the tracker.
  captureCsp(report: CspReport, env: ServerEnv): void;
}

// The body as text, or null when it is larger than the limit.
async function readText(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxReportBytes) {
    return null;
  }
  if (request.body === null) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxReportBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function handleMonitoringReport(
  request: Request,
  env: ServerEnv,
  { budget, cspBudget, capture, captureCsp }: MonitoringDeps,
): Promise<Response> {
  // Reporting is off: the browser stops sending for the rest of the page.
  if (env.sentryDsn === null) {
    return problem(404, "NOT_FOUND");
  }
  const text = await readText(request);
  if (text === null) {
    return problem(413, "PAYLOAD_TOO_LARGE");
  }
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType === reportsMediaType || mediaType === cspReportMediaType) {
    const reports = parseCspReports(mediaType, parseJson(text));
    if (reports === null) {
      return problem(400, "INVALID_REPORT");
    }
    // One unit of the CSP budget per violation. Those past it are dropped; 429 only when none went through, so a browser
    // that retries a refused upload does not send again what was already reported.
    let sent = 0;
    for (const report of reports) {
      if (!cspBudget.take()) {
        break;
      }
      captureCsp(report, env);
      sent++;
    }
    if (reports.length > 0 && sent === 0) {
      return problem(429, "RATE_LIMITED", { "Retry-After": "60" });
    }
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  // The browser's own error report is JSON sent as text/plain (a type a form could send too: proxy.ts's origin check
  // is what keeps other sites out), so any other media type is read as one.
  const report = browserReportSchema.safeParse(parseJson(text));
  if (!report.success) {
    return problem(400, "INVALID_REPORT");
  }
  if (!budget.take()) {
    return problem(429, "RATE_LIMITED", { "Retry-After": "60" });
  }
  capture(report.data, env);
  return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
}
