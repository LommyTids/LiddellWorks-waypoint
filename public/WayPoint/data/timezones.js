// Waypoint — timezone suggestion list.
//
// A curated set of IANA timezone names covering common travel
// destinations. The destination form's "Timezone" field (type
// 'timezone' in fieldHtml()) offers these as <datalist> suggestions but
// still accepts any free-text value typed in — this isn't a validated
// or exhaustive list of every IANA zone, just a helpful shortlist.
//
// Split out of index.html into its own file — see the comment at the
// top of currencies.js in this same folder for why. Loaded via
// <script src="/WayPoint/data/timezones.js"> before the main inline
// script in index.html.
var COMMON_TIMEZONES = ['UTC','Europe/London','Europe/Dublin','Europe/Lisbon','Europe/Paris','Europe/Madrid',
  'Europe/Berlin','Europe/Amsterdam','Europe/Zurich','Europe/Rome','Europe/Athens','Europe/Istanbul','Europe/Moscow',
  'America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Anchorage',
  'America/Toronto','America/Vancouver','America/Mexico_City','America/Bogota','America/Lima',
  'America/Sao_Paulo','America/Buenos_Aires','America/Santiago',
  'Asia/Dubai','Asia/Karachi','Asia/Kolkata','Asia/Dhaka','Asia/Bangkok','Asia/Jakarta','Asia/Singapore',
  'Asia/Kuala_Lumpur','Asia/Hong_Kong','Asia/Shanghai','Asia/Taipei','Asia/Seoul','Asia/Tokyo',
  'Asia/Manila','Asia/Ho_Chi_Minh',
  'Australia/Perth','Australia/Adelaide','Australia/Sydney','Australia/Brisbane',
  'Pacific/Auckland','Pacific/Fiji','Pacific/Honolulu',
  'Africa/Cairo','Africa/Johannesburg','Africa/Nairobi','Africa/Lagos','Indian/Maldives'];
