import { describe, expect, it, vi } from "vitest";
import { testEnv } from "../testing/bff";
import type { BrowserReport } from "./browser-report";
import { maxCspReportsPerRequest, type CspReport } from "./csp-report";
import { WindowBudget } from "./limiter";
import { handleMonitoringReport, maxReportBytes } from "./monitoring";

const env = { ...testEnv, sentryDsn: "http://0123abcd@glitchtip.test:8000/1" };

const report: BrowserReport = {
  name: "TypeError",
  message: "x is undefined",
  stack: "    at f (http://localhost:3001/_next/static/chunks/a.js:1:2)",
  path: "/",
  debug_ids: {},
};

function post(body: BodyInit | null, headers: Record<string, string> = { "Content-Type": "text/plain" }): Request {
  return new Request("http://localhost:3001/monitoring", { method: "POST", body, headers });
}

function deps(limit = 20) {
  return {
    budget: new WindowBudget(limit, 60_000),
    cspBudget: new WindowBudget(limit, 60_000),
    capture: vi.fn<(report: BrowserReport) => void>(),
    captureCsp: vi.fn<(report: CspReport) => void>(),
  };
}

// What may never reach the tracker from a CSP report: the page's query, the referrer, the blocked URL's and the
// script's query, the script sample and the policy with its nonce.
const leaks = ["ref=mail", "mail.example", "uid=42", "v=1", "minh@example.com", "SECRETNONCE", "default-src"];

// A Reporting API upload as Chromium sends it: one entry per report, each with its own type.
const violation = {
  type: "csp-violation",
  age: 1,
  url: "http://localhost:3001/u/minhanh?ref=mail",
  user_agent: "Mozilla/5.0",
  body: {
    documentURL: "http://localhost:3001/u/minhanh?ref=mail",
    referrer: "https://mail.example/inbox?id=9",
    blockedURL: "http://evil.test/pixel.png?uid=42",
    effectiveDirective: "img-src",
    originalPolicy: "default-src 'self'; script-src 'nonce-SECRETNONCE'",
    sourceFile: "http://localhost:3001/_next/static/chunks/a.js?v=1",
    sample: "alert('minh@example.com')",
    disposition: "enforce",
    statusCode: 200,
    lineNumber: 12,
    columnNumber: 7,
  },
};

// The same violation in the CSP Level 2 form of report-uri, as browsers before CSP Level 3 send it (no
// effective-directive or disposition).
const level2 = {
  "csp-report": {
    "document-uri": "http://localhost:3001/u/minhanh?ref=mail",
    referrer: "https://mail.example/inbox?id=9",
    "violated-directive": "img-src",
    "original-policy": "default-src 'self'; script-src 'nonce-SECRETNONCE'",
    "blocked-uri": "http://evil.test/pixel.png?uid=42",
    "status-code": 200,
    "source-file": "http://localhost:3001/_next/static/chunks/a.js?v=1",
    "line-number": 12,
    "column-number": 7,
    "script-sample": "alert('minh@example.com')",
  },
};

const expected: CspReport = {
  path: "/u/minhanh",
  blocked: "http://evil.test/pixel.png",
  directive: "img-src",
  disposition: "enforce",
  sourceFile: "http://localhost:3001/_next/static/chunks/a.js",
  line: 12,
  column: 7,
  statusCode: 200,
};

const reportsJson = { "Content-Type": "application/reports+json" };
const cspReport = { "Content-Type": "application/csp-report" };

