#!/usr/bin/env node

/**
 * Build script to automatically increment service worker cache version
 * This ensures PWA updates work correctly on iOS and Android
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const serviceWorkerPath = join(rootDir, 'public', 'service-worker.js');

try {
  // Read service worker file
  let content = readFileSync(serviceWorkerPath, 'utf8');
  
  // Find current cache version (format: voyage-chat-v2, voyage-chat-v3, etc.)
  const versionRegex = /const CACHE_VERSION = 'voyage-chat-v(\d+)';/;
  const match = content.match(versionRegex);
  
  if (!match) {
    console.error('❌ Could not find CACHE_VERSION in service-worker.js');
    process.exit(1);
  }
  
  const currentVersion = parseInt(match[1], 10);
  const newVersion = currentVersion + 1;
  
  // Update cache version
  const newContent = content.replace(
    versionRegex,
    `const CACHE_VERSION = 'voyage-chat-v${newVersion}';`
  );
  
  // Write updated file
  writeFileSync(serviceWorkerPath, newContent, 'utf8');
  
  console.log(`✅ Cache version updated: v${currentVersion} → v${newVersion}`);
  console.log(`📦 Service worker ready for deployment`);
  
} catch (error) {
  console.error('❌ Error updating cache version:', error.message);
  process.exit(1);
}

