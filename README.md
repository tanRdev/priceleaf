<img src="web/assets/logo.svg" alt="" width="72" height="72">

# Priceleaf

Update prices in a PDF catalog from a CSV. The app is at [priceleaf-catalog.vercel.app](https://priceleaf-catalog.vercel.app/). It runs in the browser. The PDF and the spreadsheet stay in the tab. There is no account, and the files are not uploaded.

## Use it

1. Choose a text-based catalog PDF and a CSV, or open the built-in example.
2. Match the product code, current price, and new price columns.
3. Review the changes next to the page. Correct a flagged row, choose the intended price when several match, or skip the row.
4. Download the updated PDF and a CSV report.

## Files it accepts

A PDF can be 1–50 pages and up to 25 MiB. Product codes must be unique in the catalog, and each current price must appear as text on that product's row. Priceleaf edits the text in the PDF, then opens the result and compares the rendered pages outside the prices it changed. If the text or the layout check fails, it stops.

Scanned pages, encrypted files, forms, and some PDF text encodings are unsupported.

The CSV is UTF-8, from 1 to 1,000 rows. Comma, semicolon, and tab separators work.

```csv
sku,old_price,new_price
NL-001,12.00,13.50
NL-002,12.00,14.00
NL-003,8.50,9.25
```

When the same price appears more than once on a row, add `price_left` and `price_right` in PDF points. Those are the horizontal edges of the price you want changed.

## Develop

```sh
npm ci
npx playwright install chromium
npm test
```

`npm test` writes the static site to `build/priceleaf-web/public`, then runs the browser test with the production security headers. The test checks that editing a catalog only requests those static files.

The page source is in `site/`. The logo, fonts, example catalog, and CSV template are in `web/assets/`.

`scripts/deploy_site.sh` builds the site and deploys it with the Vercel CLI. The production headers live in `site.vercel.json`.
