import { describe, expect, it } from "vitest";
import { connectorName, dataJurisdiction, httpsOrigin, stalwartOrigin } from "../src/config";
import { STALWART } from "../src/stalwart/endpoints";

describe("httpsOrigin", () => {
  it.each([
    ["https://mail.example.com", "https://mail.example.com"],
    ["https://mail.example.com/", "https://mail.example.com"],
    ["  https://mail.example.com  ", "https://mail.example.com"],
    ["https://mail.example.com:8443", "https://mail.example.com:8443"],
    ["https://MAIL.example.com", null],
  ])("%j is %j", (value, origin) => expect(httpsOrigin(value)).toBe(origin));

  it.each([
    undefined,
    null,
    42,
    "",
    "mail.example.com",
    "http://mail.example.com",
    "https://user:pw@mail.example.com",
    "https://user@mail.example.com",
    "https://mail.example.com/jmap",
    "https://mail.example.com/?x=1",
    "https://mail.example.com?x=1",
    "https://mail.example.com/#x",
    "https://mail.example.com, https://other.example",
    "javascript:alert(1)",
  ])("%j is not an https origin", (value) => expect(httpsOrigin(value)).toBeNull());
});

describe("dataJurisdiction", () => {
  it.each(["eu", "us", "fedramp"])("%j is a jurisdiction", (value) => expect(dataJurisdiction(value)).toBe(value));

  it.each([undefined, ""])("%j means no restriction", (value) => expect(dataJurisdiction(value)).toBeUndefined());

  it.each(["EU", " eu", "europe", "de", "eu,us", "none", 1, null])("%j is refused, not ignored", (value) =>
    expect(dataJurisdiction(value)).toBeNull(),
  );
});

describe("deployment settings (vitest.config.ts)", () => {
  it("derives every Stalwart URL from STALWART_ORIGIN", () => {
    expect(stalwartOrigin()).toBe("https://stalwart.test.example");
    expect(STALWART).toMatchObject({
      origin: "https://stalwart.test.example",
      authorize: "https://stalwart.test.example/login",
      token: "https://stalwart.test.example/auth/token",
      revoke: "https://stalwart.test.example/auth/revoke",
      session: "https://stalwart.test.example/jmap/session",
      scope: "urn:ietf:params:oauth:scope:mail",
    });
  });

  it("takes the connector's name from CONNECTOR_NAME", () => expect(connectorName()).toBe("Test Mail"));
});
