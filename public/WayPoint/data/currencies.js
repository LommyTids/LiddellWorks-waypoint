// Waypoint — currency suggestion list.
//
// Used by the "currency" field type (see fieldHtml() in index.html) to
// populate the <datalist id="currency-list"> that suggests values while
// typing a "Home currency" / "Cost currency" field. It's just a plain
// array of ISO-ish currency codes — nothing here is loaded or computed,
// so any 3-letter code someone types (even one not in this list) is
// still accepted and saved exactly as typed.
//
// Split out of index.html into its own file (alongside timezones.js,
// countries.js, cities.js, airports.js) purely to keep index.html
// smaller — some editors/upload tools choke on very large single files.
// Loaded via <script src="/WayPoint/data/currencies.js"> before the main
// inline script in index.html, so COMMON_CURRENCIES is a plain global by
// the time the app code runs.
var COMMON_CURRENCIES = ['GBP','USD','EUR','JPY','AUD','CAD','CHF','CNY','HKD',
  'NZD','SGD','THB','VND','INR','MXN','ZAR','AED','TRY','KRW','IDR','MYR',
  'PHP','BRL','SEK','NOK','DKK','PLN','CZK','HUF','EGP','MAD'];
