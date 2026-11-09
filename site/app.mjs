import { openPDF, indexPDF, review, render, exportPDF } from "./pdf.mjs";

const $ = (selector) => document.querySelector(selector);
const screens = ["files", "mapping", "review", "done"];
const labels = ["Product code", "Current price", "New price"];
const fields = ["sku", "old", "next"];
const aliases = [
  ["sku", "productcode", "code", "productid", "itemcode"],
  ["oldprice", "currentprice", "existingprice"],
  ["newprice", "updatedprice", "approvedprice"],
];
const state = {
  files: {},
  urls: [],
  choices: new Map(),
  busy: false,
  selected: 0,
  page: 0,
};
let previewSequence = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function go(screen) {
  document.body.dataset.step = screen;
  screens.forEach((name) => {
    $("#" + name).hidden = name !== screen;
  });
  document.querySelectorAll(".steps li").forEach((step, index) => {
    const current = index === screens.indexOf(screen);
    if (current) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
    step.classList.toggle("completed", index < screens.indexOf(screen));
  });
  state.focus = screen;
  if (!state.busy) $("#" + screen + "-title").focus({ preventScroll: true });
  $("#editor").scrollIntoView({ block: "nearest" });
}

function showError(error) {
  $("#error").textContent = error?.message || String(error);
  $("#error").hidden = false;
}

async function work(message, action) {
  if (state.busy) return;
  state.busy = true;
  $("#error").hidden = true;
  $("#busy").textContent = message;
  $("#busy").hidden = false;
  $("#editor").inert = true;
  $("#reset").disabled = true;
  try {
    await action();
  } catch (error) {
    showError(error);
  } finally {
    state.busy = false;
    $("#editor").inert = false;
    $("#reset").disabled = false;
    $("#busy").hidden = true;
    if (state.focus)
      $("#" + state.focus + "-title").focus({ preventScroll: true });
    state.focus = null;
    if (!$("#error").hidden) $("#error").scrollIntoView({ block: "nearest" });
  }
}

function setFile(kind, file) {
  if (!file || state.busy) return;
  const valid = kind === "pdf" ? /\.pdf$/i : /\.(csv|tsv)$/i;
  const limit = kind === "pdf" ? 25 : 2;
  if (!valid.test(file.name) || !file.size || file.size > limit * 1024 * 1024) {
    showError(
      new Error(
        `Choose a nonempty ${kind.toUpperCase()} file under ${limit} MiB.`,
      ),
    );
    return;
  }
  $("#error").hidden = true;
  state.files[kind] = file;
  $("#" + kind + "-name").textContent = file.name;
  $("#" + kind + "-drop").classList.add("chosen");
  $("#continue").disabled = !(state.files.pdf && state.files.csv);
  $("#reset").hidden = false;
}

for (const kind of ["pdf", "csv"]) {
  $("#" + kind + "-input").addEventListener("change", (event) =>
    setFile(kind, event.target.files[0]),
  );
  const zone = $("#" + kind + "-drop");
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    setFile(kind, event.dataTransfer.files[0]);
  });
}

function parseSheet(text) {
  const parsed = globalThis.Papa.parse(text, {
    skipEmptyLines: "greedy",
    delimitersToGuess: [",", ";", "\t"],
  });
  if (parsed.errors.length)
    throw new Error(
      "The price sheet could not be read. Export a UTF-8 CSV with consistent columns.",
    );
  const [headers, ...rows] = parsed.data;
  if (
    !headers ||
    headers.length < 3 ||
    headers.length > 50 ||
    !rows.length ||
    rows.length > 1000 ||
    rows.some((row) => row.length !== headers.length)
  )
    throw new Error("Use 1 to 1,000 rows with 3 to 50 consistent columns.");
  return { headers: headers.map((value) => value.trim()), rows };
}

async function load(pdfData, csvText, filename) {
  const sheet = parseSheet(csvText);
  const pdf = await openPDF(pdfData);
  try {
    const pages = await indexPDF(pdf);
    await state.pdf?.loadingTask.destroy();
    for (const url of state.urls) URL.revokeObjectURL(url);
    Object.assign(state, {
      bytes: pdfData,
      pdf,
      pages,
      sheet,
      filename,
      choices: new Map(),
      urls: [],
      page: 0,
      selected: 0,
      dirty: false,
    });
    $("#flagged").checked = false;
    $("#reset").hidden = false;
    buildMapping();
    go("mapping");
  } catch (error) {
    await pdf.loadingTask.destroy();
    throw error;
  }
}

function buildMapping() {
  const wrapper = $("#mapping-fields");
  wrapper.replaceChildren();
  labels.forEach((label, index) => {
    const field = element("label", label);
    const picker = element("select");
    picker.id = "map-" + fields[index];
    picker.add(new Option("Choose a column", ""));
    state.sheet.headers.forEach((header, column) =>
      picker.add(new Option(header || "Column " + (column + 1), column)),
    );
    const match = state.sheet.headers.findIndex((header) =>
      aliases[index].includes(header.toLowerCase().replace(/[^a-z0-9]/g, "")),
    );
    if (match >= 0) picker.value = match;
    picker.addEventListener("change", mappingPreview);
    field.append(picker);
    wrapper.append(field);
  });
  mappingPreview();
}

