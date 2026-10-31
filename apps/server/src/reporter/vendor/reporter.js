/* ClaudePilot UI reporter SDK: PLACEHOLDER build (docs/prd/ui-reporter-server.md).
 * The real SDK (repo alfianisnan26/pilot-reporter) is vendored here, with its version in VERSION, by the integration step.
 * This placeholder patches nothing and renders nothing: a page that loads it behaves exactly as without it. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.PilotReporter) return;
  window.PilotReporter = Object.freeze({
    version: '0.0.0-placeholder',
    placeholder: true,
    init: function () {
      return false;
    },
  });
})();
