# AMD E*TRADE ACB Calculator

A local browser tool for tracking Canadian adjusted cost base for AMD ESPP purchases, RSU vests, and E*TRADE share sales.

## Run

Open `index.html` directly, or serve the folder locally:

```powershell
node server.mjs
```

Then visit `http://localhost:8080`.

## Notes

- RSU vests and ESPP purchases add to the same symbol-level ACB pool.
- Sales remove the average ACB per share immediately before the sale.
- Future acquisitions blend into the remaining pool.
- The account value chart shows the estimated CAD value of shares held after each transaction, using that transaction's FMV or sale price as the valuation point.
- When you change a transaction date, the app asks the local server for AMD's historical closing price and fills the relevant FMV or sale price field. If the market was closed, it uses the latest available close on or before that date.
- FX rates are fetched from the Bank of Canada Valet API. For weekends and holidays, the app uses the latest available business-day rate on or before the transaction date.
- Use the FX override field when you need a specific rate or a currency/date that is not available.

This is a planning and recordkeeping tool, not tax advice.
