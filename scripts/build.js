#!/usr/bin/env node

/**
 * Main build script
 * Updates cache version and prepares for deployment
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

console.log('🔨 Starting build process...\n');

try {
  // Step 1: Update cache version
  console.log('📦 Step 1: Updating service worker cache version...');
  const updateScript = join(__dirname, 'update-cache-version.js');
  execSync(`node ${updateScript}`, { stdio: 'inherit', cwd: rootDir });
  
  console.log('\n✅ Build completed successfully!');
  console.log('🚀 Ready for deployment\n');
  
} catch (error) {
  console.error('\n❌ Build failed:', error.message);
  process.exit(1);
}














