/**
 * This package's own version, reported to the SDK as `wrapperVersion`.
 *
 * Read from package.json rather than duplicated here, so it cannot disagree
 * with what npm published. A test asserts the two match.
 */
import pkg from '../package.json';

export const PACKAGE_VERSION: string = pkg.version;
