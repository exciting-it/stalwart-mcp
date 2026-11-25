/**
 * Checks that every file the browser pages reference exists in `public/`: a renamed font or
 * image would otherwise leave the page unstyled without failing any test. Run with Bun.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { renderApprovalPage, renderMessagePage } from "../src/oauth/approval-page";

const root = path.join(import.meta.dir, "..", "public");
const pages = [
  renderApprovalPage({ lang: "de", clientName: "c", redirectHost: "h", email: "a@x.example", handle: "h" }),
  renderMessagePage({ lang: "en", kind: "failed", status: 400 }),
];

const referenced = new Set<string>();
for (const page of pages) {
  const html = await page.text();
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"|url\("(\/[^"]+)"\)/g)) referenced.add((m[1] ?? m[2])!);
}

const missing = [...referenced].filter((file) => {
  const onDisk = path.join(root, file);
  return !existsSync(onDisk) || statSync(onDisk).size === 0;
});
if (referenced.size === 0 || missing.length > 0) {
  console.error(referenced.size === 0 ? "The pages reference no files." : `Missing in public/: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`${referenced.size} brand files referenced, all present.`);
