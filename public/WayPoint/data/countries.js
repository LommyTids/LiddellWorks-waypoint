// Waypoint — country name suggestion list.
//
// Country names for the destination form's "Country" field (type
// 'country' in fieldHtml()) — not an official ISO list, just plain
// English names a traveller would type — offered as <datalist>
// suggestions, so any value actually typed is still accepted.
//
// Split out of index.html into its own file — see the comment at the
// top of currencies.js in this same folder for why. Loaded via
// <script src="/WayPoint/data/countries.js"> before the main inline
// script in index.html.
var COMMON_COUNTRIES = ['Afghanistan','Albania','Algeria','Andorra','Angola','Argentina','Armenia','Australia',
  'Austria','Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan',
  'Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cambodia',
  'Cameroon','Canada','Cape Verde','Chad','Chile','China','Colombia','Costa Rica','Croatia','Cuba','Cyprus',
  'Czech Republic','Democratic Republic of the Congo','Denmark','Djibouti','Dominican Republic','Ecuador','Egypt',
  'El Salvador','Estonia','Eswatini','Ethiopia','Fiji','Finland','France','Gabon','Gambia','Georgia','Germany',
  'Ghana','Greece','Greenland','Guatemala','Guinea','Guyana','Haiti','Honduras','Hong Kong','Hungary','Iceland',
  'India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Ivory Coast','Jamaica','Japan','Jordan',
  'Kazakhstan','Kenya','Kosovo','Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Liberia','Libya','Liechtenstein',
  'Lithuania','Luxembourg','Macau','Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Mauritius',
  'Mexico','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nepal',
  'Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Macedonia','Norway','Oman','Pakistan','Panama',
  'Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal','Qatar','Republic of the Congo',
  'Romania','Russia','Rwanda','Saudi Arabia','Senegal','Serbia','Seychelles','Singapore','Slovakia','Slovenia',
  'Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan','Suriname','Sweden',
  'Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo','Trinidad and Tobago',
  'Tunisia','Turkey','Turkmenistan','Uganda','Ukraine','United Arab Emirates','United Kingdom',
  'United States','Uruguay','Uzbekistan','Vanuatu','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe'];
