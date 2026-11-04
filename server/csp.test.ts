import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, cspReportEndpoint, setSecurityHeaders } from "./csp";

const options = {
  nonce: "bm9uY2U=",
  mediaOrigin: "http://127.0.0.1:9000",
  uploadOrigin: "http://127.0.0.1:9000",
  secure: false,
  dev: false,
};

describe("CSP violation reports", () => {
  it("go to /monitoring of APP_ORIGIN when a DSN is set, nowhere without one", () => {
    expect(cspReportEndpoint("https://svp.localhost:8443", "http://key@glitchtip.test:8000/1")).toBe(
      "https://svp.localhost:8443/monitoring",
    );
    expect(cspReportEndpoint("https://svp.localhost:8443", null)).toBeNull();
  });

  it("are asked for with report-to and report-uri, after every other directive", () => {
    const csp = contentSecurityPolicy({
      ...options,
      secure: true,
      reportEndpoint: "https://svp.localhost:8443/monitoring",
    });
    expect(csp).toMatch(
      /; upgrade-insecure-requests; report-to csp; report-uri https:\/\/svp\.localhost:8443\/monitoring$/,
    );
  });

  it("name the endpoint of report-to in Reporting-Endpoints", () => {
    const headers = new Headers();
    setSecurityHeaders(headers, "default-src 'self'", false, "http://localhost:3001/monitoring");
    expect(headers.get("reporting-endpoints")).toBe('csp="http://localhost:3001/monitoring"');
  });

  it("are not asked for when reporting is off", () => {
    const csp = contentSecurityPolicy({ ...options, reportEndpoint: null });
    expect(csp).not.toContain("report-to");
    expect(csp).not.toContain("report-uri");
    const headers = new Headers();
    setSecurityHeaders(headers, csp, false, null);
    expect(headers.has("reporting-endpoints")).toBe(false);
  });
});
