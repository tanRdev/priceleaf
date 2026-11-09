import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const root = resolve("build/priceleaf-web/public");
const config = JSON.parse(await readFile("site.vercel.json", "utf8"));
const headers = Object.fromEntries(
  config.headers[0].headers.map(({ key, value }) => [key, value]),
);
const types = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".svg": "image/svg+xml",
};

test("catalog review and export stay in the browser", async (t) => {
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
      if (request.method !== "GET" || !file.startsWith(root + sep))
        throw new Error("Invalid request");
      const data = await readFile(file);
      response
        .writeHead(200, {
          ...headers,
          "Content-Type": types[extname(file)] ?? "application/octet-stream",
        })
        .end(data);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise((done) => server.close(done)));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch(
    process.env.PRICELEAF_CHROME
      ? { executablePath: process.env.PRICELEAF_CHROME }
      : {},
  );
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const violations = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "blob:") return;
    if (
      url.origin !== origin ||
      request.method() !== "GET" ||
      url.search ||
      !(
        ["/", "/app.mjs", "/pdf.mjs", "/styles.css"].includes(url.pathname) ||
        url.pathname.startsWith("/assets/") ||
        url.pathname.startsWith("/vendor/")
      )
    )
      violations.push(request.method() + " " + request.url());
  });
  page.on("pageerror", (error) => violations.push(error.message));
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text()))
      violations.push(message.text());
  });
  await page.goto(origin);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    390,
  );
  await page
    .locator("#pdf-input")
    .setInputFiles("web/assets/example-catalog.pdf");
  await page.locator("#csv-input").setInputFiles({
    name: "price-sheet.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "sku,old_price,new_price\nNL-001,99.00,13.50\nNL-002,12.00,14.00\nNL-003,8.50,9.25\n",
    ),
  });
  await page.getByRole("button", { name: "Continue" }).click();
  await page
    .getByRole("button", { name: "Check changes", exact: true })
    .click();
  await page.getByText("2 of 3 changes ready").waitFor();
  assert.equal(await page.locator("#verify").isEnabled(), false);
  await page
    .getByRole("textbox", { name: "Row 1 current price" })
    .fill("12.00");
  await page.getByRole("button", { name: "Check again" }).click();
  await page.getByText("3 of 3 changes ready").waitFor();
  await page.getByRole("button", { name: "Verify and prepare PDF" }).click();
  await page.getByRole("heading", { name: "Your catalog is ready" }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download verified PDF" }).click(),
  ]);
  assert.equal(download.suggestedFilename(), "example-catalog-updated.pdf");
  assert.match(
    (await readFile(await download.path())).subarray(0, 8).toString(),
    /^%PDF-/,
  );
  const [reportDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download change report" }).click(),
  ]);
  const report = await readFile(await reportDownload.path(), "utf8");
  assert.match(report, /NL-001,12\.00,13\.50,1/);
  assert.deepEqual(
    await page.evaluate(() => [
      document.cookie,
      localStorage.length,
      sessionStorage.length,
    ]),
    ["", 0, 0],
  );
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("heading", { name: "Add your files" }).waitFor();
  assert.equal(await page.locator("#pdf-download").getAttribute("href"), null);
  assert.deepEqual(violations, []);
});
