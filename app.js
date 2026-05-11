const STORAGE_KEY = "amd-etrade-acb-tool.transactions.v1";
const FX_CACHE_KEY = "amd-etrade-acb-tool.fx-cache.v1";
const DEFAULT_SYMBOL = "AMD";
const supportedCurrencies = ["CAD", "USD", "EUR", "GBP", "AUD", "CHF", "JPY"];

const money = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const usdMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function formatUSD(amount) {
  return usdMoney.format(amount).replace('$', 'US$');
}

const number = new Intl.NumberFormat("en-CA", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 6
});

let transactions = loadTransactions();
let fxCache = loadFxCache();
let toastTimer = null;
let currentPrice = null;

const elements = {
  rsuForm: document.getElementById("rsuForm"),
  esppForm: document.getElementById("esppForm"),
  saleForm: document.getElementById("saleForm"),
  ledgerBody: document.getElementById("ledgerBody"),
  transactionBody: document.getElementById("transactionBody"),
  summaryStrip: document.getElementById("summaryStrip"),
  valueChart: document.getElementById("valueChart"),
  symbolFilter: document.getElementById("symbolFilter"),
  refreshFxBtn: document.getElementById("refreshFxBtn"),
  saveCsvBtn: document.getElementById("saveCsvBtn"),
  sampleBtn: document.getElementById("sampleBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  exportBtn: document.getElementById("exportBtn"),
  clearBtn: document.getElementById("clearBtn"),
  toast: document.getElementById("toast")
};

init();

async function init() {
  setDefaultDates();
  await fetchCurrentPrice();
  setupClosingPriceLookup(elements.rsuForm, "fmv", "rsu");
  setupClosingPriceLookup(elements.esppForm, "fmv", "espp");
  elements.rsuForm.addEventListener("submit", handleRsuSubmit);
  elements.esppForm.addEventListener("submit", handleEsppSubmit);
  elements.saleForm.addEventListener("submit", handleSaleSubmit);
  elements.refreshFxBtn.addEventListener("click", refreshAllFx);
  elements.saveCsvBtn.addEventListener("click", exportLedgerCsv);
  elements.symbolFilter.addEventListener("change", render);
  elements.sampleBtn.addEventListener("click", loadSampleData);
  elements.importBtn.addEventListener("click", () => elements.importFile.click());
  elements.importFile.addEventListener("change", importJson);
  elements.exportBtn.addEventListener("click", exportJson);
  elements.clearBtn.addEventListener("click", clearTransactions);
  render();
}

function setDefaultDates() {
  const today = formatLocalDate(new Date());
  [elements.rsuForm, elements.esppForm, elements.saleForm].forEach((form) => {
    form.elements.date.value = today;
    if (!form.elements.symbol.value) {
      form.elements.symbol.value = DEFAULT_SYMBOL;
    }
  });
}

function setupClosingPriceLookup(form, priceFieldName, statusKey) {
  const dateInput = form.elements.date;
  const symbolInput = form.elements.symbol;
  const currencyInput = form.elements.currency;
  const priceInput = form.elements[priceFieldName];
  const status = form.querySelector(`[data-price-status="${statusKey}"]`);

  priceInput.addEventListener("input", () => {
    priceInput.dataset.touched = "true";
  });

  dateInput.addEventListener("change", () => {
    populateClosingPrice({ form, dateInput, symbolInput, currencyInput, priceInput, status });
  });

  symbolInput.addEventListener("change", () => {
    if (normalizeSymbol(symbolInput.value) === DEFAULT_SYMBOL && dateInput.value) {
      populateClosingPrice({ form, dateInput, symbolInput, currencyInput, priceInput, status });
    }
  });
}

async function populateClosingPrice({ form, dateInput, symbolInput, currencyInput, priceInput, status }) {
  const date = dateInput.value;
  const symbol = normalizeSymbol(symbolInput.value);
  if (!date || symbol !== DEFAULT_SYMBOL) {
    setPriceStatus(status, "AMD-only price lookup.", "muted");
    return;
  }
  if (currencyInput.value !== "USD") {
    setPriceStatus(status, "Auto close is USD; switch currency to USD to fill.", "warning");
    return;
  }
  if (priceInput.dataset.touched === "true" && priceInput.value.trim() !== "" && priceInput.value.trim() !== priceInput.dataset.autoValue) {
    setPriceStatus(status, "Manual price kept.", "muted");
    return;
  }

  const requestId = crypto.randomUUID();
  form.dataset.priceLookupRequest = requestId;
  setPriceStatus(status, "Looking up AMD close...", "loading");

  try {
    const response = await fetch(`/api/amd-close?date=${encodeURIComponent(date)}`);
    const payload = await response.json();
    if (form.dataset.priceLookupRequest !== requestId) return;
    if (!response.ok) {
      throw new Error(payload.error || "Could not fetch AMD close.");
    }

    const close = Number(payload.close).toFixed(2);
    priceInput.value = close;
    priceInput.dataset.autoValue = close;
    priceInput.dataset.touched = "false";
    const dateNote = payload.exactDate ? payload.priceDate : `${payload.priceDate} close`;
    setPriceStatus(status, `${dateNote}: ${formatForeign(payload.close, payload.currency)} from ${payload.source}.`, "success");
  } catch (error) {
    setPriceStatus(status, error.message || "Could not fetch AMD close.", "warning");
  }
}

function setPriceStatus(status, message, tone) {
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

async function fetchCurrentPrice() {
  try {
    const response = await fetch('/api/amd-close');
    const payload = await response.json();
    if (response.ok) {
      currentPrice = payload.close;
    } else {
      console.warn('Could not fetch current AMD price:', payload.error);
    }
  } catch (error) {
    console.warn('Error fetching current AMD price:', error);
  }
}

async function handleRsuSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = readForm(form);
  const tx = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    kind: "RSU",
    action: "ACQUIRE",
    date: data.date,
    symbol: normalizeSymbol(data.symbol),
    currency: data.currency,
    shares: toNumber(data.shares),
    fmv: toNumber(data.fmv),
    fees: toNumber(data.fees),
    notes: data.notes.trim()
  };
  await addTransactionWithFx(tx, data.fxRate, form);
}

