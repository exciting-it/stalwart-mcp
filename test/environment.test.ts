import { describe, expect, it } from "vitest";
import {
  configProblem,
  isEnabled,
  isProduction,
  publicOrigin,
  recipientsAllowed,
  signInAllowed,
} from "../src/policy/environment";

describe("environment policy", () => {
  it("is production only for exactly 'production'", () => {
    expect(isProduction({ ENVIRONMENT: "production" })).toBe(true);
    for (const v of ["staging", "Production", "", undefined]) {
      expect(isProduction({ ENVIRONMENT: v as never })).toBe(false);
    }
  });

  it("production ignores the request origin and answers under PUBLIC_ORIGIN", () =>
    expect(
      publicOrigin({ ENVIRONMENT: "production", PUBLIC_ORIGIN: "https://connector.example" }, "https://evil.example/x"),
    ).toBe("https://connector.example"));

  it.each([undefined, "", "http://connector.example", "https://connector.example/mcp", "connector.example"])(
    "production refuses to derive an origin from PUBLIC_ORIGIN=%j",
    (value) =>
      expect(() => publicOrigin({ ENVIRONMENT: "production", PUBLIC_ORIGIN: value }, "https://evil.example/x")).toThrow(
        "PUBLIC_ORIGIN",
      ),
  );

  it("staging uses the request origin", () =>
    expect(publicOrigin({ ENVIRONMENT: "staging" }, "https://s.workers.dev/authorize?x=1")).toBe(
      "https://s.workers.dev",
    ));

  it("production lets every mailbox sign in and every recipient through", () => {
    expect(signInAllowed({ ENVIRONMENT: "production" }, "anyone@example.com")).toBe(true);
    expect(signInAllowed({ ENVIRONMENT: "production", SIGNIN_ALLOWLIST: "a@x.example" }, "b@y.example")).toBe(true);
    expect(recipientsAllowed({ ENVIRONMENT: "production" }, ["x@example.com", "y@example.org"])).toBe(true);
    expect(recipientsAllowed({ ENVIRONMENT: "production" }, [])).toBe(true);
  });

  it("staging with an empty or missing list lets nobody sign in and sends to nobody", () => {
    for (const list of [undefined, "", " , "]) {
      expect(signInAllowed({ ENVIRONMENT: "staging", SIGNIN_ALLOWLIST: list }, "a@test.example")).toBe(false);
      expect(recipientsAllowed({ ENVIRONMENT: "staging", SEND_ALLOWLIST: list }, ["ok@test.example"])).toBe(false);
    }
    // An empty recipient list is never allowed outside production, whatever the list holds.
    expect(recipientsAllowed({ ENVIRONMENT: "staging", SEND_ALLOWLIST: "ok@test.example" }, [])).toBe(false);
    expect(signInAllowed({ ENVIRONMENT: "staging", SIGNIN_ALLOWLIST: "a@test.example" }, "")).toBe(false);
  });

  it("staging matches the allow-lists case-insensitively and needs every recipient on the list", () => {
    const env = { ENVIRONMENT: "staging", SEND_ALLOWLIST: "ok@test.example, Two@Test.example" } as const;
    expect(recipientsAllowed(env, ["OK@test.example", "two@test.example"])).toBe(true);
    expect(recipientsAllowed(env, ["ok@test.example", "other@test.example"])).toBe(false);
    const signIn = { ENVIRONMENT: "staging", SIGNIN_ALLOWLIST: "A@test.example,b@test.example" } as const;
    expect(signInAllowed(signIn, "a@TEST.example")).toBe(true);
    expect(signInAllowed(signIn, "c@test.example")).toBe(false);
  });

  it("names the setting that keeps the worker from serving", () => {
    const ok = { STALWART_ORIGIN: "https://mail.example", PUBLIC_ORIGIN: "https://connector.example" };
    expect(configProblem({ ENVIRONMENT: "production", ...ok })).toBeNull();
    expect(configProblem({ ENVIRONMENT: "production", ...ok, STALWART_ORIGIN: "http://mail.example" })).toBe(
      "STALWART_ORIGIN",
    );
    expect(configProblem({ ENVIRONMENT: "production", ...ok, STALWART_ORIGIN: undefined as never })).toBe(
      "STALWART_ORIGIN",
    );
    expect(configProblem({ ENVIRONMENT: "production", ...ok, PUBLIC_ORIGIN: undefined })).toBe("PUBLIC_ORIGIN");
    // Staging answers under the request origin and needs no PUBLIC_ORIGIN.
    expect(configProblem({ ENVIRONMENT: "staging", STALWART_ORIGIN: "https://mail.example" })).toBeNull();
    expect(configProblem({ ENVIRONMENT: "staging", STALWART_ORIGIN: "" })).toBe("STALWART_ORIGIN");
    // The same for the areas beyond mail.
    expect(configProblem({ ENVIRONMENT: "production", ...ok, FEATURES: "contacts,calendars" })).toBeNull();
    expect(configProblem({ ENVIRONMENT: "production", ...ok, FEATURES: "contacts,files" })).toBe("FEATURES");
    // A jurisdiction is optional, but a mistyped one closes the worker.
    expect(configProblem({ ENVIRONMENT: "production", ...ok, DATA_JURISDICTION: "eu" })).toBeNull();
    expect(configProblem({ ENVIRONMENT: "production", ...ok, DATA_JURISDICTION: "" })).toBeNull();
    expect(configProblem({ ENVIRONMENT: "production", ...ok, DATA_JURISDICTION: "EU" })).toBe("DATA_JURISDICTION");
    expect(configProblem({ ENVIRONMENT: "staging", STALWART_ORIGIN: "https://mail.example", DATA_JURISDICTION: "europe" })).toBe(
      "DATA_JURISDICTION",
    );
  });

  it.each(["false", "TRUE", "1", "", undefined])("is disabled for MAIL_MCP_ENABLED=%j", (v) =>
    expect(isEnabled({ MAIL_MCP_ENABLED: v })).toBe(false),
  );

  it("is enabled for exactly 'true'", () => expect(isEnabled({ MAIL_MCP_ENABLED: "true" })).toBe(true));
});
