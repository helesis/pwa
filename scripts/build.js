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

console.log('🔨 Starting build process...');
console.log(`📂 Working directory: ${rootDir}`);
console.log(`⏰ Build started at: ${new Date().toISOString()}\n`);

try {
  // Step 1: Update cache version
  console.log('📦 Step 1: Updating service worker cache version...');
  const startTime = Date.now();
  const updateScript = join(__dirname, 'update-cache-version.js');
  console.log(`   📄 Running: ${updateScript}`);
  execSync(`node ${updateScript}`, { stdio: 'inherit', cwd: rootDir });
  const step1Time = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`   ✅ Step 1 completed in ${step1Time}s`);
  
  const totalTime = ((Date.now() - Date.parse(new Date().toISOString().split('.')[0])) / 1000).toFixed(2);
  console.log('\n✅ Build completed successfully!');
  console.log(`⏱️  Total build time: ${totalTime}s`);
  console.log('🚀 Ready for deployment\n');
  
} catch (error) {
  console.error('\n❌ Build failed!');
  console.error(`   Error: ${error.message}`);
  console.error(`   Stack: ${error.stack}`);
  console.error(`   Failed at: ${new Date().toISOString()}`);
  process.exit(1);
}















