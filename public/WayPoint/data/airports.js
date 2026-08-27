// Waypoint — major airport suggestion list.
//
// Major international/hub airports, offered the same "suggestion, but
// anything is still accepted" way as the other data/*.js lists. Covers
// the busiest hubs on each continent rather than every airport that
// exists.
//
// Unlike the other lists (which are flat arrays of plain strings), each
// entry here is an object: { code, name, city, country }. That's a
// deliberate change from the old flat "CODE — Name" strings — the
// "From"/"To" fields on a Flight transport leg feed straight into the
// Map tab's geocoding (see geocodeLookup()/mapLegsForTrip() in
// index.html), and a bare airport code or name alone is often too
// little for Nominatim (OpenStreetMap's free geocoder) to place
// reliably. Having city + country as separate fields lets
// airportDisplay() (in index.html) build a fuller "CODE — Name, City,
// Country" value — e.g. "CNX — Chiang Mai, Thailand" — so a leg that
// starts or ends at an airport geocodes just as reliably as one typed
// as a plain city name.
//
// Split out of index.html into its own file — see the comment at the
// top of currencies.js in this same folder for why. Loaded via
// <script src="/WayPoint/data/airports.js"> before the main inline
// script in index.html.
var COMMON_AIRPORTS = [
  // ---- Europe ----
  { code: 'LHR', name: 'London Heathrow', city: 'London', country: 'United Kingdom' },
  { code: 'LGW', name: 'London Gatwick', city: 'London', country: 'United Kingdom' },
  { code: 'STN', name: 'London Stansted', city: 'London', country: 'United Kingdom' },
  { code: 'LTN', name: 'London Luton', city: 'London', country: 'United Kingdom' },
  { code: 'MAN', name: 'Manchester', city: 'Manchester', country: 'United Kingdom' },
  { code: 'EDI', name: 'Edinburgh', city: 'Edinburgh', country: 'United Kingdom' },
  { code: 'DUB', name: 'Dublin', city: 'Dublin', country: 'Ireland' },
  { code: 'CDG', name: 'Paris Charles de Gaulle', city: 'Paris', country: 'France' },
  { code: 'ORY', name: 'Paris Orly', city: 'Paris', country: 'France' },
  { code: 'AMS', name: 'Amsterdam Schiphol', city: 'Amsterdam', country: 'Netherlands' },
  { code: 'FRA', name: 'Frankfurt', city: 'Frankfurt', country: 'Germany' },
  { code: 'MUC', name: 'Munich', city: 'Munich', country: 'Germany' },
  { code: 'BER', name: 'Berlin Brandenburg', city: 'Berlin', country: 'Germany' },
  { code: 'MAD', name: 'Madrid Barajas', city: 'Madrid', country: 'Spain' },
  { code: 'BCN', name: 'Barcelona El Prat', city: 'Barcelona', country: 'Spain' },
  { code: 'FCO', name: 'Rome Fiumicino', city: 'Rome', country: 'Italy' },
  { code: 'MXP', name: 'Milan Malpensa', city: 'Milan', country: 'Italy' },
  { code: 'VCE', name: 'Venice Marco Polo', city: 'Venice', country: 'Italy' },
  { code: 'ZRH', name: 'Zurich', city: 'Zurich', country: 'Switzerland' },
  { code: 'GVA', name: 'Geneva', city: 'Geneva', country: 'Switzerland' },
  { code: 'VIE', name: 'Vienna', city: 'Vienna', country: 'Austria' },
  { code: 'CPH', name: 'Copenhagen', city: 'Copenhagen', country: 'Denmark' },
  { code: 'ARN', name: 'Stockholm Arlanda', city: 'Stockholm', country: 'Sweden' },
  { code: 'OSL', name: 'Oslo', city: 'Oslo', country: 'Norway' },
  { code: 'HEL', name: 'Helsinki', city: 'Helsinki', country: 'Finland' },
  { code: 'WAW', name: 'Warsaw Chopin', city: 'Warsaw', country: 'Poland' },
  { code: 'PRG', name: 'Prague', city: 'Prague', country: 'Czech Republic' },
  { code: 'BUD', name: 'Budapest', city: 'Budapest', country: 'Hungary' },
  { code: 'ATH', name: 'Athens', city: 'Athens', country: 'Greece' },
  { code: 'LIS', name: 'Lisbon', city: 'Lisbon', country: 'Portugal' },
  { code: 'OPO', name: 'Porto', city: 'Porto', country: 'Portugal' },
  { code: 'IST', name: 'Istanbul', city: 'Istanbul', country: 'Turkey' },
  { code: 'SAW', name: 'Istanbul Sabiha Gökçen', city: 'Istanbul', country: 'Turkey' },
  { code: 'SVO', name: 'Moscow Sheremetyevo', city: 'Moscow', country: 'Russia' },
  { code: 'DME', name: 'Moscow Domodedovo', city: 'Moscow', country: 'Russia' },

  // ---- North America ----
  { code: 'JFK', name: 'New York JFK', city: 'New York', country: 'United States' },
  { code: 'EWR', name: 'Newark', city: 'Newark', country: 'United States' },
  { code: 'LGA', name: 'New York LaGuardia', city: 'New York', country: 'United States' },
  { code: 'BOS', name: 'Boston Logan', city: 'Boston', country: 'United States' },
  { code: 'ORD', name: 'Chicago O\'Hare', city: 'Chicago', country: 'United States' },
  { code: 'ATL', name: 'Atlanta', city: 'Atlanta', country: 'United States' },
  { code: 'DFW', name: 'Dallas/Fort Worth', city: 'Dallas', country: 'United States' },
  { code: 'DEN', name: 'Denver', city: 'Denver', country: 'United States' },
  { code: 'LAS', name: 'Las Vegas', city: 'Las Vegas', country: 'United States' },
  { code: 'LAX', name: 'Los Angeles', city: 'Los Angeles', country: 'United States' },
  { code: 'SFO', name: 'San Francisco', city: 'San Francisco', country: 'United States' },
  { code: 'SEA', name: 'Seattle-Tacoma', city: 'Seattle', country: 'United States' },
  { code: 'MIA', name: 'Miami', city: 'Miami', country: 'United States' },
  { code: 'MCO', name: 'Orlando', city: 'Orlando', country: 'United States' },
  { code: 'IAH', name: 'Houston', city: 'Houston', country: 'United States' },
  { code: 'PHX', name: 'Phoenix', city: 'Phoenix', country: 'United States' },
  { code: 'YYZ', name: 'Toronto Pearson', city: 'Toronto', country: 'Canada' },
  { code: 'YVR', name: 'Vancouver', city: 'Vancouver', country: 'Canada' },
  { code: 'YUL', name: 'Montreal', city: 'Montreal', country: 'Canada' },
  { code: 'MEX', name: 'Mexico City', city: 'Mexico City', country: 'Mexico' },
  { code: 'CUN', name: 'Cancun', city: 'Cancun', country: 'Mexico' },

  // ---- South America ----
  { code: 'GRU', name: 'Sao Paulo Guarulhos', city: 'Sao Paulo', country: 'Brazil' },
  { code: 'GIG', name: 'Rio de Janeiro Galeão', city: 'Rio de Janeiro', country: 'Brazil' },
  { code: 'EZE', name: 'Buenos Aires Ezeiza', city: 'Buenos Aires', country: 'Argentina' },
  { code: 'SCL', name: 'Santiago', city: 'Santiago', country: 'Chile' },
  { code: 'LIM', name: 'Lima', city: 'Lima', country: 'Peru' },
  { code: 'BOG', name: 'Bogota', city: 'Bogota', country: 'Colombia' },

  // ---- Middle East & Africa ----
  { code: 'DXB', name: 'Dubai', city: 'Dubai', country: 'United Arab Emirates' },
  { code: 'AUH', name: 'Abu Dhabi', city: 'Abu Dhabi', country: 'United Arab Emirates' },
  { code: 'DOH', name: 'Doha', city: 'Doha', country: 'Qatar' },
  { code: 'RUH', name: 'Riyadh', city: 'Riyadh', country: 'Saudi Arabia' },
  { code: 'JED', name: 'Jeddah', city: 'Jeddah', country: 'Saudi Arabia' },
  { code: 'TLV', name: 'Tel Aviv', city: 'Tel Aviv', country: 'Israel' },
  { code: 'CAI', name: 'Cairo', city: 'Cairo', country: 'Egypt' },
  { code: 'CMN', name: 'Casablanca', city: 'Casablanca', country: 'Morocco' },
  { code: 'JNB', name: 'Johannesburg', city: 'Johannesburg', country: 'South Africa' },
  { code: 'CPT', name: 'Cape Town', city: 'Cape Town', country: 'South Africa' },
  { code: 'NBO', name: 'Nairobi', city: 'Nairobi', country: 'Kenya' },
  { code: 'LOS', name: 'Lagos', city: 'Lagos', country: 'Nigeria' },
  { code: 'ADD', name: 'Addis Ababa', city: 'Addis Ababa', country: 'Ethiopia' },

  // ---- South Asia ----
  { code: 'DEL', name: 'Delhi', city: 'Delhi', country: 'India' },
  { code: 'BOM', name: 'Mumbai', city: 'Mumbai', country: 'India' },
  { code: 'BLR', name: 'Bengaluru', city: 'Bengaluru', country: 'India' },
  { code: 'MAA', name: 'Chennai', city: 'Chennai', country: 'India' },
  { code: 'CCU', name: 'Kolkata', city: 'Kolkata', country: 'India' },
  { code: 'KTM', name: 'Kathmandu', city: 'Kathmandu', country: 'Nepal' },
  { code: 'DAC', name: 'Dhaka', city: 'Dhaka', country: 'Bangladesh' },
  { code: 'CMB', name: 'Colombo', city: 'Colombo', country: 'Sri Lanka' },
  { code: 'MLE', name: 'Malé', city: 'Malé', country: 'Maldives' },

  // ---- Southeast Asia ----
  { code: 'BKK', name: 'Bangkok Suvarnabhumi', city: 'Bangkok', country: 'Thailand' },
  { code: 'DMK', name: 'Bangkok Don Mueang', city: 'Bangkok', country: 'Thailand' },
  { code: 'HKT', name: 'Phuket', city: 'Phuket', country: 'Thailand' },
  { code: 'CNX', name: 'Chiang Mai', city: 'Chiang Mai', country: 'Thailand' },
  { code: 'SGN', name: 'Ho Chi Minh City', city: 'Ho Chi Minh City', country: 'Vietnam' },
  { code: 'HAN', name: 'Hanoi', city: 'Hanoi', country: 'Vietnam' },
  { code: 'DAD', name: 'Da Nang', city: 'Da Nang', country: 'Vietnam' },
  { code: 'PNH', name: 'Phnom Penh', city: 'Phnom Penh', country: 'Cambodia' },
  { code: 'REP', name: 'Siem Reap', city: 'Siem Reap', country: 'Cambodia' },
  { code: 'VTE', name: 'Vientiane', city: 'Vientiane', country: 'Laos' },
  { code: 'LPQ', name: 'Luang Prabang', city: 'Luang Prabang', country: 'Laos' },
  { code: 'RGN', name: 'Yangon', city: 'Yangon', country: 'Myanmar' },
  { code: 'KUL', name: 'Kuala Lumpur', city: 'Kuala Lumpur', country: 'Malaysia' },
  { code: 'PEN', name: 'Penang', city: 'Penang', country: 'Malaysia' },
  { code: 'SIN', name: 'Singapore', city: 'Singapore', country: 'Singapore' },
  { code: 'CGK', name: 'Jakarta', city: 'Jakarta', country: 'Indonesia' },
  { code: 'DPS', name: 'Bali Denpasar', city: 'Denpasar', country: 'Indonesia' },
  { code: 'MNL', name: 'Manila', city: 'Manila', country: 'Philippines' },
  { code: 'CEB', name: 'Cebu', city: 'Cebu', country: 'Philippines' },

  // ---- East Asia ----
  { code: 'HKG', name: 'Hong Kong', city: 'Hong Kong', country: 'Hong Kong' },
  { code: 'MFM', name: 'Macau', city: 'Macau', country: 'Macau' },
  { code: 'TPE', name: 'Taipei Taoyuan', city: 'Taipei', country: 'Taiwan' },
  { code: 'PVG', name: 'Shanghai Pudong', city: 'Shanghai', country: 'China' },
  { code: 'PEK', name: 'Beijing Capital', city: 'Beijing', country: 'China' },
  { code: 'PKX', name: 'Beijing Daxing', city: 'Beijing', country: 'China' },
  { code: 'CAN', name: 'Guangzhou', city: 'Guangzhou', country: 'China' },
  { code: 'ICN', name: 'Seoul Incheon', city: 'Seoul', country: 'South Korea' },
  { code: 'GMP', name: 'Seoul Gimpo', city: 'Seoul', country: 'South Korea' },
  { code: 'NRT', name: 'Tokyo Narita', city: 'Tokyo', country: 'Japan' },
  { code: 'HND', name: 'Tokyo Haneda', city: 'Tokyo', country: 'Japan' },
  { code: 'KIX', name: 'Osaka Kansai', city: 'Osaka', country: 'Japan' },
  { code: 'FUK', name: 'Fukuoka', city: 'Fukuoka', country: 'Japan' },
  { code: 'CTS', name: 'Sapporo New Chitose', city: 'Sapporo', country: 'Japan' },

  // ---- Oceania ----
  { code: 'SYD', name: 'Sydney', city: 'Sydney', country: 'Australia' },
  { code: 'MEL', name: 'Melbourne', city: 'Melbourne', country: 'Australia' },
  { code: 'BNE', name: 'Brisbane', city: 'Brisbane', country: 'Australia' },
  { code: 'PER', name: 'Perth', city: 'Perth', country: 'Australia' },
  { code: 'AKL', name: 'Auckland', city: 'Auckland', country: 'New Zealand' },
  { code: 'CHC', name: 'Christchurch', city: 'Christchurch', country: 'New Zealand' },
  { code: 'ZQN', name: 'Queenstown', city: 'Queenstown', country: 'New Zealand' },
  { code: 'NAN', name: 'Nadi (Fiji)', city: 'Nadi', country: 'Fiji' },
  { code: 'HNL', name: 'Honolulu', city: 'Honolulu', country: 'United States' }
];
