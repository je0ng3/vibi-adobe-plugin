// See uxp-shim/uxp.ts — same reason. premierepro must be reached via require() so the ESM
// bundle carries no unresolvable bare specifier.
declare const require: (id: string) => any;
const ppro = require("premierepro");

export const Project = ppro.Project;
export const ClipProjectItem = ppro.ClipProjectItem;
export default ppro;
