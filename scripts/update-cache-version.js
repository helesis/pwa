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
  
  // Find current cache version (format: voyage-chat-v4.1, voyage-chat-v4.2, etc.)
  const versionRegex = /const CACHE_VERSION = 'voyage-chat-v(\d+)\.(\d+)';/;
  const match = content.match(versionRegex);
  
  if (!match) {
    // Try old format (v4, v5, etc.) and convert to new format
    const oldVersionRegex = /const CACHE_VERSION = 'voyage-chat-v(\d+)';/;
    const oldMatch = content.match(oldVersionRegex);
    
    if (oldMatch) {
      const majorVersion = parseInt(oldMatch[1], 10);
      const newVersion = `${majorVersion}.1`;
      const newContent = content.replace(
        oldVersionRegex,
        `const CACHE_VERSION = 'voyage-chat-v${newVersion}';`
      );
      writeFileSync(serviceWorkerPath, newContent, 'utf8');
      console.log(`✅ Cache version converted: v${majorVersion} → v${newVersion}`);
      console.log(`📦 Service worker ready for deployment`);
      process.exit(0);
    } else {
      console.error('❌ Could not find CACHE_VERSION in service-worker.js');
      process.exit(1);
    }
  }
  
  const majorVersion = parseInt(match[1], 10);
  const minorVersion = parseInt(match[2], 10);
  const newMinorVersion = minorVersion + 1;
  const newVersion = `${majorVersion}.${newMinorVersion}`;
  
  // Update cache version
  const newContent = content.replace(
    versionRegex,
    `const CACHE_VERSION = 'voyage-chat-v${newVersion}';`
  );
  
  // Write updated file
  writeFileSync(serviceWorkerPath, newContent, 'utf8');
  
  console.log(`✅ Cache version updated: v${majorVersion}.${minorVersion} → v${newVersion}`);
  console.log(`📦 Service worker ready for deployment`);
  
} catch (error) {
  console.error('❌ Error updating cache version:', error.message);
  process.exit(1);
}

