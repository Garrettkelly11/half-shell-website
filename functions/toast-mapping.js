/**
 * Toast item GUID → Half Shell oyster slug — emergency override table.
 *
 * NOT the primary mapping path. The default behavior in
 * `sync-toast-endpoint.js` is to match Toast item names against the catalog
 * (`oyster-catalog.json`, generated at deploy time from `data/oysters.js`).
 * The catalog supports `aliases: [...]` on each entry, which handles almost
 * every name discrepancy without code changes.
 *
 * Use this table only when:
 *   - Two Toast items have identical names but should map to different slugs
 *     (impossible to disambiguate by name alone), OR
 *   - You want to force a specific Toast GUID to map to a slug regardless of
 *     what its name says (e.g., the staff renamed the Toast item but the
 *     historical GUID should still resolve).
 *
 * For the normal "Toast spells it differently" case, add an alias to the
 * catalog entry instead of populating this table:
 *
 *   // data/oysters.js
 *   {
 *     id: "le-petite-barachois",
 *     name: "Le Petit Barachois",
 *     aliases: ["Le Petit"],
 *     ...
 *   }
 *
 * Format here: keys are Toast item GUIDs (UUIDs from
 * `tools/toast-menu-dump.json`), values are catalog slug `id`s. The override
 * is checked BEFORE the name index, so a GUID in this table always wins.
 */

const guidToSlug = {
  // No overrides today. Add entries as needed; they should be the exception.
  // Example:
  //   '01234567-89ab-cdef-0123-456789abcdef': 'island-creek',
};

// Inverse map for hypothetical future write-back operations. Auto-derived.
const slugToGuid = Object.fromEntries(
  Object.entries(guidToSlug).map(([guid, slug]) => [slug, guid])
);

module.exports = { guidToSlug, slugToGuid };
