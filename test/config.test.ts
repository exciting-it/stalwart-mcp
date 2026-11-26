import { describe, expect, it } from "vitest";
import { connectorName, dataJurisdiction, enabledAreas, features, httpsOrigin, stalwartOrigin } from "../src/config";
import { scopeFor, STALWART } from "../src/stalwart/endpoints";

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

describe("enabledAreas", () => {
  it("offers every area when nothing is switched off", () => {
    expect([...enabledAreas(undefined)!].sort()).toEqual(["calendars", "contacts"]);
    expect([...enabledAreas("")!].sort()).toEqual(["calendars", "contacts"]);
  });

  it.each([
    ["contacts", ["calendars"]],
    ["calendars", ["contacts"]],
    ["contacts,calendars", []],
    [" calendars , contacts ", []],
    ["contacts,contacts", ["calendars"]],
  ])("DISABLED_FEATURES=%j leaves %j", (value, areas) => expect([...enabledAreas(value)!].sort()).toEqual(areas));

  it.each(["mail", "files", "contacts,", "contacts;calendars", "Contacts", "all", "none", 1, null])(
    "%j is refused, not ignored",
    (value) => expect(enabledAreas(value)).toBeNull(),
  );
});

describe("scopeFor", () => {
  const MAIL = "urn:ietf:params:oauth:scope:mail";
  const CONTACTS = "urn:ietf:params:oauth:scope:contacts";
  const CALENDARS = "urn:ietf:params:oauth:scope:calendars";

  it("asks for mail alone when no area is switched on", () => expect(scopeFor(new Set())).toBe(MAIL));

  it("adds exactly the scope of each enabled area and never another", () => {
    expect(scopeFor(new Set(["contacts"]))).toBe(`${MAIL} ${CONTACTS}`);
    expect(scopeFor(new Set(["calendars"]))).toBe(`${MAIL} ${CALENDARS}`);
    expect(scopeFor(new Set(["calendars", "contacts"]))).toBe(`${MAIL} ${CONTACTS} ${CALENDARS}`);
    for (const areas of [[], ["contacts"], ["calendars"], ["contacts", "calendars"]] as const) {
      expect(scopeFor(new Set(areas))).not.toMatch(/files|full|security|settings|openid|offline_access/);
    }
  });
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
      // Nothing is switched off in the test config: one scope per area, mail first.
      scope:
        "urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:contacts urn:ietf:params:oauth:scope:calendars",
    });
    expect([...features()].sort()).toEqual(["calendars", "contacts"]);
  });

  it("takes the connector's name from CONNECTOR_NAME", () => expect(connectorName()).toBe("Test Mail"));
});
