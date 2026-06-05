// UXP exposes its built-in modules through a runtime require(), NOT as resolvable bare
// ESM specifiers. A bundled `import { storage } from "uxp"` leaves a bare `import ... from
// "uxp"` at the top of index.js that the UXP module loader cannot resolve — the whole module
// then fails to evaluate *silently* (blank panel, no console error). Routing through
// require() keeps the emitted bundle self-contained and is the documented UXP pattern.
//
// In build mode vite aliases the bare specifier "uxp" to this file (see vite.config.ts).
// In serve mode it is aliased to uxp-stubs/ instead, so this shim is build-only.
declare const require: (id: string) => any;
const uxp = require("uxp");

export const storage = uxp.storage;
export const shell = uxp.shell;
export default uxp;
