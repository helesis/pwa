import pg from 'pg';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function runMigration() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Starting migration: Add opening_hour and closing_hour to restaurants table...');
    
    // Step 1: Add new columns
    console.log('📝 Step 1: Adding opening_hour and closing_hour columns...');
    await client.query(`
      ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS opening_hour VARCHAR(5);
      ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS closing_hour VARCHAR(5);
    `);
    console.log('✅ Columns added successfully');
    
    // Step 2: Migrate existing data (if working_hours column exists)
    console.log('📝 Step 2: Checking for existing working_hours data to migrate...');
    const hasWorkingHours = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'restaurants' 
      AND column_name = 'working_hours'
    `);
    
    if (hasWorkingHours.rows.length > 0) {
      console.log('📝 Found working_hours column, migrating data...');
      const updateResult = await client.query(`
        UPDATE restaurants
        SET 
          opening_hour = CASE 
            WHEN working_hours IS NOT NULL AND working_hours != '' THEN
              TRIM(SPLIT_PART(REPLACE(working_hours, ' ', ''), '-', 1))
            ELSE NULL
          END,
          closing_hour = CASE 
            WHEN working_hours IS NOT NULL AND working_hours != '' THEN
              TRIM(SPLIT_PART(REPLACE(working_hours, ' ', ''), '-', 2))
            ELSE NULL
          END
        WHERE (opening_hour IS NULL OR closing_hour IS NULL)
          AND working_hours IS NOT NULL 
          AND working_hours != ''
      `);
      console.log(`✅ Migrated ${updateResult.rowCount} restaurant(s) from working_hours`);
    } else {
      console.log('ℹ️  No working_hours column found, skipping data migration');
    }
    
    // Verify migration
    console.log('📝 Step 3: Verifying migration...');
    const verifyResult = await client.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(opening_hour) as with_opening,
        COUNT(closing_hour) as with_closing
      FROM restaurants
    `);
    
    const stats = verifyResult.rows[0];
    console.log(`✅ Migration completed!`);
    console.log(`   Total restaurants: ${stats.total}`);
    console.log(`   Restaurants with opening_hour: ${stats.with_opening}`);
    console.log(`   Restaurants with closing_hour: ${stats.with_closing}`);
    
    console.log('\n✅ Migration completed successfully!');
    console.log('\n⚠️  Note: To drop the old working_hours column (if it exists), run:');
    console.log('   ALTER TABLE restaurants DROP COLUMN IF EXISTS working_hours;');
    console.log('   (Only after verifying that all data has been migrated correctly)');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration()
  .then(() => {
    console.log('\n✅ Migration script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration script failed:', error);
    process.exit(1);
  });