function mappingPreview() {
  const values = fields.map((field) => $("#map-" + field).value);
  const columns = values.map((value) => (value === "" ? -1 : Number(value)));
  state.mapping = columns;
  $("#check").disabled = columns.includes(-1) || new Set(columns).size !== 3;
  const head = element("thead"),
    header = element("tr"),
    body = element("tbody");
  labels.forEach((label) => header.append(element("th", label)));
  head.append(header);
  state.sheet.rows.slice(0, 4).forEach((row) => {
    const tr = element("tr");
    columns.forEach((column) => tr.append(element("td", row[column] ?? "—")));
    body.append(tr);
  });
  $("#csv-preview").replaceChildren(head, body);
}

function checkRows(fromMapping = false) {
  work("Checking product codes and prices…", async () => {
    if (fromMapping) {
      state.choices = new Map();
      const left = state.sheet.headers.indexOf("price_left");
      const right = state.sheet.headers.indexOf("price_right");
      state.rows = state.sheet.rows.map((row) => {
        const values = Object.fromEntries(
          fields.map((field, i) => [field, row[state.mapping[i]].trim()]),
        );
        if (row[left]?.trim() || row[right]?.trim()) {
          values.left = row[left]?.trim() ? Number(row[left]) : NaN;
          values.right = row[right]?.trim() ? Number(row[right]) : NaN;
        }
        return values;
      });
    }
    state.results = await review(
      state.bytes,
      state.pages,
      state.rows,
      state.choices,
    );
    state.dirty = false;
    state.selected = state.results.findIndex((row) => row.status !== "ready");
    if (state.selected < 0) state.selected = 0;
    state.page = state.results[state.selected].page ?? 0;
    $("#page").replaceChildren(
      ...state.pages.map((_, index) => new Option(index + 1, index)),
    );
    $("#page").value = state.page;
    go("review");
    renderRows();
    await preview();
  });
}

function markDirty() {
  state.dirty = true;
  $("#summary").textContent = "Changes need checking.";
  $("#verify").disabled = true;
}

function renderRows() {
  const ready = state.results.filter((row) => row.status === "ready").length;
  $("#summary").textContent = state.dirty
    ? "Changes need checking."
    : `${ready} of ${state.results.length} changes ready`;
  $("#verify").disabled = state.dirty || ready !== state.results.length;
  $("#flagged").disabled = ready === state.results.length;
  const body = $("#changes");
  body.replaceChildren();
  for (const row of state.results) {
    if (
      $("#flagged").checked &&
      ready !== state.results.length &&
      row.status === "ready"
    )
      continue;
    const tr = element("tr");
    tr.classList.toggle("selected", row.index === state.selected);
    fields.forEach((field, i) => {
      const td = element("td");
      const input = element("input");
      input.value = state.rows[row.index][field];
      input.setAttribute(
        "aria-label",
        `Row ${row.index + 1} ${labels[i].toLowerCase()}`,
      );
      input.addEventListener("input", () => {
        state.rows[row.index][field] = input.value.trim();
        state.choices.delete(row.index);
        markDirty();
      });
      td.append(input);
      tr.append(td);
    });
    const status = element("td");
    const button = element(
      "button",
      row.status === "ready" ? "Ready" : "Flagged",
      "status " + row.status,
    );
    button.type = "button";
    button.setAttribute(
      "aria-label",
      `Row ${row.index + 1}: ${button.textContent}. Show on page`,
    );
    button.addEventListener("click", () => {
      state.selected = row.index;
      state.page = row.page ?? state.page;
      $("#page").value = state.page;
      renderRows();
      previewSafely();
    });
    status.append(button);
    tr.append(status);
    body.append(tr);
  }
  const selected = state.results[state.selected];
  const detail = $("#row-detail");
  detail.replaceChildren(
    element(
      "p",
      selected?.reason ?? "Select a status to locate its price on the page.",
    ),
  );
  if (selected?.candidates?.length > 1 && selected.page !== null) {
    const label = element("label", "Price position ");
    const select = element("select");
    select.add(new Option("Choose a price", ""));
    const items = state.pages[selected.page].items;
    selected.candidates.forEach((i) =>
      select.add(
        new Option(
          `${items[i].str} at ${Math.round(items[i].transform[4])} pt`,
          i,
        ),
      ),
    );
    select.value = state.choices.get(selected.index) ?? "";
    select.addEventListener("change", () => {
      if (select.value === "") state.choices.delete(selected.index);
      else state.choices.set(selected.index, Number(select.value));
      checkRows();
    });
    label.append(select);
    detail.append(label);
  }
  if (selected && state.rows.length > 1 && selected.status !== "ready") {
    const remove = element("button", "Skip this change", "quiet");
    remove.addEventListener("click", () => {
      state.rows.splice(selected.index, 1);
      state.choices = new Map(
        [...state.choices].flatMap(([key, value]) =>
          key === selected.index
            ? []
            : [[key > selected.index ? key - 1 : key, value]],
        ),
      );
      checkRows();
    });
    detail.append(remove);
  }
}

