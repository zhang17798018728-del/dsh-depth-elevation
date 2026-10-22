/**
 * The version of the `live_probe.mjs --json` payload contract.
 *
 * One definition, two readers — the probe that writes the payload and the parent
 * that consumes it. Two literals would let one side be bumped while the other still
 * expects the old shape, and the resulting `undefined` reads like a probe bug rather
 * than a stale consumer.
 *
 * Bump this whenever a field is renamed or removed. Both sides then fail loudly with
 * "version N, expected M" instead of silently reading `undefined`.
 *
 * @module tools/probe-contract
 */

export const PROBE_VERSION = 1;

/**
 * Fields a consumer may read. Kept here so `test/contract.mjs` can assert the probe
 * actually emits them, rather than the docs promising fields nobody writes.
 */
export const REQUIRED_FIELDS = ['version', 'ok', 'pid', 'port'];
