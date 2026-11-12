import { describe, expect, it } from "vitest";
import { clientAddressOf, gatewayHeaders, noClientAddress } from "./gateway";

describe("clientAddressOf", () => {
  it("takes both headers as the request had them, whatever the case of their names", () => {
    const headers = new Headers({
      "X-FORWARDED-FOR": "198.51.100.1, 10.42.0.9",
      "cloudfront-VIEWER-address": "[2001:db8::1]:4711",
    });
    expect(clientAddressOf(headers)).toEqual({
      forwardedFor: "198.51.100.1, 10.42.0.9",
      viewerAddress: "[2001:db8::1]:4711",
    });
  });

  it("leaves out the header the request lacked", () => {
    expect(clientAddressOf(new Headers({ "x-forwarded-for": "198.51.100.1" }))).toEqual({
      forwardedFor: "198.51.100.1",
      viewerAddress: null,
    });
    expect(clientAddressOf(new Headers())).toEqual(noClientAddress);
  });
});

describe("gatewayHeaders", () => {
  it("sends X-Forwarded-For unchanged and CloudFront-Viewer-Address under that name", () => {
    expect(
      gatewayHeaders("tok", { forwardedFor: "198.51.100.1, 10.42.0.9", viewerAddress: "198.51.100.1:4711" }),
    ).toEqual({
      Accept: "application/json, application/problem+json",
      Authorization: "Bearer tok",
      "X-Forwarded-For": "198.51.100.1, 10.42.0.9",
      "CloudFront-Viewer-Address": "198.51.100.1:4711",
    });
  });

  it("sends neither header when the request had none", () => {
    expect(gatewayHeaders(null, noClientAddress)).toEqual({ Accept: "application/json, application/problem+json" });
  });
});
