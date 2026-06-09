// See uxp-shim/uxp.ts — same reason. premierepro must be reached via require() so the ESM
// bundle carries no unresolvable bare specifier.
declare const require: (id: string) => any;
const ppro = require("premierepro");

export const Project = ppro.Project;
export const ClipProjectItem = ppro.ClipProjectItem;
// In-panel preview routes audio through Premiere's own Source Monitor engine when Web Audio
// is absent (the UXP case). See audio/sourceMonitorPlayer.ts.
export const SourceMonitor = ppro.SourceMonitor;
export const TickTime = ppro.TickTime;
export default ppro;