async function handleEsppSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = readForm(form);
  const tx = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    kind: "ESPP",
    action: "ACQUIRE",
    date: data.date,
    symbol: normalizeSymbol(data.symbol),
    currency: data.currency,
    shares: toNumber(data.shares),
    employeePrice: toNumber(data.employeePrice),
    fmv: toNumber(data.fmv),
    fees: toNumber(data.fees),
    notes: data.notes.trim()
  };
  await addTransactionWithFx(tx, data.fxRate, form);
}

async function handleSaleSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = readForm(form);
  const tx = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    kind: "Sale",
    action: "SELL",
    date: data.date,
    symbol: normalizeSymbol(data.symbol),
    currency: data.currency,
    shares: toNumber(data.shares),
    salePrice: toNumber(data.salePrice),
    fees: toNumber(data.fees),
    lotLabel: data.lotLabel.trim(),
    notes: data.notes.trim()
  };
  await addTransactionWithFx(tx, data.fxRate, form);
}

async function addTransactionWithFx(tx, manualRate, form) {
  if (!validateTransaction(tx)) return;

  const submit = form.querySelector("button[type='submit']");
  submit.disabled = true;
  const previousText = submit.textContent;
  submit.textContent = "Fetching FX...";

  try {
    const fx = await resolveFxRate(tx.currency, tx.date, manualRate);
    transactions.push({ ...tx, ...fx });
    saveTransactions();
    form.reset();
    setDefaultDates();
    syncSymbolDefaults(tx.symbol, tx.currency);
    render();
    showToast(`${tx.kind} ${tx.action === "SELL" ? "sale" : "entry"} added.`);
  } catch (error) {
    showToast(error.message || "Could not fetch exchange rate. Add an FX override and try again.");
  } finally {
    submit.disabled = false;
    submit.textContent = previousText;
  }
}