async function preview() {
  const sequence = ++previewSequence;
  const { page, items } = state.pages[state.page];
  const canvas = element("canvas");
  canvas.id = "canvas";
  canvas.setAttribute("aria-label", "Catalog page " + (state.page + 1));
  const viewport = await render(
    page,
    canvas,
    Math.min(1.5, 950 / page.getViewport({ scale: 1 }).width),
  );
  if (sequence !== previewSequence) return;
  $("#canvas").replaceWith(canvas);
  $("#marks").replaceChildren();
  const row = state.results[state.selected];
  if (row?.page !== state.page) return;
  const positions =
    row.position === undefined ? (row.candidates ?? []) : [row.position];
  for (const index of positions) {
    const item = items[index];
    const [, , , height, x, y] = item.transform;
    const [left, top] = viewport.convertToViewportPoint(x - 1, y + height);
    const mark = element("span", undefined, "mark");
    mark.style.left = (100 * left) / viewport.width + "%";
    mark.style.top = (100 * top) / viewport.height + "%";
    mark.style.width =
      (100 * (item.width + 2) * viewport.scale) / viewport.width + "%";
    mark.style.height = (130 * height * viewport.scale) / viewport.height + "%";
    $("#marks").append(mark);
  }
}

function previewSafely() {
  preview().catch(showError);
}

function linkDownload(selector, data, type, name) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  state.urls.push(url);
  $(selector).href = url;
  $(selector).download = name;
}

$("#continue").addEventListener("click", () =>
  work("Reading your files in this tab…", async () => {
    const [pdf, csv] = await Promise.all([
      state.files.pdf.arrayBuffer(),
      state.files.csv.text(),
    ]);
    await load(new Uint8Array(pdf), csv, state.files.pdf.name);
  }),
);
$("#example").addEventListener("click", () =>
  work("Opening the built-in example…", async () => {
    const files = await Promise.all(
      ["example-catalog.pdf", "price-template.csv"].map((name) =>
        fetch("./assets/" + name),
      ),
    );
    if (files.some((file) => !file.ok))
      throw new Error("The example files could not be loaded.");
    await load(
      new Uint8Array(await files[0].arrayBuffer()),
      await files[1].text(),
      "example-catalog.pdf",
    );
  }),
);
$("#back-files").addEventListener("click", () => go("files"));
$("#back-map").addEventListener("click", () => go("mapping"));
$("#check").addEventListener("click", () => checkRows(true));
$("#recheck").addEventListener("click", () => checkRows());
$("#flagged").addEventListener("change", renderRows);
$("#page").addEventListener("change", () => {
  state.page = Number($("#page").value);
  previewSafely();
});
$("#zoom").addEventListener("change", () => {
  $("#page-frame").style.width = 100 * Number($("#zoom").value) + "%";
});
$("#verify").addEventListener("click", () =>
  work("Preparing the edited PDF…", async () => {
    if (state.dirty) return;
    const result = await exportPDF(
      state.bytes,
      state.pages,
      state.results,
      (page, total) => {
        $("#busy").textContent = `Verifying page ${page} of ${total}…`;
      },
    );
    const basename = state.filename.replace(/\.pdf$/i, "");
    linkDownload(
      "#pdf-download",
      result,
      "application/pdf",
      basename + "-updated.pdf",
    );
    const rows = state.results.map(({ sku, old, next, page }) => ({
      sku,
      old_price: old,
      new_price: next,
      page: page + 1,
    }));
    linkDownload(
      "#report-download",
      globalThis.Papa.unparse(rows, { escapeFormulae: true }),
      "text/csv;charset=utf-8",
      basename + "-changes.csv",
    );
    $("#result-summary").textContent =
      `${rows.length} verified ${rows.length === 1 ? "change" : "changes"} across ${state.pages.length} ${state.pages.length === 1 ? "page" : "pages"}.`;
    go("done");
  }),
);
$("#reset").addEventListener("click", () =>
  work("Clearing this workspace…", async () => {
    previewSequence++;
    await state.pdf?.loadingTask.destroy();
    for (const url of state.urls) URL.revokeObjectURL(url);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, {
      files: {},
      urls: [],
      choices: new Map(),
      busy: true,
      selected: 0,
      page: 0,
    });
    $("#changes").replaceChildren();
    $("#csv-preview").replaceChildren();
    $("#mapping-fields").replaceChildren();
    $("#marks").replaceChildren();
    $("#canvas").width = $("#canvas").height = 0;
    $("#row-detail").replaceChildren();
    $("#result-summary").textContent = "";
    for (const selector of ["#pdf-download", "#report-download"]) {
      $(selector).removeAttribute("href");
      $(selector).removeAttribute("download");
    }
    $("#zoom").value = "1";
    $("#page-frame").style.width = "100%";
    for (const kind of ["pdf", "csv"]) {
      $("#" + kind + "-input").value = "";
      $("#" + kind + "-name").textContent = "Drop a file or click to choose";
      $("#" + kind + "-drop").classList.remove("chosen");
    }
    $("#continue").disabled = true;
    $("#reset").hidden = true;
    go("files");
  }),
);
