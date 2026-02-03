// global-scripts.js
// Loads original inline scripts from the backup HTML and executes them,
// excluding the AppState IIFE which has been moved to /js/app-state.js.
document.addEventListener('DOMContentLoaded', () => {
  fetch('/indexold.html')
    .then(r => {
      if (!r.ok) throw new Error('Failed to fetch indexold.html');
      return r.text();
    })
    .then(text => {
      // Extract all inline <script>...</script> blocks
      const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
      let match;
      const scripts = [];
      while ((match = regex.exec(text)) !== null) {
        const code = match[1];
        // Skip scripts that contain AppState definition to avoid duplication
        if (/const\s+AppState\s*=|CENTRALIZED STATE MANAGEMENT/.test(code)) continue;
        // Also skip external script tags (they will be loaded via <script src> in head)
        // but since we extracted inline only, proceed.
        scripts.push(code);
      }

      // Execute scripts in order in global scope
      scripts.forEach((code, idx) => {
        try {
          // Use Function constructor to execute in global scope
          new Function(code)();
        } catch (err) {
          console.error('Error executing extracted script #' + idx, err);
        }
      });
    })
    .catch(err => {
      console.error('global-scripts: failed to load original inline scripts', err);
    });
});
