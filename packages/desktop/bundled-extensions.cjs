// Extensions the packaged app carries. The same file in the user's own extensions folder takes over, because that folder
// is always loaded and a provider must not be registered twice.
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const BUNDLED_EXTENSIONS = ['claude-code-shell.ts'];

function bundledExtensionArgs(appDir, agentDir) {
  return BUNDLED_EXTENSIONS.flatMap((name) => {
    const bundled = join(appDir, 'runtime', 'extensions', name);
    return existsSync(bundled) && !existsSync(join(agentDir, 'extensions', name)) ? ['--extension', bundled] : [];
  });
}

module.exports = { BUNDLED_EXTENSIONS, bundledExtensionArgs };
