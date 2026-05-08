import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8080);
const amdCloseCache = new Map();
const marketDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (url.pathname === "/api/amd-close") {
    await handleAmdClose(url, response);
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = normalize(requested)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const path = join(root, normalized);

  if (!path.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": types[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ACB calculator running at http://localhost:${port}`);
});

async function handleAmdClose(url, response) {
  const date = url.searchParams.get("date") || "";
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    sendJson(response, 400, { error: "Provide date as YYYY-MM-DD." });
    return;
  }

  const cacheKey = date || "latest";
  if (amdCloseCache.has(cacheKey)) {
    sendJson(response, 200, amdCloseCache.get(cacheKey));
    return;
  }

  try {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const period1 = unixSeconds(addDays(targetDate, date ? -14 : -30));
    const period2 = unixSeconds(addDays(targetDate, 1));
    const apiUrl = new URL("https://query1.finance.yahoo.com/v8/finance/chart/AMD");
    apiUrl.searchParams.set("period1", String(period1));
    apiUrl.searchParams.set("period2", String(period2));
    apiUrl.searchParams.set("interval", "1d");
    apiUrl.searchParams.set("events", "history");

    const upstream = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 AMD ACB calculator"
      }
    });

    if (!upstream.ok) {
      sendJson(response, 502, { error: `Historical price source returned ${upstream.status}.` });
      return;
    }

    const payload = await upstream.json();
    const result = payload?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] || {};
    const closes = quote.close || [];
    const rows = timestamps
      .map((seconds, index) => ({
        date: formatMarketDate(seconds * 1000),
        close: Number(closes[index])
      }))
      .filter((row) => !date || row.date <= date && Number.isFinite(row.close))
      .sort((a, b) => a.date.localeCompare(b.date));

    const row = rows.at(-1);
    if (!row) {
      sendJson(response, 404, { error: date ? `No AMD close found on or before ${date}.` : "No AMD close found." });
      return;
    }

    const resultPayload = {
      symbol: "AMD",
      requestedDate: date || null,
      priceDate: row.date,
      close: Number(row.close.toFixed(4)),
      currency: result?.meta?.currency || "USD",
      source: "Yahoo Finance",
      exactDate: date ? row.date === date : false
    };
    amdCloseCache.set(cacheKey, resultPayload);
    sendJson(response, 200, resultPayload);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Could not fetch AMD close." });
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function unixSeconds(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

function addDays(dateString, amount) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatMarketDate(timestamp) {
  const parts = Object.fromEntries(
    marketDateFormatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
