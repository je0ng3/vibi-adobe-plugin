// UXP requires Spectrum Web Components pinned to 0.37.0 via the @swc-uxp-wrappers packages
// (they re-export the UXP-patched 0.37.0 components). theme/styles/progress-bar have no wrapper,
// so they come from @spectrum-web-components directly, also pinned to 0.37.0 (see package.json).
import "@spectrum-web-components/styles/typography.css";
import "@spectrum-web-components/theme/sp-theme.js";
import "@spectrum-web-components/theme/theme-darkest.js";
import "@spectrum-web-components/theme/scale-medium.js";
import "@swc-uxp-wrappers/button/sp-button.js";
import "@swc-uxp-wrappers/textfield/sp-textfield.js";
import "@swc-uxp-wrappers/field-label/sp-field-label.js";
import "@spectrum-web-components/progress-bar/sp-progress-bar.js";
import "@swc-uxp-wrappers/help-text/sp-help-text.js";
// NOTE: Spectrum's <sp-icon-*> workflow-icon web components are NOT imported — they render via
// shadow DOM and paint blank in the UXP runtime. We use inline-SVG copies instead (src/components/Icons.tsx).
