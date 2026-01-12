#!/usr/bin/env node

/**
 * PWA Icon Generator
 * Creates icon-192.png and icon-512.png for Voyage Sorgun Chat
 */

import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const publicDir = join(rootDir, 'public');

// Voyage brand colors
const voyageNavy = '#1A4D6D';
const voyageBlue = '#2C6E8F';
const voyageGold = '#C9A961';
const white = '#FFFFFF';

// SVG icon design - Chat bubble with "V" for Voyage
const createSVG = (size) => {
  const center = size / 2;
  const bubbleRadius = size * 0.35;
  const vSize = size * 0.25;
  
  return `
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${voyageNavy};stop-opacity:1" />
      <stop offset="100%" style="stop-color:${voyageBlue};stop-opacity:1" />
    </linearGradient>
  </defs>
  
  <!-- Background circle -->
  <circle cx="${center}" cy="${center}" r="${size * 0.48}" fill="url(#bgGradient)"/>
  
  <!-- Chat bubble shape -->
  <path d="M ${center - bubbleRadius} ${center - bubbleRadius * 0.3}
           Q ${center - bubbleRadius} ${center - bubbleRadius * 0.6}, ${center - bubbleRadius * 0.6} ${center - bubbleRadius * 0.6}
           L ${center + bubbleRadius * 0.6} ${center - bubbleRadius * 0.6}
           Q ${center + bubbleRadius} ${center - bubbleRadius * 0.6}, ${center + bubbleRadius} ${center - bubbleRadius * 0.3}
           L ${center + bubbleRadius} ${center + bubbleRadius * 0.8}
           Q ${center + bubbleRadius} ${center + bubbleRadius}, ${center + bubbleRadius * 0.7} ${center + bubbleRadius * 0.9}
           L ${center + bubbleRadius * 0.3} ${center + bubbleRadius * 0.7}
           Q ${center - bubbleRadius} ${center + bubbleRadius * 0.8}, ${center - bubbleRadius} ${center + bubbleRadius * 0.5}
           Z" 
        fill="${white}" 
        opacity="0.95"/>
  
  <!-- Letter V for Voyage -->
  <path d="M ${center - vSize * 0.4} ${center - vSize * 0.3}
           L ${center} ${center + vSize * 0.3}
           L ${center + vSize * 0.4} ${center - vSize * 0.3}
           L ${center + vSize * 0.25} ${center - vSize * 0.3}
           L ${center} ${center + vSize * 0.1}
           L ${center - vSize * 0.25} ${center - vSize * 0.3}
           Z" 
        fill="${voyageNavy}"/>
</svg>
  `.trim();
};

async function generateIcons() {
  console.log('🎨 Voyage Sorgun Chat Icon Generator');
  console.log('=====================================\n');

  const sizes = [192, 512];

  for (const size of sizes) {
    try {
      console.log(`📐 Creating icon-${size}.png (${size}x${size})...`);
      
      const svg = createSVG(size);
      const svgBuffer = Buffer.from(svg);
      
      const pngBuffer = await sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toBuffer();
      
      const outputPath = join(publicDir, `icon-${size}.png`);
      writeFileSync(outputPath, pngBuffer);
      
      console.log(`✅ Created: ${outputPath}\n`);
    } catch (error) {
      console.error(`❌ Error creating icon-${size}.png:`, error.message);
      process.exit(1);
    }
  }

  console.log('✨ All icons generated successfully!');
  console.log('\n📋 Generated files:');
  console.log('   - public/icon-192.png (192x192)');
  console.log('   - public/icon-512.png (512x512)');
}

generateIcons().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
