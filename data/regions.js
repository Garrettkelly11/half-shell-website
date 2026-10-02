/*
 * Regions — the one list of oyster regions for the site.
 *
 * Loaded by pages as a global (HS_REGIONS) and by Node tools via require.
 * Every `region` code in data/oysters.js must appear here
 * (checked by: node tools/regions-test.js).
 *
 * Fields:
 *   code     the value used in oysters.js `region`
 *   name     full display name
 *   short    abbreviation shown on the employee page
 *   country  'US' or 'CA'
 *   coast    'east' or 'west'
 *   group    'atlantic-north', 'atlantic-south', 'west', or null
 *            (New Jersey is Atlantic but in neither Atlantic sub-group)
 *
 * Curated Flights builds its coast lists from `coast` and `group`
 * (data/flights.js). Keep the order: flights.js lists follow it.
 */
(function (root) {
  'use strict';

  var HS_REGIONS = [
    { code: 'me',  name: 'Maine',                short: 'ME',  country: 'US', coast: 'east', group: 'atlantic-north' },
    { code: 'ma',  name: 'Massachusetts',        short: 'MA',  country: 'US', coast: 'east', group: 'atlantic-north' },
    { code: 'nh',  name: 'New Hampshire',        short: 'NH',  country: 'US', coast: 'east', group: 'atlantic-north' },
    { code: 'ri',  name: 'Rhode Island',         short: 'RI',  country: 'US', coast: 'east', group: 'atlantic-north' },
    { code: 'ct',  name: 'Connecticut',          short: 'CT',  country: 'US', coast: 'east', group: 'atlantic-north' },
    { code: 'ny',  name: 'New York',             short: 'NY',  country: 'US', coast: 'east', group: 'atlantic-north' },
    { code: 'nb',  name: 'New Brunswick',        short: 'NB',  country: 'CA', coast: 'east', group: 'atlantic-north' },
    { code: 'pei', name: 'Prince Edward Island', short: 'PEI', country: 'CA', coast: 'east', group: 'atlantic-north' },
    { code: 'ns',  name: 'Nova Scotia',          short: 'NS',  country: 'CA', coast: 'east', group: 'atlantic-north' },
    { code: 'nc',  name: 'North Carolina',       short: 'NC',  country: 'US', coast: 'east', group: 'atlantic-south' },
    { code: 'va',  name: 'Virginia',             short: 'VA',  country: 'US', coast: 'east', group: 'atlantic-south' },
    { code: 'sc',  name: 'South Carolina',       short: 'SC',  country: 'US', coast: 'east', group: 'atlantic-south' },
    { code: 'md',  name: 'Maryland',             short: 'MD',  country: 'US', coast: 'east', group: 'atlantic-south' },
    { code: 'nj',  name: 'New Jersey',           short: 'NJ',  country: 'US', coast: 'east', group: null },
    { code: 'wa',  name: 'Washington',           short: 'WA',  country: 'US', coast: 'west', group: 'west' },
    { code: 'bc',  name: 'British Columbia',     short: 'BC',  country: 'CA', coast: 'west', group: 'west' }
  ];

  root.HS_REGIONS = HS_REGIONS;
  if (typeof module !== 'undefined' && module.exports) module.exports = HS_REGIONS;
})(typeof window !== 'undefined' ? window : globalThis);
