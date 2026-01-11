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

async function initSchema() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Initializing restaurant schema...');
    
    // Check if restaurants table exists
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'restaurants'
      );
    `);
    
    if (!tableExists.rows[0].exists) {
      console.log('📝 Creating restaurants table...');
      // Create restaurants table with all columns including opening_hour and closing_hour
      await client.query(`
        CREATE TABLE restaurants (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          photos JSONB DEFAULT '[]'::jsonb,
          active BOOLEAN DEFAULT true,
          opening_hour VARCHAR(5),
          closing_hour VARCHAR(5),
          price_per_person DECIMAL(10, 2) NOT NULL,
          currency VARCHAR(3) DEFAULT 'TRY',
          rules_json JSONB DEFAULT '{
            "max_reservation_per_room_per_day": 1,
            "max_reservation_per_stay": null,
            "cutoff_minutes": 120,
            "cancellation_deadline_minutes": 240,
            "child_pricing_policy": "free_under_12",
            "allow_mix_table": false,
            "deposit_required": false
          }'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          deleted_at TIMESTAMP WITH TIME ZONE NULL
        );
      `);
      
      console.log('✅ Restaurants table created successfully');
    } else {
      console.log('ℹ️  Restaurants table already exists, checking for opening_hour and closing_hour columns...');
      
      // Check if opening_hour column exists
      const openingHourExists = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'restaurants' 
        AND column_name = 'opening_hour'
      `);
      
      // Check if closing_hour column exists
      const closingHourExists = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'restaurants' 
        AND column_name = 'closing_hour'
      `);
      
      // Add opening_hour if it doesn't exist
      if (openingHourExists.rows.length === 0) {
        console.log('📝 Adding opening_hour column...');
        await client.query(`
          ALTER TABLE restaurants ADD COLUMN opening_hour VARCHAR(5);
        `);
        console.log('✅ opening_hour column added');
      } else {
        console.log('ℹ️  opening_hour column already exists');
      }
      
      // Add closing_hour if it doesn't exist
      if (closingHourExists.rows.length === 0) {
        console.log('📝 Adding closing_hour column...');
        await client.query(`
          ALTER TABLE restaurants ADD COLUMN closing_hour VARCHAR(5);
        `);
        console.log('✅ closing_hour column added');
      } else {
        console.log('ℹ️  closing_hour column already exists');
      }
    }
    
    // Create indexes
    console.log('📝 Creating indexes...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_restaurants_active ON restaurants(active) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_restaurants_deleted ON restaurants(deleted_at) WHERE deleted_at IS NOT NULL;
    `);
    console.log('✅ Indexes created');
    
    console.log('\n✅ Restaurant schema initialization completed successfully!');
    
  } catch (error) {
    console.error('❌ Schema initialization failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

initSchema()
  .then(() => {
    console.log('\n✅ Initialization script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Initialization script failed:', error);
    process.exit(1);
  });