describe("POST /monitoring", () => {
  it("hands a valid report to the SDK and answers 202 at once", async () => {
    const d = deps();
    const response = await handleMonitoringReport(post(JSON.stringify(report)), env, d);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(d.capture).toHaveBeenCalledExactlyOnceWith(report, env);
  });

  it("answers 404 when reporting is off, before reading anything", async () => {
    const d = deps();
    const response = await handleMonitoringReport(post(JSON.stringify(report)), { ...env, sentryDsn: null }, d);
    expect(response.status).toBe(404);
    expect(d.capture).not.toHaveBeenCalled();
  });

  it("refuses a body over 32 KiB by its Content-Length", async () => {
    const d = deps();
    const big = JSON.stringify({ ...report, stack: "x".repeat(maxReportBytes) });
    const response = await handleMonitoringReport(post(big), env, d);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(d.capture).not.toHaveBeenCalled();
  });

  it("refuses a streamed body over 32 KiB without a Content-Length", async () => {
    const d = deps();
    const bytes = new TextEncoder().encode("x".repeat(1_024));
    let pushed = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pushed++;
        controller.enqueue(bytes);
      },
    });
    const request = new Request("http://localhost:3001/monitoring", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const response = await handleMonitoringReport(request, env, d);
    expect(response.status).toBe(413);
    // It stopped reading right after the limit.
    expect(pushed).toBeLessThan(40);
    expect(d.capture).not.toHaveBeenCalled();
  });

  it.each<[string, string]>([
    ["not JSON", "TypeError: x is undefined"],
    ["an empty body", ""],
    ["a report missing a field", JSON.stringify({ ...report, path: undefined })],
    ["a report with a field too long", JSON.stringify({ ...report, message: "x".repeat(1_001) })],
    ["a Sentry envelope", `{"dsn":"http://0123abcd@glitchtip.test:8000/1"}\n{"type":"event"}\n{}`],
  ])("answers 400 to %s", async (_case, body) => {
    const d = deps();
    const response = await handleMonitoringReport(post(body), env, d);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REPORT" });
    expect(d.capture).not.toHaveBeenCalled();
  });

  it("answers 429 past the browsers' budget, without sending", async () => {
    const d = deps(2);
    for (let i = 0; i < 2; i++) {
      expect((await handleMonitoringReport(post(JSON.stringify(report)), env, d)).status).toBe(202);
    }
    const response = await handleMonitoringReport(post(JSON.stringify(report)), env, d);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(d.capture).toHaveBeenCalledTimes(2);
  });

  it("does not spend the budget on an invalid report", async () => {
    const d = deps(1);
    await handleMonitoringReport(post("not json"), env, d);
    expect((await handleMonitoringReport(post(JSON.stringify(report)), env, d)).status).toBe(202);
  });

  it.each<[string, unknown, Record<string, string>]>([
    ["a Reporting API upload", [violation], reportsJson],
    ["a CSP Level 2 report", level2, { "Content-Type": "application/csp-report; charset=utf-8" }],
    // WebKit's report-uri upload: one Reporting API report, sent as application/csp-report.
    ["a WebKit report-uri report", violation, cspReport],
  ])("hands %s of a CSP violation to the SDK, scrubbed, and answers 202", async (_case, body, headers) => {
    const d = deps();
    const response = await handleMonitoringReport(post(JSON.stringify(body), headers), env, d);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(d.captureCsp).toHaveBeenCalledExactlyOnceWith(expected, env);
    expect(d.capture).not.toHaveBeenCalled();
    const captured = JSON.stringify(d.captureCsp.mock.calls[0]?.[0]);
    for (const leak of leaks) {
      expect(captured).not.toContain(leak);
    }
  });

  it("keeps only the CSP violations of an upload, at most a few per request, one budget unit each", async () => {
    const d = deps();
    const deprecation = { type: "deprecation", body: { id: "x", message: "y" } };
    const body = [deprecation, ...Array.from({ length: maxCspReportsPerRequest + 5 }, () => violation)];
    const response = await handleMonitoringReport(post(JSON.stringify(body), reportsJson), env, d);
    expect(response.status).toBe(202);
    expect(d.captureCsp).toHaveBeenCalledTimes(maxCspReportsPerRequest);
    // The CSP budget had 20; the request spent 10 of it.
    for (let i = 0; i < 20 - maxCspReportsPerRequest; i++) {
      expect(d.cspBudget.take()).toBe(true);
    }
    expect(d.cspBudget.take()).toBe(false);
  });

  it("answers 202 to an upload without CSP violations, sending nothing", async () => {
    const d = deps();
    const body = [{ type: "deprecation", body: {} }];
    expect((await handleMonitoringReport(post(JSON.stringify(body), reportsJson), env, d)).status).toBe(202);
    expect(d.captureCsp).not.toHaveBeenCalled();
  });

  it("reads keywords and non-network URLs as the browser names them, never a data: URL's content", async () => {
    const d = deps();
    const body = [
      { ...violation, body: { ...violation.body, blockedURL: "inline", effectiveDirective: "script-src-elem" } },
      { ...violation, body: { ...violation.body, blockedURL: "data:text/html,minh@example.com" } },
      { ...violation, body: { ...violation.body, blockedURL: "Not A Keyword!" } },
    ];
    expect((await handleMonitoringReport(post(JSON.stringify(body), reportsJson), env, d)).status).toBe(202);
    expect(d.captureCsp.mock.calls.map(([report]) => [report.directive, report.blocked])).toEqual([
      ["script-src-elem", "inline"],
      ["img-src", "data"],
      ["img-src", "other"],
    ]);
  });

  it.each<[string, string, Record<string, string>]>([
    ["an upload that is not a list", JSON.stringify(violation), reportsJson],
    [
      "an upload of over 100 reports",
      JSON.stringify(Array.from({ length: 101 }, () => ({ type: "deprecation", body: {} }))),
      reportsJson,
    ],
    [
      "a violation without its page",
      JSON.stringify([{ ...violation, body: { ...violation.body, documentURL: undefined } }]),
      reportsJson,
    ],
    [
      "a violation whose page is not a URL",
      JSON.stringify([{ ...violation, body: { ...violation.body, documentURL: "/u/minhanh" } }]),
      reportsJson,
    ],
    [
      "a violation with a directive that is not one",
      JSON.stringify([{ ...violation, body: { ...violation.body, effectiveDirective: "img-src; x" } }]),
      reportsJson,
    ],
    [
      "a violation with an unknown disposition",
      JSON.stringify([{ ...violation, body: { ...violation.body, disposition: "block" } }]),
      reportsJson,
    ],
    ["a Level 2 report without its wrapper", JSON.stringify(level2["csp-report"]), cspReport],
    ["a browser error report sent as a CSP report", JSON.stringify(report), cspReport],
    ["a report-uri report of another type", JSON.stringify({ ...violation, type: "deprecation" }), cspReport],
    ["a list sent to report-uri", JSON.stringify([violation]), cspReport],
    ["not JSON", "img-src", cspReport],
  ])("answers 400 to %s", async (_case, body, headers) => {
    const d = deps();
    const response = await handleMonitoringReport(post(body, headers), env, d);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REPORT" });
    expect(d.captureCsp).not.toHaveBeenCalled();
  });

  it("refuses a CSP upload over 32 KiB", async () => {
    const d = deps();
    const big = JSON.stringify(Array.from({ length: 100 }, () => violation));
    expect(big.length).toBeGreaterThan(maxReportBytes);
    const response = await handleMonitoringReport(post(big, reportsJson), env, d);
    expect(response.status).toBe(413);
    expect(d.captureCsp).not.toHaveBeenCalled();
  });

  it("answers 404 to a CSP report when reporting is off", async () => {
    const d = deps();
    const response = await handleMonitoringReport(
      post(JSON.stringify(level2), cspReport),
      { ...env, sentryDsn: null },
      d,
    );
    expect(response.status).toBe(404);
    expect(d.captureCsp).not.toHaveBeenCalled();
  });

  it("sends the CSP violations the budget still allows; 429 when it allows none", async () => {
    const d = deps(2);
    const three = JSON.stringify([violation, violation, violation]);
    expect((await handleMonitoringReport(post(three, reportsJson), env, d)).status).toBe(202);
    expect(d.captureCsp).toHaveBeenCalledTimes(2);
    const response = await handleMonitoringReport(post(JSON.stringify(level2), cspReport), env, d);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(d.captureCsp).toHaveBeenCalledTimes(2);
  });

  it("keeps the error reports' budget apart from the CSP violations'", async () => {
    const d = deps(2);
    const two = JSON.stringify([violation, violation]);
    expect((await handleMonitoringReport(post(two, reportsJson), env, d)).status).toBe(202);
    expect((await handleMonitoringReport(post(JSON.stringify(level2), cspReport), env, d)).status).toBe(429);
    // CSP budget spent: an error report still goes through, and spending the error budget leaves CSP's alone.
    for (let i = 0; i < 2; i++) {
      expect((await handleMonitoringReport(post(JSON.stringify(report)), env, d)).status).toBe(202);
    }
    expect((await handleMonitoringReport(post(JSON.stringify(report)), env, d)).status).toBe(429);
    expect(d.capture).toHaveBeenCalledTimes(2);
    expect(d.captureCsp).toHaveBeenCalledTimes(2);
  });
});
