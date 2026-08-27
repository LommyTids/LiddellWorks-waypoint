// Waypoint — city name suggestion list.
//
// A few hundred well-known cities, for the same kind of "type-ahead
// suggestion, but anything is still accepted" <datalist> as countries.js
// in this same folder. This isn't (and can't realistically be) every
// city in the world — it's a helpful shortlist of common travel
// destinations, so typing "Chia" or "Bang" surfaces the obvious match
// without forcing the viewer to pick from a closed list. Any place name
// a viewer actually types is saved exactly as typed, list or no list.
//
// Split out of index.html into its own file — see the comment at the
// top of currencies.js in this same folder for why. Loaded via
// <script src="/WayPoint/data/cities.js"> before the main inline script
// in index.html.
var COMMON_CITIES = ['Amsterdam','Athens','Auckland','Bali (Denpasar)','Bangkok','Barcelona','Beijing','Beirut',
  'Belgrade','Berlin','Bogota','Bologna','Boston','Brisbane','Brussels','Bucharest','Budapest','Buenos Aires',
  'Cairo','Cancun','Cape Town','Casablanca','Chiang Mai','Chicago','Christchurch','Copenhagen','Dallas',
  'Da Nang','Delhi','Denver','Dhaka','Doha','Dubai','Dublin','Dubrovnik','Edinburgh','Florence','Frankfurt',
  'Fukuoka','Geneva','Genoa','Glasgow','Gothenburg','Guangzhou','Hanoi','Ha Long Bay','Havana','Helsinki',
  'Ho Chi Minh City','Hong Kong','Honolulu','Houston','Istanbul','Jaipur','Jakarta','Johannesburg','Kathmandu',
  'Kigali','Krabi','Kraków','Kuala Lumpur','Kyoto','Lagos','Las Vegas','Lima','Lisbon','Liverpool','Ljubljana',
  'London','Los Angeles','Luang Prabang','Luxor','Lyon','Madrid','Malaga','Male','Manchester','Manila','Marrakech',
  'Marseille','Melbourne','Mexico City','Miami','Milan','Montevideo','Montreal','Moscow','Mumbai','Munich',
  'Nairobi','Naples','New Delhi','New Orleans','New York','Nice','Osaka','Oslo','Panama City','Paris','Penang',
  'Perth','Phnom Penh','Phuket','Porto','Prague','Queenstown','Quito','Reykjavik','Rio de Janeiro','Riyadh',
  'Rome','Rotterdam','Salvador','San Diego','San Francisco','San Sebastian','Santiago','Santorini','Sao Paulo',
  'Sapporo','Seattle','Seoul','Seville','Shanghai','Siem Reap','Singapore','Split','Stockholm','Sydney','Taipei',
  'Tallinn','Tbilisi','Tel Aviv','Tokyo','Toronto','Tunis','Ubud','Vancouver','Venice','Vienna','Vientiane',
  'Warsaw','Washington DC','Wellington','Xi\'an','Yangon','Zagreb','Zanzibar City','Zurich'];