function validateTransaction(tx) {
  if (!tx.date || !tx.symbol || !tx.currency) {
    showToast("Date, symbol, and currency are required.");
    return false;
  }
  if (!supportedCurrencies.includes(tx.currency)) {
    showToast(`${tx.currency} is not supported yet.`);
    return false;
  }
  if (!Number.isFinite(tx.shares) || tx.shares <= 0) {
    showToast("Shares must be greater than zero.");
    return false;
  }
  const price = tx.action === "SELL" ? tx.salePrice : tx.fmv;
  if (!Number.isFinite(price) || price < 0) {
    showToast("Price must be zero or greater.");
    return false;
  }
  if (tx.kind === "ESPP" && tx.employeePrice > tx.fmv) {
    showToast("ESPP employee price is higher than FMV. Check the entry or use RSU/custom data.");
    return false;
  }
  return true;
}

function readForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function normalizeSymbol(symbol) {
  return symbol.trim().toUpperCase();
}

function toNumber(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const normalized = String(value).trim().replace(/,/g, "").replace(/[^\d.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function resolveFxRate(currency, date, manualRate, options = {}) {
  const rate = toNumber(manualRate);
  if (rate > 0) {
    return {
      fxRate: rate,
      fxDate: date,
      fxSource: "Manual"
    };
  }

  if (currency === "CAD") {
    return {
      fxRate: 1,
      fxDate: date,
      fxSource: "CAD"
    };
  }

  const cacheKey = `${currency}|${date}`;
  if (!options.bypassCache && fxCache[cacheKey]) {
    return fxCache[cacheKey];
  }

  const series = `FX${currency}CAD`;
  const startDate = addDays(date, -7);
  const url = `https://www.bankofcanada.ca/valet/observations/${series}/json?start_date=${startDate}&end_date=${date}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Bank of Canada returned ${response.status} for ${currency}.`);
  }
  const payload = await response.json();
  const observations = Array.isArray(payload.observations) ? payload.observations : [];
  const observation = observations
    .filter((item) => item?.[series]?.v)
    .sort((a, b) => a.d.localeCompare(b.d))
    .pop();

  if (!observation) {
    throw new Error(`No Bank of Canada rate found for ${currency} on or before ${date}.`);
  }

  const resolved = {
    fxRate: Number(observation[series].v),
    fxDate: observation.d,
    fxSource: "Bank of Canada"
  };
  fxCache[cacheKey] = resolved;
  saveFxCache();
  return resolved;
}

async function refreshAllFx() {
  const candidates = transactions.filter((tx) => tx.currency !== "CAD" && tx.fxSource !== "Manual");
  if (!candidates.length) {
    showToast("No automatic FX entries to refresh.");
    return;
  }

  elements.refreshFxBtn.disabled = true;
  elements.refreshFxBtn.textContent = "Refreshing...";
  try {
    for (const tx of candidates) {
      const fx = await resolveFxRate(tx.currency, tx.date, "", { bypassCache: true });
      Object.assign(tx, fx);
    }
    saveTransactions();
    render();
    showToast("FX rates refreshed.");
  } catch (error) {
    showToast(error.message || "Could not refresh FX rates.");
  } finally {
    elements.refreshFxBtn.disabled = false;
    elements.refreshFxBtn.textContent = "Refresh FX";
  }
}

function buildLedger(allTransactions) {
  const sorted = [...allTransactions].sort(compareTransactions);
  const states = new Map();
  const rows = [];

  sorted.forEach((tx) => {
    const state = states.get(tx.symbol) || { symbol: tx.symbol, shares: 0, acb: 0, realized: 0 };
    const beforeShares = state.shares;
    const beforeAcb = state.acb;
    const beforeAvg = beforeShares > 0 ? beforeAcb / beforeShares : 0;
    let cadAmount = 0;
    let acbChange = 0;
    let gainLoss = null;
    let status = "ok";
    let statusText = "";
    let valuationPriceCad = 0;

    if (tx.action === "ACQUIRE") {
      valuationPriceCad = tx.fmv * tx.fxRate;
      const cost = tx.shares * tx.fmv * tx.fxRate;
      const fees = tx.fees * tx.fxRate;
      cadAmount = cost + fees;
      acbChange = cadAmount;
      state.shares += tx.shares;
      state.acb += acbChange;
    } else {
      valuationPriceCad = tx.salePrice * tx.fxRate;
      const grossProceeds = tx.shares * tx.salePrice * tx.fxRate;
      const fees = tx.fees * tx.fxRate;
      cadAmount = grossProceeds - fees;

      if (tx.shares > state.shares + 0.0000001) {
        status = "error";
        statusText = `Sale exceeds available shares (${formatQuantity(state.shares)}).`;
        acbChange = 0;
        gainLoss = null;
      } else {
        acbChange = -(tx.shares * beforeAvg);
        gainLoss = cadAmount + acbChange;
        state.shares -= tx.shares;
        state.acb += acbChange;
        state.realized += gainLoss;
        if (Math.abs(state.shares) < 0.0000001) {
          state.shares = 0;
          state.acb = 0;
        }
      }
    }

    const afterAvg = state.shares > 0 ? state.acb / state.shares : 0;
    const marketValueAfter = state.shares * valuationPriceCad;
    rows.push({
      tx,
      beforeShares,
      beforeAcb,
      beforeAvg,
      usdAmount: tx.action === "ACQUIRE" ? tx.shares * tx.fmv + tx.fees : tx.shares * tx.salePrice - tx.fees,
      usdPerShare: tx.action === "ACQUIRE" ? tx.fmv : tx.salePrice,
      cadAmount,
      acbChange,
      gainLoss,
      afterShares: state.shares,
      afterAcb: state.acb,
      afterAvg,
      valuationPriceCad,
      marketValueAfter,
      status,
      statusText
    });
    states.set(tx.symbol, state);
  });

  return {
    rows,
    summaries: [...states.values()].sort((a, b) => a.symbol.localeCompare(b.symbol))
  };
}

function compareTransactions(a, b) {
  const byDate = a.date.localeCompare(b.date);
  if (byDate !== 0) return byDate;
  return a.createdAt - b.createdAt;
}

function render() {
  renderSymbolFilter();
  const filter = elements.symbolFilter.value || "ALL";
  const ledger = buildLedger(transactions);
  const rows = filter === "ALL" ? ledger.rows : ledger.rows.filter((row) => row.tx.symbol === filter);
  renderSummaries(ledger.summaries, filter);
  renderValueChart(rows, filter);
  renderLedger(rows);
  renderTransactions(filter);
}

function renderSymbolFilter() {
  const current = elements.symbolFilter.value || "ALL";
  const symbols = [...new Set(transactions.map((tx) => tx.symbol))].sort();
  elements.symbolFilter.innerHTML = "";
  elements.symbolFilter.append(new Option("All", "ALL"));
  symbols.forEach((symbol) => elements.symbolFilter.append(new Option(symbol, symbol)));
  elements.symbolFilter.value = symbols.includes(current) ? current : "ALL";
}

function renderSummaries(summaries, filter) {
  const visible = filter === "ALL" ? summaries : summaries.filter((item) => item.symbol === filter);
  if (!visible.length) {
    elements.summaryStrip.innerHTML = `
      <div class="summary-card">
        <h3>No transactions yet</h3>
        <p class="muted">Add an RSU vest, ESPP purchase, or sale to start the ACB pool.</p>
      </div>
    `;
    return;
  }

  elements.summaryStrip.innerHTML = visible.map((item) => {
    const avg = item.shares > 0 ? item.acb / item.shares : 0;
    const unrealized = currentPrice && item.shares > 0 ? (currentPrice * item.shares) - item.acb : 0;
    return `
      <article class="summary-card">
        <h3>${escapeHtml(item.symbol)}</h3>
        <div class="summary-metrics">
          <div><span>Shares held</span><strong>${formatQuantity(item.shares)}</strong></div>
          <div><span>Total ACB</span><strong>${money.format(item.acb)}</strong></div>
          <div><span>ACB / share</span><strong>${money.format(avg)}</strong></div>
          <div><span>Unrealized gain/loss</span><strong class="${unrealized >= 0 ? "gain" : "loss"}">${money.format(unrealized)}</strong></div>
          <div><span>Realized gain/loss</span><strong class="${item.realized >= 0 ? "gain" : "loss"}">${money.format(item.realized)}</strong></div>
        </div>
      </article>
    `;
  }).join("");
}

function renderValueChart(rows, filter) {
  const points = buildValueChartPoints(rows, filter);
  if (!points.length) {
    elements.valueChart.innerHTML = `
      <div class="chart-empty">
        <strong>No account value yet</strong>
        <span>Add an AMD RSU vest, ESPP purchase, or sale to plot the running value.</span>
      </div>
    `;
    return;
  }

  const width = 960;
  const height = 280;
  const pad = { top: 24, right: 28, bottom: 46, left: 82 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const maxValue = Math.max(...points.map((point) => point.value), 1);
  const minValue = Math.min(...points.map((point) => point.value), 0);
  const valueSpan = Math.max(maxValue - minValue, 1);
  const xFor = (index) => points.length === 1
    ? pad.left + chartWidth / 2
    : pad.left + (index / (points.length - 1)) * chartWidth;
  const yFor = (value) => pad.top + chartHeight - ((value - minValue) / valueSpan) * chartHeight;
  const plotted = points.map((point, index) => ({
    ...point,
    x: xFor(index),
    y: yFor(point.value)
  }));
  const linePath = plotted.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L ${plotted[plotted.length - 1].x.toFixed(2)} ${height - pad.bottom} L ${plotted[0].x.toFixed(2)} ${height - pad.bottom} Z`;
  const yTicks = createTicks(minValue, maxValue, 4);
  const xLabels = chooseXLabels(plotted);
  const latest = points[points.length - 1];
  const peak = points.reduce((best, point) => point.value > best.value ? point : best, points[0]);

  elements.valueChart.innerHTML = `
    <div class="chart-kpis">
      <div><span>Latest value</span><strong>${money.format(latest.value)}</strong></div>
      <div><span>Latest shares held</span><strong>${formatQuantity(latest.shares)}</strong></div>
      <div><span>Peak value</span><strong>${money.format(peak.value)}</strong></div>
    </div>
    <svg class="value-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Total CAD ACB pool value over time">
      ${yTicks.map((tick) => {
        const y = yFor(tick);
        return `
          <line class="grid-line" x1="${pad.left}" y1="${y.toFixed(2)}" x2="${width - pad.right}" y2="${y.toFixed(2)}"></line>
          <text class="axis-label y-label" x="${pad.left - 10}" y="${(y + 4).toFixed(2)}">${escapeHtml(formatCompactMoney(tick))}</text>
        `;
      }).join("")}
      <path class="value-area" d="${areaPath}"></path>
      <path class="value-line" d="${linePath}"></path>
      ${plotted.map((point) => `
        <circle class="value-dot ${point.kind.toLowerCase()}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="5">
          <title>${escapeHtml(point.date)} | ${escapeHtml(point.kind)} | ${money.format(point.value)} | ${formatQuantity(point.shares)} shares</title>
        </circle>
      `).join("")}
      ${xLabels.map((point) => `
        <text class="axis-label x-label" x="${point.x.toFixed(2)}" y="${height - 18}">${escapeHtml(point.date)}</text>
      `).join("")}
      <line class="axis-line" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
      <line class="axis-line" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}"></line>
    </svg>
    <p class="chart-caption">Shows the total CAD ACB pool value after each transaction, using the transaction valuation price and not live AMD market prices.</p>
  `;
}

function buildValueChartPoints(rows, filter) {
  const valuesBySymbol = new Map();
  return rows
    .filter((row) => row.status === "ok")
    .map((row) => {
      valuesBySymbol.set(row.tx.symbol, row.afterAcb);
      return {
        date: row.tx.date,
        kind: row.tx.kind,
        symbol: row.tx.symbol,
        shares: row.afterShares,
        value: filter === "ALL"
          ? [...valuesBySymbol.values()].reduce((sum, value) => sum + value, 0)
          : row.afterAcb
      };
    });
}

function createTicks(minValue, maxValue, count) {
  if (maxValue <= 0) return [0];
  const span = Math.max(maxValue - minValue, 1);
  const step = span / Math.max(count - 1, 1);
  return Array.from({ length: count }, (_, index) => minValue + step * index);
}

function chooseXLabels(points) {
  if (points.length <= 4) return points;
  const indexes = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
  return [...indexes].sort((a, b) => a - b).map((index) => points[index]);
}

function formatCompactMoney(value) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return money.format(value);
}

function renderLedger(rows) {
  if (!rows.length) {
    elements.ledgerBody.innerHTML = `<tr><td class="empty" colspan="17">No ledger rows for this filter.</td></tr>`;
    return;
  }

  elements.ledgerBody.innerHTML = rows.map((row) => {
    const tx = row.tx;
    const sourceClass = tx.kind === "RSU" ? "rsu" : tx.kind === "ESPP" ? "espp" : "sale";
    const gain = row.gainLoss === null ? "" : money.format(row.gainLoss);
    const gainClass = row.gainLoss === null ? "" : row.gainLoss >= 0 ? "gain" : "loss";
    const status = row.status === "error" ? `<div class="pill error">${escapeHtml(row.statusText)}</div>` : "";
    return `
      <tr class="${row.status === "error" ? "error-row" : ""}">
        <td>${escapeHtml(tx.date)}</td>
        <td>${escapeHtml(tx.symbol)}</td>
        <td><span class="pill ${sourceClass}">${escapeHtml(tx.kind)}</span></td>
        <td>${tx.action === "SELL" ? "Sell" : "Acquire"}${status}</td>
        <td class="num">${formatQuantity(tx.shares)}</td>
        <td class="num">${formatFx(tx)}</td>
        <td class="num">${formatUSD(row.usdAmount)}</td>
        <td class="num">${money.format(row.cadAmount)}</td>
        <td class="num">${formatUSD(row.usdPerShare)}</td>
        <td class="num">${money.format(row.beforeAcb)}</td>
        <td class="num">${money.format(row.beforeAvg)}</td>
        <td class="num">${money.format(row.acbChange)}</td>
        <td class="num ${gainClass}">${gain}</td>
        <td class="num">${formatQuantity(row.afterShares)}</td>
        <td class="num">${money.format(row.afterAcb)}</td>
        <td class="num highlight-col">${row.afterShares > 0 ? money.format(row.afterAcb / row.afterShares) : ''}</td>
        <td></td>
      </tr>
    `;
  }).join("");
}

function renderTransactions(filter) {
  const visible = [...transactions]
    .filter((tx) => filter === "ALL" || tx.symbol === filter)
    .sort(compareTransactions);

  if (!visible.length) {
    elements.transactionBody.innerHTML = `<tr><td class="empty" colspan="10">No transactions for this filter.</td></tr>`;
    return;
  }

  elements.transactionBody.innerHTML = visible.map((tx) => {
    const price = tx.action === "SELL" ? tx.salePrice : tx.fmv;
    const noteParts = [tx.notes, tx.lotLabel ? `Lot: ${tx.lotLabel}` : ""].filter(Boolean);
    return `
      <tr>
        <td>${escapeHtml(tx.date)}</td>
        <td>${escapeHtml(tx.symbol)}</td>
        <td>${escapeHtml(tx.kind)}</td>
        <td class="num">${formatQuantity(tx.shares)}</td>
        <td class="num">${formatForeign(price, tx.currency)}</td>
        <td class="num">${formatForeign(tx.fees, tx.currency)}</td>
        <td class="num">${formatFx(tx)}</td>
        <td>${escapeHtml(tx.fxSource)}${tx.fxDate && tx.fxDate !== tx.date ? `<br><span class="muted">${escapeHtml(tx.fxDate)}</span>` : ""}</td>
        <td>${escapeHtml(noteParts.join(" | "))}</td>
        <td><button class="secondary icon-button" type="button" title="Delete transaction" aria-label="Delete transaction" data-delete="${tx.id}">x</button></td>
      </tr>
    `;
  }).join("");

  elements.transactionBody.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      transactions = transactions.filter((tx) => tx.id !== button.dataset.delete);
      saveTransactions();
      render();
      showToast("Transaction deleted.");
    });
  });
}

function syncSymbolDefaults(symbol, currency) {
  [elements.rsuForm, elements.esppForm, elements.saleForm].forEach((form) => {
    form.elements.symbol.value = symbol;
    form.elements.currency.value = currency;
  });
}

function formatFx(tx) {
  if (!Number.isFinite(tx.fxRate)) return "";
  const suffix = tx.fxDate && tx.fxDate !== tx.date ? ` (${tx.fxDate})` : "";
  return `${tx.fxRate.toFixed(4)}${suffix}`;
}

function formatQuantity(value) {
  return number.format(roundSmall(value));
}

function formatForeign(value, currency) {
  const formatter = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  });
  return formatter.format(value || 0);
}

function roundSmall(value) {
  return Math.abs(value) < 0.0000001 ? 0 : value;
}

function addDays(dateString, amount) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return formatDate(date);
}

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function saveTransactions() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
}

function loadTransactions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFxCache() {
  localStorage.setItem(FX_CACHE_KEY, JSON.stringify(fxCache));
}

function loadFxCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadSampleData() {
  if (transactions.length && !confirm("Replace current transactions with sample data?")) return;
  transactions = [
    {
      id: crypto.randomUUID(),
      createdAt: 1,
      kind: "RSU",
      action: "ACQUIRE",
      date: "2025-01-15",
      symbol: DEFAULT_SYMBOL,
      currency: "USD",
      shares: 100,
      fmv: 120,
      fees: 0,
      fxRate: 1.44,
      fxDate: "2025-01-15",
      fxSource: "Manual",
      notes: "Sample AMD RSU vest"
    },
    {
      id: crypto.randomUUID(),
      createdAt: 2,
      kind: "ESPP",
      action: "ACQUIRE",
      date: "2025-03-31",
      symbol: DEFAULT_SYMBOL,
      currency: "USD",
      shares: 50,
      employeePrice: 102,
      fmv: 120,
      fees: 0,
      fxRate: 1.43,
      fxDate: "2025-03-31",
      fxSource: "Manual",
      notes: "Sample AMD ESPP purchase"
    },
    {
      id: crypto.randomUUID(),
      createdAt: 3,
      kind: "Sale",
      action: "SELL",
      date: "2025-04-15",
      symbol: DEFAULT_SYMBOL,
      currency: "USD",
      shares: 60,
      salePrice: 132,
      fees: 5,
      lotLabel: "E*TRADE sample",
      fxRate: 1.39,
      fxDate: "2025-04-15",
      fxSource: "Manual",
      notes: "Sample E*TRADE sale"
    },
    {
      id: crypto.randomUUID(),
      createdAt: 4,
      kind: "RSU",
      action: "ACQUIRE",
      date: "2025-06-15",
      symbol: DEFAULT_SYMBOL,
      currency: "USD",
      shares: 40,
      fmv: 118,
      fees: 0,
      fxRate: 1.36,
      fxDate: "2025-06-15",
      fxSource: "Manual",
      notes: "Sample later AMD lot"
    }
  ];
  saveTransactions();
  syncSymbolDefaults(DEFAULT_SYMBOL, "USD");
  render();
  showToast("Sample data loaded.");
}

function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    transactions
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `acb-transactions-${formatLocalDate(new Date())}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportLedgerCsv() {
  const filter = elements.symbolFilter.value || "ALL";
  const ledger = buildLedger(transactions);
  const rows = filter === "ALL" ? ledger.rows : ledger.rows.filter((row) => row.tx.symbol === filter);
  if (!rows.length) {
    showToast("No ledger rows to export.");
    return;
  }

  const headers = [
    "Date",
    "Symbol",
    "Source",
    "Action",
    "Shares",
    "FX",
    "USD amount",
    "CAD amount",
    "$US per share",
    "Total ACB Pool before",
    "ACB/share before",
    "ACB Pool change",
    "Gain/loss",
    "Shares after",
    "Total ACB Pool after",
    "ACB/share after"
  ];

  const csvRows = rows.map((row) => {
    const tx = row.tx;
    const source = tx.kind;
    const action = tx.action === "SELL" ? "Sell" : "Acquire";
    const gain = row.gainLoss === null ? "" : money.format(row.gainLoss);
    return [
      tx.date,
      tx.symbol,
      source,
      action,
      formatQuantity(tx.shares),
      formatFx(tx),
      formatUSD(row.usdAmount),
      money.format(row.cadAmount),
      formatUSD(row.usdPerShare),
      money.format(row.beforeAcb),
      money.format(row.beforeAvg),
      money.format(row.acbChange),
      gain,
      formatQuantity(row.afterShares),
      money.format(row.afterAcb),
      row.afterShares > 0 ? money.format(row.afterAcb / row.afterShares) : ""
    ].map(csvEscapeCell).join(",");
  });

  const csvContent = `\uFEFF${headers.map(csvEscapeCell).join(",")}\n${csvRows.join("\n")}`;
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `acb-ledger-${formatLocalDate(new Date())}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvEscapeCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function importJson(event) {
  const [file] = event.target.files;
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const parsed = JSON.parse(reader.result);
      const imported = Array.isArray(parsed) ? parsed : parsed.transactions;
      if (!Array.isArray(imported)) throw new Error("JSON must contain a transactions array.");
      transactions = imported.map(normalizeImportedTransaction);
      saveTransactions();
      render();
      showToast("Transactions imported.");
    } catch (error) {
      showToast(error.message || "Could not import JSON.");
    } finally {
      elements.importFile.value = "";
    }
  });
  reader.readAsText(file);
}

function normalizeImportedTransaction(tx, index) {
  return {
    id: tx.id || crypto.randomUUID(),
    createdAt: Number.isFinite(tx.createdAt) ? tx.createdAt : Date.now() + index,
    kind: tx.kind,
    action: tx.action,
    date: tx.date,
    symbol: normalizeSymbol(tx.symbol || ""),
    currency: tx.currency || "USD",
    shares: toNumber(tx.shares),
    fmv: toNumber(tx.fmv),
    employeePrice: toNumber(tx.employeePrice),
    salePrice: toNumber(tx.salePrice),
    fees: toNumber(tx.fees),
    lotLabel: tx.lotLabel || "",
    notes: tx.notes || "",
    fxRate: toNumber(tx.fxRate),
    fxDate: tx.fxDate || tx.date,
    fxSource: tx.fxSource || "Imported"
  };
}

function clearTransactions() {
  if (!transactions.length) {
    showToast("There is nothing to clear.");
    return;
  }
  if (!confirm("Clear all transactions?")) return;
  transactions = [];
  saveTransactions();
  render();
  showToast("Transactions cleared.");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3600);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
