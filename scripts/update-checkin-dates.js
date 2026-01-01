import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

async function updateCheckinDates() {
  try {
    console.log('🔄 Connecting to database...');
    
    // Get yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    // Get today's date
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    console.log(`📅 Yesterday: ${yesterdayStr}`);
    console.log(`📅 Today: ${todayStr}`);
    
    // First, check how many rooms have yesterday's checkin date
    const checkResult = await pool.query(
      `SELECT room_number, guest_name, checkin_date 
       FROM rooms 
       WHERE checkin_date = $1::date`,
      [yesterdayStr]
    );
    
    console.log(`\n📊 Found ${checkResult.rows.length} rooms with checkin_date = ${yesterdayStr}:`);
    checkResult.rows.forEach(row => {
      console.log(`   - Room ${row.room_number}: ${row.guest_name || 'N/A'} (${row.checkin_date})`);
    });
    
    if (checkResult.rows.length === 0) {
      console.log('\n✅ No rooms found with yesterday\'s checkin date. Nothing to update.');
      await pool.end();
      return;
    }
    
    // Update checkin_date to today
    const updateResult = await pool.query(
      `UPDATE rooms 
       SET checkin_date = $1::date 
       WHERE checkin_date = $2::date 
       RETURNING room_number, guest_name, checkin_date`,
      [todayStr, yesterdayStr]
    );
    
    console.log(`\n✅ Successfully updated ${updateResult.rows.length} rooms:`);
    updateResult.rows.forEach(row => {
      console.log(`   - Room ${row.room_number}: ${row.guest_name || 'N/A'} → checkin_date: ${row.checkin_date}`);
    });
    
    // Also update messages' checkin_date if they reference these rooms
    const messagesUpdateResult = await pool.query(
      `UPDATE messages 
       SET checkin_date = $1::date 
       WHERE checkin_date = $2::date 
       RETURNING COUNT(*) as count`,
      [todayStr, yesterdayStr]
    );
    
    console.log(`\n📨 Updated ${messagesUpdateResult.rows[0]?.count || 0} messages' checkin_date`);
    
    console.log('\n✅ Update completed successfully!');
    
  } catch (error) {
    console.error('❌ Error updating checkin dates:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

updateCheckinDates();

