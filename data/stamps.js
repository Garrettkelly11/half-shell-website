/*
 * Oyster Passport stamps — the definitions, as data.
 *
 * Loaded by the Passport pages as a global (HS_STAMPS) and by Node tools via
 * require. src/passport-core.js turns these into earned tiers; nothing else
 * decides who has a stamp. Oyster Passport Build Sheet section 6.5.
 *
 * Tiered stamps: thresholds for bronze, silver, gold, pearl. 'all' means
 * every oyster (Variety) or every region (Atlas) in the current catalog.
 * Region stamps: one per region in the catalog, made from REGION.
 *
 * line: shown under the stamp in the celebration modal. {n} is the count,
 * {n:word} is "word" or "words" to match, {region} the region's name.
 *
 * To reword a stamp or change a threshold, edit it here.
 */
(function (root) {
  'use strict';

  var HS_STAMPS = {
    TIERS: ['bronze', 'silver', 'gold', 'pearl'],
    TIER_NAMES: { single: '', bronze: 'Bronze', silver: 'Silver', gold: 'Gold', pearl: 'Pearl' },
    TIER_COLORS: {
      bronze: '#9a6a3a',
      silver: '#8a9aa3',
      gold: '#c8962e',
      pearl: ['#e8e4f0', '#cfe3e6', '#f3e6d8']
    },

    REGION: {
      idPrefix: 'region-',
      measure: 'region',
      thresholds: [1, 12, 36, 100],
      description: 'Oysters from {region}.',
      line: '{n} {n:oyster} from {region}'
    },

    LADDERS: [
      { id: 'volume', name: 'Volume', measure: 'eaten', thresholds: [12, 60, 300, 1500],
        description: 'Every oyster you log.', line: '{n} {n:oyster}' },
      { id: 'variety', name: 'Variety', measure: 'varieties', thresholds: [5, 15, 30, 'all'],
        description: 'Different oysters on our list you have tried.', line: '{n} different {n:oyster}' },
      { id: 'atlas', name: 'Atlas', measure: 'regions', thresholds: [3, 6, 10, 'all'],
        description: 'Regions you have tasted from.', line: 'Oysters from {n} {n:region}' },
      { id: 'regular', name: 'Regular', measure: 'visits', thresholds: [3, 10, 25, 50],
        description: 'Days you have logged oysters.', line: '{n} {n:visit}' },
      { id: 'critic', name: 'Critic', measure: 'rated', thresholds: [10, 50, 150, 500],
        description: 'Oysters you have rated, one per oyster per visit.', line: '{n} {n:rating}' },
      { id: 'salt-lover', name: 'Salt Lover', measure: 'briny', thresholds: [6, 24, 72, 200],
        description: 'High and very high salinity oysters.', line: '{n} briny {n:oyster}' },
      { id: 'sweet-tooth', name: 'Sweet Tooth', measure: 'mild', thresholds: [6, 24, 72, 200],
        description: 'Low salinity oysters.', line: '{n} mild {n:oyster}' }
    ],

    SINGLES: [
      { id: 'first-slurp', name: 'First Slurp', test: 'firstSlurp',
        description: 'Log your first oyster.', line: 'Your first oyster' },
      { id: 'coast-to-coast', name: 'Coast to Coast', test: 'coastToCoast',
        description: 'An East Coast and a West Coast oyster.', line: 'East Coast and West Coast' },
      { id: 'home-waters', name: 'Home Waters', test: 'homeWaters',
        description: 'A North Carolina oyster.', line: 'A North Carolina oyster' },
      { id: 'passport-stamp', name: 'Passport Stamp', test: 'canadian',
        description: 'An oyster from Canada.', line: 'An oyster from Canada' },
      { id: 'flight-crew', name: 'Flight Crew', test: 'flightCrew',
        description: 'Every oyster in one of our Curated Flights, in one visit.', line: 'A whole Curated Flight' },
      { id: 'birthday-shuck', name: 'Birthday Shuck', test: 'birthday',
        description: 'Oysters during your birthday week.', line: 'Oysters in your birthday week' }
    ]
  };

  root.HS_STAMPS = HS_STAMPS;
  if (typeof module !== 'undefined' && module.exports) module.exports = HS_STAMPS;
})(typeof window !== 'undefined' ? window : globalThis);
