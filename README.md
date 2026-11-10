<img src="web/assets/logo.svg" alt="" width="72" height="72">

# Priceleaf

[Try Priceleaf](https://priceleaf-catalog.vercel.app/)

A finished catalog is a designed PDF. The new prices live in a spreadsheet. Priceleaf writes those prices into the PDF and leaves the rest of the page alone. It runs in the browser. The catalog and the price sheet stay in the tab.

You bring the PDF and a CSV with a product code, the current price, and the new price. Priceleaf finds that code on the page and replaces the price in the original font, at the original position. You then download two files. The updated PDF is the catalog. The CSV is a change report: product code, old price, new price, and page number.

## Why a new document is the wrong result

The same `$12.00` can sit next to a dozen products. Find-and-replace in a PDF editor will change every one of them. Rebuilding the page means you still have the design file, the fonts, and the time. Often what you have is the PDF a customer or a printer already accepted, plus a spreadsheet.

A chat model can read the page and suggest prices. It cannot put those prices back into this file. Asking one to update the catalog usually produces a new document: reflowed columns, a different font, artwork redrawn or dropped. That file will not match the catalog you already paid to lay out, and sending the file means uploading the price list.

Priceleaf edits the text that is already in the PDF. The new price has to fit in the original font and in the gap before the next piece of text. It then reopens the file and compares the rendered pages. Pixels outside the price boxes have to match. If the font cannot draw the new characters, a price would run into neighboring text, or anything else on the page moved, it stops. There is no download in that case.

The PDF looks like your catalog because it is your catalog. A longer price is not squeezed, recolored, or set in a new face to force it in. Scanned pages have no text to edit, so those files are refused. The change-report CSV is a list you can check. It is not a designed document.

## Use it

1. Choose a text-based catalog PDF and a CSV, or open the built-in example.
2. Match the product code, current price, and new price columns.
3. Review the changes next to the page. Correct a flagged row, choose the intended price when several match, or skip the row.
4. Download the updated PDF and the CSV report.

## Files it accepts

A PDF can be 1–50 pages and up to 25 MiB. Product codes must be unique in the catalog, and each current price must appear as text on that product's row.

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
