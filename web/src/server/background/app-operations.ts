/** Audited exact owner handlers: launches.profiles() and launches.batches() only list stored rows.
 * GET alone is not read proof: Helper can revoke authority and Attention can reconcile records.
 * Queries and every unlisted operation remain unclassified until their service behavior is audited.
 */
export const READ_APP_OPERATIONS: readonly string[] = ['GET /api/v1/launch-profiles', 'GET /api/v1/launches'];
