import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const output = new URL("../build/priceleaf-web/", import.meta.url);
const root = new URL("../", import.meta.url);
const at = (path) => new URL(path, root);
const out = (path) => new URL(path, output);
const target = out("public/");
await rm(target, { recursive: true, force: true });
await mkdir(out("public/vendor/"), { recursive: true });
await cp(at("site/"), target, { recursive: true });
await cp(at("web/assets/"), out("public/assets/"), { recursive: true });
const packages = [
  ["pdfjs-dist", "build/pdf.min.mjs", "pdf.min.mjs"],
  ["pdfjs-dist", "build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["pdfjs-dist", "standard_fonts", "standard_fonts"],
  ["pdfjs-dist", "cmaps", "cmaps"],
  ["pdfjs-dist", "wasm", "wasm"],
  ["pdfjs-dist", "iccs", "iccs"],
  ["pdfjs-dist", "LICENSE", "pdfjs-LICENSE.txt"],
  ["pdf-lib", "dist/pdf-lib.min.js", "pdf-lib.min.js"],
  ["pdf-lib", "LICENSE.md", "pdf-lib-LICENSE.txt"],
  ["papaparse", "papaparse.min.js", "papaparse.min.js"],
  ["papaparse", "LICENSE", "papaparse-LICENSE.txt"],
];
for (const [pkg, path, name] of packages) {
  await cp(at(`node_modules/${pkg}/${path}`), out(`public/vendor/${name}`), {
    recursive: true,
  });
}
await writeFile(out("vercel.json"), await readFile(at("site.vercel.json")));
console.log("Built build/priceleaf-web/public");
