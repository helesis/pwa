import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { randomBytes, createHash } from 'crypto';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);

// CORS Configuration - Production ready
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['http://localhost:3000', 'http://localhost:5173'];

const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? allowedOrigins 
      : "*",
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? allowedOrigins 
    : "*",
  credentials: true
}));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' })); // Increase limit for restaurant photos
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Create uploads directory if it doesn't exist
const uploadsDir = join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = file.originalname.split('.').pop();
    cb(null, `${file.fieldname}-${uniqueSuffix}.${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow images and videos
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'), false);
    }
  }
});

// Serve uploaded files statically
// Note: Render.com uses ephemeral storage - files are lost on server restart
// For production, consider using cloud storage (S3, Cloudinary, etc.)
app.use('/uploads', (req, res, next) => {
  // Check if file exists first before trying to serve
  const filename = req.path.substring(1); // Remove leading slash
  if (filename) {
    const filePath = join(uploadsDir, filename);
    if (!fs.existsSync(filePath)) {
      // File not found - log warning
      console.warn(`Uploaded file not found: ${filename}`);
      // Return 404 with proper error message
      // Note: Render.com uses ephemeral storage, files are lost on server restart
      return res.status(404).json({ 
        error: 'File not found',
        message: 'The requested file may have been removed or the server was restarted. Please re-upload the file.',
        filename: filename,
        note: 'Render.com uses ephemeral storage - files are lost on server restart'
      });
    }
  }
  // File exists or no filename, let static middleware handle it
  next();
}, express.static(uploadsDir, {
  setHeaders: (res, path) => {
    // Set proper cache headers for uploaded files
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache
  }
}));

// Service worker should never be cached
app.get('/service-worker.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(join(__dirname, 'public', 'service-worker.js'));
});

app.use(express.static('public'));

// PostgreSQL Database Setup
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: process.env.NODE_ENV === 'production' ? 10 : 20, // Production'da daha az connection (Render.com limitleri için)
  idleTimeoutMillis: process.env.NODE_ENV === 'production' ? 60000 : 30000, // Production'da daha uzun idle timeout
  connectionTimeoutMillis: process.env.NODE_ENV === 'production' ? 10000 : 2000, // Production'da daha uzun connection timeout
  allowExitOnIdle: false, // Pool'u açık tut
  statement_timeout: 30000, // Query timeout (30 saniye)
  query_timeout: 30000, // Query timeout (30 saniye)
});

// Test database connection - sadece ilk connection'da log
let isFirstConnection = true;
pool.on('connect', () => {
  if (isFirstConnection) {
    logDebug('PostgreSQL connection pool initialized');
    isFirstConnection = false;
  }
});

pool.on('error', (err) => {
  console.error('❌ [ERROR] PostgreSQL pool error:', err.message);
  console.error('   Stack:', err.stack);
});

// Retry helper function for database queries
async function retryQuery(queryFn, maxRetries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await queryFn();
    } catch (error) {
      const isTimeoutError = error.message?.includes('timeout') || 
                            error.message?.includes('Connection terminated') ||
                            error.message?.includes('Connection terminated due to connection timeout');
      
      if (isTimeoutError && attempt < maxRetries) {
        const waitTime = delay * attempt;
        logDebug(`Database query timeout (attempt ${attempt}/${maxRetries}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      // Last attempt or non-timeout error - throw it
      throw error;
    }
  }
}

// Initialize database tables
async function initializeDatabase() {
  const initStartTime = Date.now();
  logDebug('Initializing database...');
  
  try {
    // Check if tables already exist
    const checkResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'rooms'
      );
    `);
    
    const tablesExist = checkResult.rows[0].exists;
    
    if (tablesExist) {
      await addNewTablesIfNeeded();
      logDebug(`Database initialized (${((Date.now() - initStartTime) / 1000).toFixed(2)}s)`);
      return;
    }
    
    const createStartTime = Date.now();
    
    // Create tables with new structure
    await pool.query(`
      -- Rooms table (guests)
      CREATE TABLE rooms (
        id SERIAL PRIMARY KEY,
        room_number VARCHAR(50) NOT NULL,
        guest_name VARCHAR(100) NOT NULL,
        guest_surname VARCHAR(100) NOT NULL,
        checkin_date DATE NOT NULL,
        checkout_date DATE NOT NULL,
        guest_unique_id VARCHAR(255) NOT NULL UNIQUE,
        profile_photo TEXT,
        avatar_seed VARCHAR(255),
        avatar_style VARCHAR(50) DEFAULT 'avataaars',
        ghost_mode BOOLEAN DEFAULT false,
        adult_count INTEGER DEFAULT 1,
        child_count INTEGER DEFAULT 0,
        agency VARCHAR(100),
        country VARCHAR(100),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Assistants table (email removed, spoken_languages added)
      CREATE TABLE assistants (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        surname VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255),
        spoken_languages TEXT,
        avatar TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Teams table
      CREATE TABLE teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        avatar TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Messages table (using guest_unique_id instead of room_number + checkin_date)
      CREATE TABLE messages (
        id SERIAL PRIMARY KEY,
        guest_unique_id VARCHAR(255) NOT NULL REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
        sender_type VARCHAR(20) NOT NULL,
        assistant_id INTEGER REFERENCES assistants(id) ON DELETE SET NULL,
        message TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP,
        read_at TIMESTAMP
      );

      -- Assistant-Team assignments
      CREATE TABLE assistant_teams (
        id SERIAL PRIMARY KEY,
        assistant_id INTEGER REFERENCES assistants(id) ON DELETE CASCADE,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(assistant_id, team_id)
      );

      -- Team-Room assignments (using guest_unique_id)
      CREATE TABLE team_room_assignments (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(team_id, guest_unique_id)
      );

      -- Assistant-Room assignments (legacy support, using guest_unique_id)
      CREATE TABLE assistant_assignments (
        id SERIAL PRIMARY KEY,
        assistant_id INTEGER REFERENCES assistants(id) ON DELETE CASCADE,
        guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(assistant_id, guest_unique_id)
      );

      -- Indexes
      CREATE INDEX idx_rooms_guest_unique_id ON rooms(guest_unique_id);
      CREATE INDEX idx_rooms_room_checkin ON rooms(room_number, checkin_date);
      CREATE INDEX idx_messages_guest_unique_id ON messages(guest_unique_id);
      CREATE INDEX idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX idx_messages_assistant_id ON messages(assistant_id);
      CREATE INDEX idx_messages_delivered ON messages(delivered_at);
      CREATE INDEX idx_messages_read ON messages(read_at);
      CREATE INDEX idx_assistant_teams_assistant ON assistant_teams(assistant_id);
      CREATE INDEX idx_assistant_teams_team ON assistant_teams(team_id);
      CREATE INDEX idx_team_room_assignments_team ON team_room_assignments(team_id);
      CREATE INDEX idx_team_room_assignments_guest_unique_id ON team_room_assignments(guest_unique_id);
      CREATE INDEX idx_assistant_assignments_assistant ON assistant_assignments(assistant_id);
      CREATE INDEX idx_assistant_assignments_guest_unique_id ON assistant_assignments(guest_unique_id);

      -- Activities table (for timeline calendar only)
      CREATE TABLE activities (
        id SERIAL PRIMARY KEY,
        title VARCHAR(100) NOT NULL,
        icon VARCHAR(50),
        video_url TEXT,
        image_url TEXT,
        display_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        activity_date DATE,
        start_time TIME,
        end_time TIME,
        description TEXT,
        category VARCHAR(50),
        type VARCHAR(50),
        location VARCHAR(200),
        instructor_name VARCHAR(100),
        age_group VARCHAR(50),
        capacity INTEGER,
        featured BOOLEAN DEFAULT false,
        map_latitude DECIMAL(10, 8),
        map_longitude DECIMAL(11, 8),
        recurring_rule VARCHAR(50),
        recurring_until DATE,
        end_date DATE,
        rrule TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Story tray items table (separate from activities)
      CREATE TABLE story_tray_items (
        id SERIAL PRIMARY KEY,
        title VARCHAR(100) NOT NULL,
        icon VARCHAR(50),
        video_url TEXT,
        image_url TEXT,
        display_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Info Posts table
      CREATE TABLE info_posts (
        id SERIAL PRIMARY KEY,
        post_id VARCHAR(50) UNIQUE NOT NULL,
        title VARCHAR(100) NOT NULL,
        icon VARCHAR(50),
        location VARCHAR(200),
        image_url TEXT,
        video_url TEXT,
        caption TEXT,
        likes_count INTEGER DEFAULT 0,
        display_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Post Likes table
      CREATE TABLE post_likes (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES info_posts(id) ON DELETE CASCADE,
        guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(post_id, guest_unique_id)
      );

      -- Post Comments table
      CREATE TABLE post_comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES info_posts(id) ON DELETE CASCADE,
        guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
        comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Post Bookmarks table
      CREATE TABLE post_bookmarks (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES info_posts(id) ON DELETE CASCADE,
        guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(post_id, guest_unique_id)
      );

      -- Direct Messages table
      CREATE TABLE direct_messages (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES info_posts(id) ON DELETE CASCADE,
        from_guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
        to_guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Additional indexes
      CREATE INDEX idx_post_likes_post ON post_likes(post_id);
      CREATE INDEX idx_post_likes_guest ON post_likes(guest_unique_id);
      CREATE INDEX idx_post_comments_post ON post_comments(post_id);
      CREATE INDEX idx_post_comments_guest ON post_comments(guest_unique_id);
      CREATE INDEX idx_post_bookmarks_post ON post_bookmarks(post_id);
      CREATE INDEX idx_post_bookmarks_guest ON post_bookmarks(guest_unique_id);
      CREATE INDEX idx_dm_from ON direct_messages(from_guest_unique_id);
      CREATE INDEX idx_dm_to ON direct_messages(to_guest_unique_id);
      CREATE INDEX idx_dm_post ON direct_messages(post_id);

      -- User locations table (real-time tracking)
      CREATE TABLE user_locations (
        id SERIAL PRIMARY KEY,
        guest_unique_id VARCHAR(255) NOT NULL REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
        latitude DECIMAL(10, 8) NOT NULL,
        longitude DECIMAL(11, 8) NOT NULL,
        accuracy DECIMAL(8, 2),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes for user_locations
      CREATE INDEX idx_user_locations_guest ON user_locations(guest_unique_id);
      CREATE INDEX idx_user_locations_timestamp ON user_locations(timestamp DESC);

      -- Restaurants table (for A'la Carte reservations)
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

      CREATE INDEX idx_restaurants_active ON restaurants(active) WHERE deleted_at IS NULL;
      CREATE INDEX idx_restaurants_deleted ON restaurants(deleted_at) WHERE deleted_at IS NOT NULL;

      -- Restaurant Reservations table (simplified - for same-day reservations)
      CREATE TABLE IF NOT EXISTS restaurant_reservations (
        id SERIAL PRIMARY KEY,
        restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
        guest_unique_id VARCHAR(255) NOT NULL REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
        reservation_date DATE NOT NULL DEFAULT CURRENT_DATE,
        pax_adult INTEGER NOT NULL DEFAULT 0,
        pax_child INTEGER NOT NULL DEFAULT 0,
        total_price DECIMAL(10, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'TRY',
        status VARCHAR(20) DEFAULT 'confirmed',
        special_requests TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        cancelled_at TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT positive_pax CHECK (pax_adult >= 0 AND pax_child >= 0 AND (pax_adult + pax_child) > 0),
        CONSTRAINT positive_price CHECK (total_price >= 0)
      );

      CREATE INDEX idx_restaurant_reservations_guest ON restaurant_reservations(guest_unique_id, reservation_date);
      CREATE INDEX idx_restaurant_reservations_restaurant ON restaurant_reservations(restaurant_id, reservation_date);
      CREATE INDEX idx_restaurant_reservations_status ON restaurant_reservations(status) WHERE status != 'cancelled';
      CREATE INDEX idx_restaurant_reservations_date ON restaurant_reservations(reservation_date) WHERE status != 'cancelled';
    `);
    logDebug(`Database tables created (${((Date.now() - createStartTime) / 1000).toFixed(2)}s)`);
  } catch (error) {
    console.error(`Database initialization failed: ${error.message}`);
    throw error;
  }
}

// Add new tables if they don't exist (for existing databases)
async function addNewTablesIfNeeded() {
  try {
    // Check and add activities table
    const activitiesCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'activities'
      );
    `);
    
    if (!activitiesCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE activities (
          id SERIAL PRIMARY KEY,
          title VARCHAR(100) NOT NULL,
          icon VARCHAR(50),
          video_url TEXT,
          image_url TEXT,
          display_order INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT true,
          activity_date DATE,
          start_time TIME,
          end_time TIME,
          description TEXT,
          category VARCHAR(50),
          type VARCHAR(50),
          location VARCHAR(200),
          instructor_name VARCHAR(100),
          age_group VARCHAR(50),
          capacity INTEGER,
          featured BOOLEAN DEFAULT false,
          map_latitude DECIMAL(10, 8),
          map_longitude DECIMAL(11, 8),
          recurring_rule VARCHAR(50),
          recurring_until DATE,
          end_date DATE,
          is_story BOOLEAN DEFAULT false,
          rrule TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      logDebug('Created activities table');
      return;
    }
    
    // Check all missing columns in a single query
    const existingColumns = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND table_name = 'activities'
    `);
    
    const existingColumnNames = new Set(existingColumns.rows.map(r => r.column_name));
    
    // Add missing columns in batch
    const columnsToAdd = [
      { name: 'activity_date', type: 'DATE' },
      { name: 'start_time', type: 'TIME' },
      { name: 'end_time', type: 'TIME' },
      { name: 'end_date', type: 'DATE' },
      { name: 'description', type: 'TEXT' },
      { name: 'category', type: 'VARCHAR(50)' },
      { name: 'type', type: 'VARCHAR(50)' },
      { name: 'location', type: 'VARCHAR(200)' },
      { name: 'instructor_name', type: 'VARCHAR(100)' },
      { name: 'age_group', type: 'VARCHAR(50)' },
      { name: 'capacity', type: 'INTEGER' },
      { name: 'featured', type: 'BOOLEAN DEFAULT false' },
      { name: 'map_latitude', type: 'DECIMAL(10, 8)' },
      { name: 'map_longitude', type: 'DECIMAL(11, 8)' },
      { name: 'recurring_rule', type: 'VARCHAR(50)' },
      { name: 'recurring_until', type: 'DATE' },
      { name: 'is_story', type: 'BOOLEAN DEFAULT false' },
      { name: 'rrule', type: 'TEXT' }
    ];
    
    const missingColumns = columnsToAdd.filter(col => !existingColumnNames.has(col.name));
    
    if (missingColumns.length > 0) {
      logDebug(`Adding ${missingColumns.length} missing columns to activities table`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const col of missingColumns) {
          await client.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};`);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Failed to add columns: ${error.message}`);
        throw error;
      } finally {
        client.release();
      }
    }

    // Check and create story_tray_items table if it doesn't exist
    const storyTrayCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'story_tray_items'
      );
    `);
    
    if (!storyTrayCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE story_tray_items (
          id SERIAL PRIMARY KEY,
          title VARCHAR(100) NOT NULL,
          icon VARCHAR(50),
          video_url TEXT,
          image_url TEXT,
          display_order INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      logDebug('Created story_tray_items table');
      
      // Migrate existing is_story=true items to story_tray_items
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const migrationResult = await client.query(`
          INSERT INTO story_tray_items (title, icon, video_url, image_url, display_order, is_active, created_at, updated_at)
          SELECT title, icon, video_url, image_url, display_order, is_active, created_at, updated_at
          FROM activities
          WHERE is_story = true
          RETURNING id;
        `);
        const migratedCount = migrationResult.rowCount;
        
        if (migratedCount > 0) {
          logDebug(`Migrated ${migratedCount} story tray items`);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Failed to migrate story tray items: ${error.message}`);
      } finally {
        client.release();
      }
    }

    // Add avatar and ghost_mode columns to rooms table if they don't exist
    const avatarColumnCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'rooms' 
        AND column_name = 'avatar_seed'
      );
    `);
    
    if (!avatarColumnCheck.rows[0].exists) {
      await pool.query(`
        ALTER TABLE rooms 
        ADD COLUMN avatar_seed VARCHAR(255),
        ADD COLUMN avatar_style VARCHAR(50) DEFAULT 'avataaars',
        ADD COLUMN ghost_mode BOOLEAN DEFAULT false;
      `);
      logDebug('Added avatar columns to rooms table');
    }

    // Check and add opening_hour and closing_hour columns to restaurants table if they don't exist
    const restaurantsTableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'restaurants'
      );
    `);
    
    if (restaurantsTableCheck.rows[0].exists) {
      const openingHourCheck = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'restaurants' 
        AND column_name = 'opening_hour'
      `);
      
      const closingHourCheck = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'restaurants' 
        AND column_name = 'closing_hour'
      `);
      
      if (openingHourCheck.rows.length === 0) {
        await pool.query(`ALTER TABLE restaurants ADD COLUMN opening_hour VARCHAR(5);`);
        logDebug('Added opening_hour column to restaurants table');
      }
      
      if (closingHourCheck.rows.length === 0) {
        await pool.query(`ALTER TABLE restaurants ADD COLUMN closing_hour VARCHAR(5);`);
        logDebug('Added closing_hour column to restaurants table');
      }
    }

    // Check and add user_locations table
    const locationsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'user_locations'
      );
    `);
    
    if (!locationsCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE user_locations (
          id SERIAL PRIMARY KEY,
          guest_unique_id VARCHAR(255) NOT NULL REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
          latitude DECIMAL(10, 8) NOT NULL,
          longitude DECIMAL(11, 8) NOT NULL,
          accuracy DECIMAL(8, 2),
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX idx_user_locations_guest ON user_locations(guest_unique_id);
        CREATE INDEX idx_user_locations_timestamp ON user_locations(timestamp DESC);
      `);
      logDebug('Created user_locations table');
    }

    // Check and add map_search_locations table (for map search functionality)
    const mapSearchCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'map_search_locations'
      );
    `);
    
    if (!mapSearchCheck.rows[0].exists) {
      // Check if PostGIS extension exists
      let hasPostGIS = false;
      try {
        const postgisCheck = await pool.query(`
          SELECT EXISTS (
            SELECT FROM pg_extension WHERE extname = 'postgis'
          );
        `);
        hasPostGIS = postgisCheck.rows[0].exists;
        
        // Try to create PostGIS extension if it doesn't exist
        if (!hasPostGIS) {
          try {
            await pool.query('CREATE EXTENSION IF NOT EXISTS postgis;');
            hasPostGIS = true;
            logDebug('PostGIS extension created');
          } catch (extError) {
            logDebug('PostGIS extension not available, creating table without geom column');
          }
        }
      } catch (error) {
        logDebug('Could not check PostGIS extension, creating table without geom column');
      }
      
      // Create table with or without geom column based on PostGIS availability
      if (hasPostGIS) {
        await pool.query(`
          CREATE TABLE map_search_locations (
            id INTEGER PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            category VARCHAR(50) NOT NULL,
            latitude DECIMAL(10, 8) NOT NULL,
            longitude DECIMAL(11, 8) NOT NULL,
            distance_km DECIMAL(6, 2),
            geom GEOMETRY(Point, 4326),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
          
          CREATE INDEX idx_map_search_locations_geom ON map_search_locations USING GIST (geom);
          CREATE INDEX idx_map_search_locations_category ON map_search_locations(category);
        `);
        logDebug('Created map_search_locations table with PostGIS support');
      } else {
        await pool.query(`
          CREATE TABLE map_search_locations (
            id INTEGER PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            category VARCHAR(50) NOT NULL,
            latitude DECIMAL(10, 8) NOT NULL,
            longitude DECIMAL(11, 8) NOT NULL,
            distance_km DECIMAL(6, 2),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
          
          CREATE INDEX idx_map_search_locations_category ON map_search_locations(category);
        `);
        logDebug('Created map_search_locations table without PostGIS (geom column not available)');
      }
      
      // Insert default locations data
      const locations = [
        // Restaurant locations (1101-1136, 1201-1237, 1301-1337, 1401-1429)
        ...Array.from({length: 36}, (_, i) => ({id: 1101 + i, name: `Location ${1101 + i}`, category: 'Restaurant', lat: 36.757326638368916, lng: 31.419320129375695, dist: 2.8})),
        ...Array.from({length: 37}, (_, i) => ({id: 1201 + i, name: `Location ${1201 + i}`, category: 'Restaurant', lat: 36.757326638368916, lng: 31.419320129375695, dist: 2.8})),
        ...Array.from({length: 37}, (_, i) => ({id: 1301 + i, name: `Location ${1301 + i}`, category: 'Restaurant', lat: 36.757326638368916, lng: 31.419320129375695, dist: 2.8})),
        ...Array.from({length: 29}, (_, i) => ({id: 1401 + i, name: `Location ${1401 + i}`, category: 'Restaurant', lat: 36.757326638368916, lng: 31.419320129375695, dist: 2.8})),
        // Entertainment locations (4001-4072, 4101-4108)
        {id: 4001, name: 'Location 4001', category: 'Entertainment', lat: 36.75899418475455, lng: 31.41885376733623, dist: 2.86},
        {id: 4002, name: 'Location 4002', category: 'Entertainment', lat: 36.75899418475455, lng: 31.41885376733623, dist: 2.86},
        {id: 4003, name: 'Location 4003', category: 'Entertainment', lat: 36.75899418475455, lng: 31.41885376733623, dist: 2.86},
        {id: 4004, name: 'Location 4004', category: 'Entertainment', lat: 36.75899418475455, lng: 31.41885376733623, dist: 2.86},
        {id: 4005, name: 'Location 4005', category: 'Entertainment', lat: 36.75895980269552, lng: 31.419014699859424, dist: 2.84},
        {id: 4006, name: 'Location 4006', category: 'Entertainment', lat: 36.75895980269552, lng: 31.419014699859424, dist: 2.84},
        {id: 4007, name: 'Location 4007', category: 'Entertainment', lat: 36.75895980269552, lng: 31.419014699859424, dist: 2.84},
        {id: 4008, name: 'Location 4008', category: 'Entertainment', lat: 36.75895980269552, lng: 31.419014699859424, dist: 2.84},
        {id: 4009, name: 'Location 4009', category: 'Entertainment', lat: 36.75881797653912, lng: 31.418977148937348, dist: 2.84},
        {id: 4010, name: 'Location 4010', category: 'Entertainment', lat: 36.75881797653912, lng: 31.418977148937348, dist: 2.84},
        {id: 4011, name: 'Location 4011', category: 'Entertainment', lat: 36.75881797653912, lng: 31.418977148937348, dist: 2.84},
        {id: 4012, name: 'Location 4012', category: 'Entertainment', lat: 36.75881797653912, lng: 31.418977148937348, dist: 2.84},
        {id: 4013, name: 'Location 4013', category: 'Entertainment', lat: 36.75794552502077, lng: 31.41862309738633, dist: 2.87},
        {id: 4014, name: 'Location 4014', category: 'Entertainment', lat: 36.75794552502077, lng: 31.41862309738633, dist: 2.87},
        {id: 4015, name: 'Location 4015', category: 'Entertainment', lat: 36.75794552502077, lng: 31.41862309738633, dist: 2.87},
        {id: 4016, name: 'Location 4016', category: 'Entertainment', lat: 36.75794552502077, lng: 31.41862309738633, dist: 2.87},
        {id: 4017, name: 'Location 4017', category: 'Entertainment', lat: 36.75851713230893, lng: 31.41867137714329, dist: 2.87},
        {id: 4018, name: 'Location 4018', category: 'Entertainment', lat: 36.75851713230893, lng: 31.41867137714329, dist: 2.87},
        {id: 4019, name: 'Location 4019', category: 'Entertainment', lat: 36.75851713230893, lng: 31.41867137714329, dist: 2.87},
        {id: 4020, name: 'Location 4020', category: 'Entertainment', lat: 36.75851713230893, lng: 31.41867137714329, dist: 2.87},
        {id: 4021, name: 'Location 4021', category: 'Entertainment', lat: 36.758418283232885, lng: 31.418499715785217, dist: 2.88},
        {id: 4022, name: 'Location 4022', category: 'Entertainment', lat: 36.758418283232885, lng: 31.418499715785217, dist: 2.88},
        {id: 4023, name: 'Location 4023', category: 'Entertainment', lat: 36.758418283232885, lng: 31.418499715785217, dist: 2.88},
        {id: 4024, name: 'Location 4024', category: 'Entertainment', lat: 36.758418283232885, lng: 31.418499715785217, dist: 2.88},
        {id: 4025, name: 'Location 4025', category: 'Entertainment', lat: 36.7582936472598, lng: 31.418295867922517, dist: 2.9},
        {id: 4026, name: 'Location 4026', category: 'Entertainment', lat: 36.7582936472598, lng: 31.418295867922517, dist: 2.9},
        {id: 4027, name: 'Location 4027', category: 'Entertainment', lat: 36.7582936472598, lng: 31.418295867922517, dist: 2.9},
        {id: 4028, name: 'Location 4028', category: 'Entertainment', lat: 36.7582936472598, lng: 31.418295867922517, dist: 2.9},
        {id: 4029, name: 'Location 4029', category: 'Entertainment', lat: 36.7582936472598, lng: 31.417898901031982, dist: 2.94},
        {id: 4030, name: 'Location 4030', category: 'Entertainment', lat: 36.7582936472598, lng: 31.417898901031982, dist: 2.94},
        {id: 4031, name: 'Location 4031', category: 'Entertainment', lat: 36.7582936472598, lng: 31.417898901031982, dist: 2.94},
        {id: 4032, name: 'Location 4032', category: 'Entertainment', lat: 36.7582936472598, lng: 31.417898901031982, dist: 2.94},
        {id: 4033, name: 'Location 4033', category: 'Entertainment', lat: 36.75822488249828, lng: 31.418033011467976, dist: 2.92},
        {id: 4034, name: 'Location 4034', category: 'Entertainment', lat: 36.75822488249828, lng: 31.418033011467976, dist: 2.92},
        {id: 4035, name: 'Location 4035', category: 'Entertainment', lat: 36.75822488249828, lng: 31.418033011467976, dist: 2.92},
        {id: 4036, name: 'Location 4036', category: 'Entertainment', lat: 36.75822488249828, lng: 31.418033011467976, dist: 2.92},
        {id: 4037, name: 'Location 4037', category: 'Entertainment', lat: 36.75819479789574, lng: 31.418311961174833, dist: 2.9},
        {id: 4038, name: 'Location 4038', category: 'Entertainment', lat: 36.75819479789574, lng: 31.418311961174833, dist: 2.9},
        {id: 4039, name: 'Location 4039', category: 'Entertainment', lat: 36.75819479789574, lng: 31.418311961174833, dist: 2.9},
        {id: 4040, name: 'Location 4040', category: 'Entertainment', lat: 36.75819479789574, lng: 31.418311961174833, dist: 2.9},
        {id: 4041, name: 'Location 4041', category: 'Entertainment', lat: 36.757670464356586, lng: 31.418542631124733, dist: 2.87},
        {id: 4042, name: 'Location 4042', category: 'Entertainment', lat: 36.757670464356586, lng: 31.418542631124733, dist: 2.87},
        {id: 4043, name: 'Location 4043', category: 'Entertainment', lat: 36.757670464356586, lng: 31.418542631124733, dist: 2.87},
        {id: 4044, name: 'Location 4044', category: 'Entertainment', lat: 36.757670464356586, lng: 31.418542631124733, dist: 2.87},
        {id: 4045, name: 'Location 4045', category: 'Entertainment', lat: 36.758078757175426, lng: 31.418049104720293, dist: 2.92},
        {id: 4046, name: 'Location 4046', category: 'Entertainment', lat: 36.758078757175426, lng: 31.418049104720293, dist: 2.92},
        {id: 4047, name: 'Location 4047', category: 'Entertainment', lat: 36.758078757175426, lng: 31.418049104720293, dist: 2.92},
        {id: 4048, name: 'Location 4048', category: 'Entertainment', lat: 36.758078757175426, lng: 31.418049104720293, dist: 2.92},
        {id: 4049, name: 'Location 4049', category: 'Entertainment', lat: 36.757893951221384, lng: 31.41807056239005, dist: 2.92},
        {id: 4050, name: 'Location 4050', category: 'Entertainment', lat: 36.757893951221384, lng: 31.41807056239005, dist: 2.92},
        {id: 4051, name: 'Location 4051', category: 'Entertainment', lat: 36.757893951221384, lng: 31.41807056239005, dist: 2.92},
        {id: 4052, name: 'Location 4052', category: 'Entertainment', lat: 36.757893951221384, lng: 31.41807056239005, dist: 2.92},
        {id: 4053, name: 'Location 4053', category: 'Entertainment', lat: 36.757816590457246, lng: 31.41821003724348, dist: 2.91},
        {id: 4054, name: 'Location 4054', category: 'Entertainment', lat: 36.757816590457246, lng: 31.41821003724348, dist: 2.91},
        {id: 4055, name: 'Location 4055', category: 'Entertainment', lat: 36.757816590457246, lng: 31.41821003724348, dist: 2.91},
        {id: 4056, name: 'Location 4056', category: 'Entertainment', lat: 36.757816590457246, lng: 31.41821003724348, dist: 2.91},
        {id: 4057, name: 'Location 4057', category: 'Entertainment', lat: 36.75777361222123, lng: 31.418092020059806, dist: 2.92},
        {id: 4058, name: 'Location 4058', category: 'Entertainment', lat: 36.75777361222123, lng: 31.418092020059806, dist: 2.92},
        {id: 4059, name: 'Location 4059', category: 'Entertainment', lat: 36.75777361222123, lng: 31.418092020059806, dist: 2.92},
        {id: 4060, name: 'Location 4060', category: 'Entertainment', lat: 36.75777361222123, lng: 31.418092020059806, dist: 2.92},
        {id: 4061, name: 'Location 4061', category: 'Entertainment', lat: 36.75768765567699, lng: 31.418134935399323, dist: 2.91},
        {id: 4062, name: 'Location 4062', category: 'Entertainment', lat: 36.75768765567699, lng: 31.418134935399323, dist: 2.91},
        {id: 4063, name: 'Location 4063', category: 'Entertainment', lat: 36.75768765567699, lng: 31.418134935399323, dist: 2.91},
        {id: 4064, name: 'Location 4064', category: 'Entertainment', lat: 36.75768765567699, lng: 31.418134935399323, dist: 2.91},
        {id: 4065, name: 'Location 4065', category: 'Entertainment', lat: 36.757485657418854, lng: 31.417882807779666, dist: 2.93},
        {id: 4066, name: 'Location 4066', category: 'Entertainment', lat: 36.757485657418854, lng: 31.417882807779666, dist: 2.93},
        {id: 4067, name: 'Location 4067', category: 'Entertainment', lat: 36.757485657418854, lng: 31.417882807779666, dist: 2.93},
        {id: 4068, name: 'Location 4068', category: 'Entertainment', lat: 36.757485657418854, lng: 31.417882807779666, dist: 2.93},
        {id: 4069, name: 'Location 4069', category: 'Entertainment', lat: 36.757425487622115, lng: 31.418054469137733, dist: 2.92},
        {id: 4070, name: 'Location 4070', category: 'Entertainment', lat: 36.757425487622115, lng: 31.418054469137733, dist: 2.92},
        {id: 4071, name: 'Location 4071', category: 'Entertainment', lat: 36.757425487622115, lng: 31.418054469137733, dist: 2.92},
        {id: 4072, name: 'Location 4072', category: 'Entertainment', lat: 36.757425487622115, lng: 31.418054469137733, dist: 2.92},
        {id: 4101, name: 'Location 4101', category: 'Entertainment', lat: 36.75794552502077, lng: 31.41836024093179, dist: 2.89},
        {id: 4102, name: 'Location 4102', category: 'Entertainment', lat: 36.75794552502077, lng: 31.41836024093179, dist: 2.89},
        {id: 4103, name: 'Location 4103', category: 'Entertainment', lat: 36.75794552502077, lng: 31.41836024093179, dist: 2.89},
        {id: 4104, name: 'Location 4104', category: 'Entertainment', lat: 36.75794552502077, lng: 31.41836024093179, dist: 2.89},
        {id: 4105, name: 'Location 4105', category: 'Entertainment', lat: 36.75769625133575, lng: 31.41795790962382, dist: 2.93},
        {id: 4106, name: 'Location 4106', category: 'Entertainment', lat: 36.75769625133575, lng: 31.41795790962382, dist: 2.93},
        {id: 4107, name: 'Location 4107', category: 'Entertainment', lat: 36.75769625133575, lng: 31.41795790962382, dist: 2.93},
        {id: 4108, name: 'Location 4108', category: 'Entertainment', lat: 36.75769625133575, lng: 31.41795790962382, dist: 2.93},
        // Nature locations (6001-6032, 6101-6115, 6201-6215, 6301-6305)
        {id: 6001, name: 'Location 6001', category: 'Nature', lat: 36.75815181987165, lng: 31.419634290073684, dist: 2.78},
        {id: 6002, name: 'Location 6002', category: 'Nature', lat: 36.75815181987165, lng: 31.419634290073684, dist: 2.78},
        {id: 6003, name: 'Location 6003', category: 'Nature', lat: 36.75815181987165, lng: 31.419634290073684, dist: 2.78},
        {id: 6004, name: 'Location 6004', category: 'Nature', lat: 36.75815181987165, lng: 31.419634290073684, dist: 2.78},
        {id: 6005, name: 'Location 6005', category: 'Nature', lat: 36.75815181987165, lng: 31.419355340366824, dist: 2.8},
        {id: 6006, name: 'Location 6006', category: 'Nature', lat: 36.75815181987165, lng: 31.419355340366824, dist: 2.8},
        {id: 6007, name: 'Location 6007', category: 'Nature', lat: 36.75815181987165, lng: 31.419355340366824, dist: 2.8},
        {id: 6008, name: 'Location 6008', category: 'Nature', lat: 36.75815181987165, lng: 31.419355340366824, dist: 2.8},
        {id: 6009, name: 'Location 6009', category: 'Nature', lat: 36.75772203830625, lng: 31.419462628715614, dist: 2.79},
        {id: 6010, name: 'Location 6010', category: 'Nature', lat: 36.75772203830625, lng: 31.419462628715614, dist: 2.79},
        {id: 6011, name: 'Location 6011', category: 'Nature', lat: 36.75772203830625, lng: 31.419462628715614, dist: 2.79},
        {id: 6012, name: 'Location 6012', category: 'Nature', lat: 36.75772203830625, lng: 31.419462628715614, dist: 2.79},
        {id: 6013, name: 'Location 6013', category: 'Nature', lat: 36.75782518610156, lng: 31.41972012075272, dist: 2.77},
        {id: 6014, name: 'Location 6014', category: 'Nature', lat: 36.75782518610156, lng: 31.41972012075272, dist: 2.77},
        {id: 6015, name: 'Location 6015', category: 'Nature', lat: 36.75782518610156, lng: 31.41972012075272, dist: 2.77},
        {id: 6016, name: 'Location 6016', category: 'Nature', lat: 36.75782518610156, lng: 31.41972012075272, dist: 2.77},
        {id: 6017, name: 'Location 6017', category: 'Nature', lat: 36.75764467736874, lng: 31.419709391917838, dist: 2.77},
        {id: 6018, name: 'Location 6018', category: 'Nature', lat: 36.75764467736874, lng: 31.419709391917838, dist: 2.77},
        {id: 6019, name: 'Location 6019', category: 'Nature', lat: 36.75764467736874, lng: 31.419709391917838, dist: 2.77},
        {id: 6020, name: 'Location 6020', category: 'Nature', lat: 36.75764467736874, lng: 31.419709391917838, dist: 2.77},
        {id: 6021, name: 'Location 6021', category: 'Nature', lat: 36.75758450769675, lng: 31.41992396861542, dist: 2.75},
        {id: 6022, name: 'Location 6022', category: 'Nature', lat: 36.75758450769675, lng: 31.41992396861542, dist: 2.75},
        {id: 6023, name: 'Location 6023', category: 'Nature', lat: 36.75758450769675, lng: 31.41992396861542, dist: 2.75},
        {id: 6024, name: 'Location 6024', category: 'Nature', lat: 36.75758450769675, lng: 31.41992396861542, dist: 2.75},
        {id: 6025, name: 'Location 6025', category: 'Nature', lat: 36.75758450769675, lng: 31.41992396861542, dist: 2.75},
        {id: 6026, name: 'Location 6026', category: 'Nature', lat: 36.75758450769675, lng: 31.41992396861542, dist: 2.75},
        {id: 6027, name: 'Location 6027', category: 'Nature', lat: 36.75775642092009, lng: 31.420041985799095, dist: 2.74},
        {id: 6028, name: 'Location 6028', category: 'Nature', lat: 36.75775642092009, lng: 31.420041985799095, dist: 2.74},
        {id: 6029, name: 'Location 6029', category: 'Nature', lat: 36.75775642092009, lng: 31.420041985799095, dist: 2.74},
        {id: 6030, name: 'Location 6030', category: 'Nature', lat: 36.75775642092009, lng: 31.420041985799095, dist: 2.74},
        {id: 6031, name: 'Location 6031', category: 'Nature', lat: 36.75775642092009, lng: 31.420041985799095, dist: 2.74},
        {id: 6032, name: 'Location 6032', category: 'Nature', lat: 36.75775642092009, lng: 31.420041985799095, dist: 2.74},
        {id: 6101, name: 'Location 6101', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6102, name: 'Location 6102', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6103, name: 'Location 6103', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6104, name: 'Location 6104', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6105, name: 'Location 6105', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6106, name: 'Location 6106', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6107, name: 'Location 6107', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6108, name: 'Location 6108', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6109, name: 'Location 6109', category: 'Nature', lat: 36.757893951221384, lng: 31.419387526871464, dist: 2.8},
        {id: 6110, name: 'Location 6110', category: 'Nature', lat: 36.757893951221384, lng: 31.419387526871464, dist: 2.8},
        {id: 6111, name: 'Location 6111', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6112, name: 'Location 6112', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6113, name: 'Location 6113', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6114, name: 'Location 6114', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6115, name: 'Location 6115', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6201, name: 'Location 6201', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6202, name: 'Location 6202', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6203, name: 'Location 6203', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6204, name: 'Location 6204', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6205, name: 'Location 6205', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6206, name: 'Location 6206', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6207, name: 'Location 6207', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6208, name: 'Location 6208', category: 'Nature', lat: 36.75847845225084, lng: 31.419559188229528, dist: 2.79},
        {id: 6209, name: 'Location 6209', category: 'Nature', lat: 36.757893951221384, lng: 31.419387526871464, dist: 2.8},
        {id: 6210, name: 'Location 6210', category: 'Nature', lat: 36.757893951221384, lng: 31.419387526871464, dist: 2.8},
        {id: 6211, name: 'Location 6211', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6212, name: 'Location 6212', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6213, name: 'Location 6213', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6214, name: 'Location 6214', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6215, name: 'Location 6215', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6301, name: 'Location 6301', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6302, name: 'Location 6302', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6303, name: 'Location 6303', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6304, name: 'Location 6304', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75},
        {id: 6305, name: 'Location 6305', category: 'Nature', lat: 36.757988503160455, lng: 31.41995615512006, dist: 2.75}
      ];
      
      // Insert default locations data
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const loc of locations) {
          if (hasPostGIS) {
            await client.query(`
              INSERT INTO map_search_locations (id, name, category, latitude, longitude, distance_km, geom) 
              VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($5, $4), 4326))
              ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                category = EXCLUDED.category,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                distance_km = EXCLUDED.distance_km,
                geom = EXCLUDED.geom
            `, [loc.id, loc.name, loc.category, loc.lat, loc.lng, loc.dist]);
          } else {
            await client.query(`
              INSERT INTO map_search_locations (id, name, category, latitude, longitude, distance_km) 
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                category = EXCLUDED.category,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                distance_km = EXCLUDED.distance_km
            `, [loc.id, loc.name, loc.category, loc.lat, loc.lng, loc.dist]);
          }
        }
        await client.query('COMMIT');
        logDebug(`Inserted ${locations.length} map search locations`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Failed to insert map search locations:', error);
        throw error;
      } finally {
        client.release();
      }
    }

    // Check and add info_posts table
    const postsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'info_posts'
      );
    `);
    
    if (!postsCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE info_posts (
          id SERIAL PRIMARY KEY,
          post_id VARCHAR(50) UNIQUE NOT NULL,
          title VARCHAR(100) NOT NULL,
          icon VARCHAR(50),
          location VARCHAR(200),
          image_url TEXT,
          video_url TEXT,
          caption TEXT,
          likes_count INTEGER DEFAULT 0,
          display_order INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      logDebug('Created info_posts table');
    } else {
      // Add new columns if they don't exist (migration)
      const postColumnsToAdd = [
        { name: 'location', type: 'VARCHAR(200)' },
        { name: 'video_url', type: 'TEXT' }
      ];
      for (const col of postColumnsToAdd) {
        const columnCheck = await pool.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = 'info_posts' 
            AND column_name = $1
          );
        `, [col.name]);
        if (!columnCheck.rows[0].exists) {
          await pool.query(`ALTER TABLE info_posts ADD COLUMN ${col.name} ${col.type};`);
        }
      }
      
      // Migrate existing single image_url/video_url to JSON arrays
      const migrationCheck = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'info_posts' 
        AND column_name IN ('image_url', 'video_url')
      `);
      
      const hasImageUrl = migrationCheck.rows.some(r => r.column_name === 'image_url');
      const hasVideoUrl = migrationCheck.rows.some(r => r.column_name === 'video_url');
      
      if (hasImageUrl || hasVideoUrl) {
        // Check if already migrated (check if any value is JSON array)
        const sampleCheck = await pool.query(`
          SELECT image_url, video_url 
          FROM info_posts 
          LIMIT 1
        `);
        
        const needsMigration = sampleCheck.rows.length > 0 && 
          sampleCheck.rows[0].image_url && 
          !sampleCheck.rows[0].image_url.trim().startsWith('[');
        
        if (needsMigration) {
          logDebug('Migrating image_url and video_url to JSON arrays...');
          // Convert single values to JSON arrays
          await pool.query(`
            UPDATE info_posts 
            SET 
              image_url = CASE 
                WHEN image_url IS NOT NULL AND image_url != '' 
                THEN json_build_array(image_url)::text
                ELSE NULL 
              END,
              video_url = CASE 
                WHEN video_url IS NOT NULL AND video_url != '' 
                THEN json_build_array(video_url)::text
                ELSE NULL 
              END
          `);
          logDebug('Migration completed: image_url and video_url converted to JSON arrays');
        }
      }
    }

    // Check and add post_likes table
    const likesCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'post_likes'
      );
    `);
    
    if (!likesCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE post_likes (
          id SERIAL PRIMARY KEY,
          post_id INTEGER REFERENCES info_posts(id) ON DELETE CASCADE,
          guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(post_id, guest_unique_id)
        );
        CREATE INDEX idx_post_likes_post ON post_likes(post_id);
        CREATE INDEX idx_post_likes_guest ON post_likes(guest_unique_id);
      `);
      logDebug('Created post_likes table');
    }

    // Check and add post_comments table
    const commentsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'post_comments'
      );
    `);
    
    if (!commentsCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE post_comments (
          id SERIAL PRIMARY KEY,
          post_id INTEGER REFERENCES info_posts(id) ON DELETE CASCADE,
          guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
          comment TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_post_comments_post ON post_comments(post_id);
        CREATE INDEX idx_post_comments_guest ON post_comments(guest_unique_id);
      `);
      logDebug('Created post_comments table');
    }

    // Check and add post_bookmarks table
    const bookmarksCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'post_bookmarks'
      );
    `);
    
    if (!bookmarksCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE post_bookmarks (
          id SERIAL PRIMARY KEY,
          post_id INTEGER REFERENCES info_posts(id) ON DELETE CASCADE,
          guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(post_id, guest_unique_id)
        );
        CREATE INDEX idx_post_bookmarks_post ON post_bookmarks(post_id);
        CREATE INDEX idx_post_bookmarks_guest ON post_bookmarks(guest_unique_id);
      `);
      logDebug('Created post_bookmarks table');
    }

    // Check and add direct_messages table
    const dmCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'direct_messages'
      );
    `);
    
    if (!dmCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE direct_messages (
          id SERIAL PRIMARY KEY,
          post_id INTEGER REFERENCES info_posts(id) ON DELETE CASCADE,
          from_guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
          to_guest_unique_id VARCHAR(255) REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
          message TEXT NOT NULL,
          is_read BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_dm_from ON direct_messages(from_guest_unique_id);
        CREATE INDEX idx_dm_to ON direct_messages(to_guest_unique_id);
        CREATE INDEX idx_dm_post ON direct_messages(post_id);
      `);
      logDebug('Created direct_messages table');
    }

    // Check and add restaurants table
    const restaurantsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'restaurants'
      );
    `);
    
    if (!restaurantsCheck.rows[0].exists) {
      await pool.query(`
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
        CREATE INDEX idx_restaurants_active ON restaurants(active) WHERE deleted_at IS NULL;
        CREATE INDEX idx_restaurants_deleted ON restaurants(deleted_at) WHERE deleted_at IS NOT NULL;
      `);
      logDebug('Created restaurants table');
    }

    // Check and add restaurant_reservations table (only if restaurants table exists)
    // First check if restaurants table exists (required for foreign key)
    const restaurantsTableExistsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'restaurants'
      );
    `);
    
    if (!restaurantsTableExistsCheck.rows[0].exists) {
      console.log('⚠️ restaurants table does not exist, skipping restaurant_reservations table creation');
    } else {
      const restaurantReservationsCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'restaurant_reservations'
        );
      `);
      
      if (!restaurantReservationsCheck.rows[0].exists) {
        try {
          await pool.query(`
            CREATE TABLE restaurant_reservations (
              id SERIAL PRIMARY KEY,
              restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
            guest_unique_id VARCHAR(255) NOT NULL REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
            reservation_date DATE NOT NULL DEFAULT CURRENT_DATE,
            pax_adult INTEGER NOT NULL DEFAULT 0,
            pax_child INTEGER NOT NULL DEFAULT 0,
            total_price DECIMAL(10, 2) NOT NULL,
            currency VARCHAR(3) NOT NULL DEFAULT 'TRY',
            status VARCHAR(20) DEFAULT 'confirmed',
            special_requests TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            cancelled_at TIMESTAMP WITH TIME ZONE NULL,
            CONSTRAINT positive_pax CHECK (pax_adult >= 0 AND pax_child >= 0 AND (pax_adult + pax_child) > 0),
            CONSTRAINT positive_price CHECK (total_price >= 0)
          );
        `);
        
        // Create indexes (check if they exist first for older PostgreSQL versions)
        try {
          const guestIndexCheck = await pool.query(`
            SELECT EXISTS (
              SELECT FROM pg_indexes 
              WHERE schemaname = 'public' 
              AND tablename = 'restaurant_reservations' 
              AND indexname = 'idx_restaurant_reservations_guest'
            );
          `);
          
          if (!guestIndexCheck.rows[0].exists) {
            await pool.query(`
              CREATE INDEX idx_restaurant_reservations_guest ON restaurant_reservations(guest_unique_id, reservation_date);
            `);
          }
          
          const restaurantIndexCheck = await pool.query(`
            SELECT EXISTS (
              SELECT FROM pg_indexes 
              WHERE schemaname = 'public' 
              AND tablename = 'restaurant_reservations' 
              AND indexname = 'idx_restaurant_reservations_restaurant'
            );
          `);
          
          if (!restaurantIndexCheck.rows[0].exists) {
            await pool.query(`
              CREATE INDEX idx_restaurant_reservations_restaurant ON restaurant_reservations(restaurant_id, reservation_date);
            `);
          }
          
          // Conditional indexes
          const statusIndexCheck = await pool.query(`
            SELECT EXISTS (
              SELECT FROM pg_indexes 
              WHERE schemaname = 'public' 
              AND tablename = 'restaurant_reservations' 
              AND indexname = 'idx_restaurant_reservations_status'
            );
          `);
          
          if (!statusIndexCheck.rows[0].exists) {
            await pool.query(`
              CREATE INDEX idx_restaurant_reservations_status ON restaurant_reservations(status) WHERE status != 'cancelled';
            `);
          }
          
          const dateIndexCheck = await pool.query(`
            SELECT EXISTS (
              SELECT FROM pg_indexes 
              WHERE schemaname = 'public' 
              AND tablename = 'restaurant_reservations' 
              AND indexname = 'idx_restaurant_reservations_date'
            );
          `);
          
          if (!dateIndexCheck.rows[0].exists) {
            await pool.query(`
              CREATE INDEX idx_restaurant_reservations_date ON restaurant_reservations(reservation_date) WHERE status != 'cancelled';
            `);
          }
        } catch (indexError) {
          console.warn('Warning: Some indexes may already exist:', indexError.message);
          // Continue - indexes are optional
        }
        
          logDebug('✅ Created restaurant_reservations table and indexes');
        } catch (error) {
          console.error('❌ Error creating restaurant_reservations table:', error.message);
          console.error('   Stack:', error.stack);
          // Continue with other tables even if this fails - table might already exist
        }
      } else {
        logDebug('restaurant_reservations table already exists');
      }
    }

    // Check and create SPA services table if it doesn't exist
    const spaServicesCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'spa_services'
      );
    `);

    if (!spaServicesCheck.rows[0].exists) {
      try {
        await pool.query(`
          CREATE TABLE spa_services (
            id VARCHAR(50) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            duration_min INTEGER NOT NULL,
            price DECIMAL(10, 2) NOT NULL,
            currency VARCHAR(3) DEFAULT 'EUR',
            category VARCHAR(100),
            short_description TEXT,
            description TEXT,
            is_active BOOLEAN DEFAULT true,
            display_order INTEGER DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);
        
        await pool.query(`
          CREATE INDEX idx_spa_services_active ON spa_services(is_active) WHERE is_active = true;
          CREATE INDEX idx_spa_services_display_order ON spa_services(display_order);
        `);
        
        logDebug('✅ Created spa_services table and indexes');
      } catch (error) {
        console.error('❌ Error creating spa_services table:', error.message);
        console.error('   Stack:', error.stack);
        // Don't continue if spa_services fails - other tables depend on it
        throw error;
      }
    }

    // Check and create SPA availability table (snapshot from MSSQL replica)
    const spaAvailabilityCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'spa_availability'
      );
    `);

    if (!spaAvailabilityCheck.rows[0].exists) {
      try {
        // Create table first (without UNIQUE constraint - will add as index)
        await pool.query(`
          CREATE TABLE spa_availability (
            id SERIAL PRIMARY KEY,
            service_id VARCHAR(50) NOT NULL REFERENCES spa_services(id) ON DELETE CASCADE,
            date DATE NOT NULL,
            start_time TIMESTAMP WITH TIME ZONE NOT NULL,
            end_time TIMESTAMP WITH TIME ZONE NOT NULL,
            availability_status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
            therapist_id VARCHAR(50),
            therapist_display_name VARCHAR(255),
            therapist_level VARCHAR(50),
            therapist_tags JSONB DEFAULT '[]'::jsonb,
            last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);
        
        // Create regular indexes
        await pool.query(`
          CREATE INDEX idx_spa_availability_service_date ON spa_availability(service_id, date);
          CREATE INDEX idx_spa_availability_start_time ON spa_availability(start_time);
          CREATE INDEX idx_spa_availability_status ON spa_availability(availability_status);
          CREATE INDEX idx_spa_availability_last_updated ON spa_availability(last_updated_at);
        `);
        
        // Create unique index separately (handling NULL therapist_id)
        await pool.query(`
          CREATE UNIQUE INDEX idx_spa_availability_unique_slot_therapist 
          ON spa_availability(service_id, date, start_time, COALESCE(therapist_id, ''));
        `);
        
        logDebug('✅ Created spa_availability table and indexes');
      } catch (error) {
        console.error('❌ Error creating spa_availability table:', error.message);
        console.error('   Stack:', error.stack);
        // Continue with other tables even if this fails
      }
    }

    // Check and create SPA requests table
    const spaRequestsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'spa_requests'
      );
    `);

    if (!spaRequestsCheck.rows[0].exists) {
      try {
        // Create table first
        await pool.query(`
          CREATE TABLE spa_requests (
            id SERIAL PRIMARY KEY,
            request_id VARCHAR(100) UNIQUE NOT NULL,
            guest_unique_id VARCHAR(255) NOT NULL REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
            service_id VARCHAR(50) NOT NULL REFERENCES spa_services(id),
            start_time TIMESTAMP WITH TIME ZONE NOT NULL,
            end_time TIMESTAMP WITH TIME ZONE NOT NULL,
            therapist_id VARCHAR(50),
            therapist_display_name VARCHAR(255),
            note TEXT,
            status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            cancelled_at TIMESTAMP WITH TIME ZONE NULL,
            confirmed_at TIMESTAMP WITH TIME ZONE NULL,
            rejected_at TIMESTAMP WITH TIME ZONE NULL
          );
        `);
        
        // Create indexes separately
        await pool.query(`
          CREATE INDEX idx_spa_requests_guest_unique_id ON spa_requests(guest_unique_id);
          CREATE INDEX idx_spa_requests_status ON spa_requests(status);
          CREATE INDEX idx_spa_requests_start_time ON spa_requests(start_time);
          CREATE INDEX idx_spa_requests_service_id ON spa_requests(service_id);
          CREATE INDEX idx_spa_requests_request_id ON spa_requests(request_id);
        `);
        
        logDebug('Created spa_requests table');
      } catch (error) {
        console.error('❌ Error creating spa_requests table:', error.message);
        console.error('   Stack:', error.stack);
        // Don't throw - continue with seed data
      }
    }

    // Check and add hotel_settings table
    const hotelSettingsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'hotel_settings'
      );
    `);
    
    if (!hotelSettingsCheck.rows[0].exists) {
      try {
        await pool.query(`
          CREATE TABLE hotel_settings (
            setting_key VARCHAR(255) PRIMARY KEY,
            settings_json JSONB NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);
        logDebug('Created hotel_settings table');
      } catch (error) {
        console.error('❌ Error creating hotel_settings table:', error.message);
      }
    }

    // Seed initial data if tables are empty
    await seedInitialData();
    
    // Seed SPA test data (one-time only)
    await seedSpaTestData();
  } catch (error) {
    console.error('Error adding new tables:', error);
    // Don't throw, just log - existing tables might have foreign key constraints
  }
}

// Seed initial data for story_tray_items and info_posts
async function seedInitialData() {
  try {
    // Check if story_tray_items table exists and has data
    const storyTrayCheck = await pool.query('SELECT COUNT(*) as count FROM story_tray_items');
    const storyTrayCount = parseInt(storyTrayCheck.rows[0]?.count || 0);

    // Seed story tray items if empty
    if (storyTrayCount === 0) {
      const storyActivities = [
        {
          title: 'Yüzme Havuzu',
          icon: 'waves',
          display_order: 1,
          is_active: true
        },
        {
          title: 'Plaj',
          icon: 'sun',
          display_order: 2,
          is_active: true
        },
        {
          title: 'Restoran',
          icon: 'utensils-crossed',
          display_order: 3,
          is_active: true
        },
        {
          title: 'Spa',
          icon: 'sparkles',
          display_order: 4,
          is_active: true
        },
        {
          title: 'Aktiviteler',
          icon: 'party-popper',
          display_order: 5,
          is_active: true
        }
      ];

      for (const activity of storyActivities) {
        await pool.query(`
          INSERT INTO story_tray_items (title, icon, display_order, is_active)
          VALUES ($1, $2, $3, $4)
        `, [activity.title, activity.icon, activity.display_order, activity.is_active]);
      }
      logDebug('Seeded initial story tray items');
    }

    // Check if info_posts table exists and has data
    const postsCheck = await pool.query('SELECT COUNT(*) as count FROM info_posts');
    const postsCount = parseInt(postsCheck.rows[0]?.count || 0);

    // Seed info posts if empty
    if (postsCount === 0) {
      const posts = [
        {
          post_id: 'restaurants',
          title: 'Restoranlar',
          icon: 'utensils-crossed',
          caption: 'Lezzet dolu bir yolculuk sizi bekliyor! 🍽️',
          location: 'Voyage Sorgun',
          display_order: 1,
          is_active: true
        },
        {
          post_id: 'beach-pools',
          title: 'Plaj ve Havuzlar',
          icon: 'sun',
          caption: 'Serin sular ve altın kumlar sizi bekliyor! 🏖️',
          location: 'Voyage Sorgun',
          display_order: 2,
          is_active: true
        },
        {
          post_id: 'wellness',
          title: 'Sağlıklı Yaşam',
          icon: 'dumbbell',
          caption: 'Sağlıklı yaşam için tesislerimiz sizlerle! 💪',
          location: 'Voyage Sorgun',
          display_order: 3,
          is_active: true
        },
        {
          post_id: 'sense-spa',
          title: 'Sense Spa',
          icon: 'sparkles',
          caption: 'Ruhunuzu ve bedeninizi yenileyin! 💆',
          location: 'Voyage Sorgun',
          display_order: 4,
          is_active: true
        },
        {
          post_id: 'kids',
          title: 'Çocuklar',
          icon: 'baby',
          caption: 'Çocuklarınız için eğlence dolu aktiviteler! 👶',
          location: 'Voyage Sorgun',
          display_order: 5,
          is_active: true
        },
        {
          post_id: 'voyage-assistant',
          title: 'Voyage Asistan',
          icon: 'bot',
          caption: 'Size yardımcı olmak için buradayız! 🤖',
          location: 'Voyage Sorgun',
          display_order: 6,
          is_active: true
        },
        {
          post_id: 'rewards',
          title: 'Ödüller',
          icon: 'trophy',
          caption: 'Ödüllerinizi keşfedin ve kazanın! 🏆',
          location: 'Voyage Sorgun',
          display_order: 7,
          is_active: true
        }
      ];

      for (const post of posts) {
        await pool.query(`
          INSERT INTO info_posts (post_id, title, icon, caption, location, display_order, is_active)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (post_id) DO NOTHING
        `, [post.post_id, post.title, post.icon, post.caption, post.location, post.display_order, post.is_active]);
      }
      logDebug('Seeded initial info posts');
    }
  } catch (error) {
    console.error('Error seeding initial data:', error);
    // Don't throw, just log - this is optional initialization
  }
}

// Seed SPA test data (services, therapists, availability)
async function seedSpaTestData() {
  try {
    // Check if spa_services table has data
    const servicesCheck = await pool.query('SELECT COUNT(*) as count FROM spa_services');
    const servicesCount = parseInt(servicesCheck.rows[0]?.count || 0);
    
    // Only seed if tables are empty (one-time only)
    if (servicesCount > 0) {
      logDebug('SPA services already exist, skipping test data seed');
      return;
    }
    
    logDebug('Seeding SPA test data...');
    
    // 1. Seed SPA Services (3-4 services)
    const services = [
      {
        id: 'svc_1',
        name: 'Swedish Massage',
        duration_min: 50,
        price: 120,
        currency: 'EUR',
        category: 'Massage',
        short_description: 'Relaxing full-body massage',
        description: 'Classic Swedish massage technique for complete relaxation and stress relief',
        display_order: 1
      },
      {
        id: 'svc_2',
        name: 'Deep Tissue Massage',
        duration_min: 60,
        price: 150,
        currency: 'EUR',
        category: 'Massage',
        short_description: 'Intensive muscle therapy',
        description: 'Deep pressure massage to release chronic muscle tension',
        display_order: 2
      },
      {
        id: 'svc_3',
        name: 'Hot Stone Massage',
        duration_min: 75,
        price: 180,
        currency: 'EUR',
        category: 'Massage',
        short_description: 'Heated stones for deep relaxation',
        description: 'Smooth heated stones combined with massage for ultimate relaxation',
        display_order: 3
      },
      {
        id: 'svc_4',
        name: 'Aromatherapy Massage',
        duration_min: 50,
        price: 130,
        currency: 'EUR',
        category: 'Massage',
        short_description: 'Essential oils massage',
        description: 'Massage with essential oils for enhanced relaxation and healing',
        display_order: 4
      }
    ];
    
    for (const service of services) {
      await pool.query(`
        INSERT INTO spa_services (id, name, duration_min, price, currency, category, short_description, description, display_order, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
        ON CONFLICT (id) DO NOTHING
      `, [
        service.id,
        service.name,
        service.duration_min,
        service.price,
        service.currency,
        service.category,
        service.short_description,
        service.description,
        service.display_order
      ]);
    }
    
    logDebug(`✅ Seeded ${services.length} SPA services`);
    
    // 2. Seed Therapists (7 therapists)
    const therapists = [
      { id: 't_1', name: 'Ayşe', level: 'Senior', tags: ['Relax', 'Aromatherapy'] },
      { id: 't_2', name: 'Mehmet', level: 'Standard', tags: ['Sports', 'Deep Tissue'] },
      { id: 't_3', name: 'Zeynep', level: 'Senior', tags: ['Hot Stone', 'Relax'] },
      { id: 't_4', name: 'Can', level: 'Standard', tags: ['Sports', 'Aromatherapy'] },
      { id: 't_5', name: 'Elif', level: 'Senior', tags: ['Relax', 'Hot Stone', 'Aromatherapy'] },
      { id: 't_6', name: 'Burak', level: 'Standard', tags: ['Deep Tissue', 'Sports'] },
      { id: 't_7', name: 'Selin', level: 'Senior', tags: ['Relax', 'Aromatherapy', 'Hot Stone'] }
    ];
    
    // 3. Seed Availability Data (7 days, multiple slots per day)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Time slots (9:00 to 18:00, 50-minute sessions)
    const timeSlots = [
      { start: 9, end: 9.83 },    // 9:00-9:50
      { start: 10, end: 10.83 },  // 10:00-10:50
      { start: 11, end: 11.83 },  // 11:00-11:50
      { start: 12, end: 12.83 },  // 12:00-12:50
      { start: 14, end: 14.83 },  // 14:00-14:50
      { start: 15, end: 15.83 },  // 15:00-15:50
      { start: 16, end: 16.83 },  // 16:00-16:50
      { start: 17, end: 17.83 }   // 17:00-17:50
    ];
    
    let availabilityCount = 0;
    
    // Generate 7 days of availability
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const currentDate = new Date(today);
      currentDate.setDate(today.getDate() + dayOffset);
      const dateStr = currentDate.toISOString().split('T')[0];
      
      // For each service
      for (const service of services) {
        // For each time slot
        for (const slot of timeSlots) {
          // Randomly decide if slot is available (80% chance available, 15% limited, 5% full)
          const rand = Math.random();
          let availability_status = 'AVAILABLE';
          let therapistCount = 0;
          
          if (rand < 0.80) {
            availability_status = 'AVAILABLE';
            therapistCount = Math.floor(Math.random() * 4) + 3; // 3-6 therapists
          } else if (rand < 0.95) {
            availability_status = 'LIMITED';
            therapistCount = Math.floor(Math.random() * 2) + 1; // 1-2 therapists
          } else {
            availability_status = 'FULL';
            therapistCount = 0;
          }
          
          // Create timezone-aware timestamps (Europe/Istanbul - UTC+3)
          const startDateTime = new Date(`${dateStr}T${String(Math.floor(slot.start)).padStart(2, '0')}:${String(Math.floor((slot.start % 1) * 60)).padStart(2, '0')}:00+03:00`);
          const endDateTime = new Date(`${dateStr}T${String(Math.floor(slot.end)).padStart(2, '0')}:${String(Math.floor((slot.end % 1) * 60)).padStart(2, '0')}:00+03:00`);
          
          // If FULL, insert one row with empty string for therapist_id (to match unique index)
          if (availability_status === 'FULL') {
            try {
              await pool.query(`
                INSERT INTO spa_availability (
                  service_id, date, start_time, end_time, 
                  availability_status, therapist_id, therapist_display_name, 
                  therapist_level, therapist_tags, last_updated_at
                )
                VALUES ($1, $2::date, $3, $4, $5, '', NULL, NULL, '[]'::jsonb, CURRENT_TIMESTAMP)
              `, [service.id, dateStr, startDateTime.toISOString(), endDateTime.toISOString(), availability_status]);
              availabilityCount++;
            } catch (error) {
              // Ignore unique constraint errors (already exists)
              if (!error.message.includes('unique') && !error.message.includes('duplicate')) {
                console.error('Error inserting FULL slot:', error.message);
              }
            }
          } else {
            // For AVAILABLE/LIMITED, assign random therapists
            const shuffledTherapists = [...therapists].sort(() => Math.random() - 0.5);
            const selectedTherapists = shuffledTherapists.slice(0, therapistCount);
            
            for (const therapist of selectedTherapists) {
              try {
                await pool.query(`
                  INSERT INTO spa_availability (
                    service_id, date, start_time, end_time, 
                    availability_status, therapist_id, therapist_display_name, 
                    therapist_level, therapist_tags, last_updated_at
                  )
                  VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9::jsonb, CURRENT_TIMESTAMP)
                `, [
                  service.id,
                  dateStr,
                  startDateTime.toISOString(),
                  endDateTime.toISOString(),
                  availability_status,
                  therapist.id,
                  therapist.name,
                  therapist.level,
                  JSON.stringify(therapist.tags)
                ]);
                availabilityCount++;
              } catch (error) {
                // Ignore unique constraint errors (already exists)
                if (!error.message.includes('unique') && !error.message.includes('duplicate')) {
                  console.error('Error inserting therapist slot:', error.message);
                }
              }
            }
          }
        }
      }
    }
    
    logDebug(`✅ Seeded ${availabilityCount} availability records for 7 days`);
    logDebug('✅ SPA test data seeding completed');
    
  } catch (error) {
    console.error('❌ Error seeding SPA test data:', error);
    console.error('   Stack:', error.stack);
    // Don't throw - this is optional test data
  }
}

// Initialize on startup (test data will be initialized after DB setup)

// Log helper - Production'da sadece önemli loglar
const isProduction = process.env.NODE_ENV === 'production';
const LOG_DEBUG = process.env.LOG_DEBUG === 'true';

function logDebug(...args) {
  if (!isProduction || LOG_DEBUG) {
    console.log(...args);
  }
}

function logInfo(...args) {
  console.log(...args);
}

// Generate guest unique ID from name, surname, checkin_date and checkout_date
function generateGuestUniqueId(guestName, guestSurname, checkinDate, checkoutDate) {
  if (!checkinDate) {
    return null;
  }
  
  // Normalize inputs - use 'Guest' if name is not provided
  const name = (guestName || guestSurname || 'Guest').trim().toLowerCase().replace(/\s+/g, '_');
  const surname = (guestSurname || '').trim().toLowerCase().replace(/\s+/g, '_');
  const checkin = checkinDate instanceof Date 
    ? checkinDate.toISOString().split('T')[0] 
    : String(checkinDate).split('T')[0];
  const checkout = checkoutDate instanceof Date 
    ? checkoutDate.toISOString().split('T')[0] 
    : (checkoutDate ? String(checkoutDate).split('T')[0] : '');
  
  // Create unique ID: name_surname_checkin_checkout (hash for uniqueness)
  const combined = checkout 
    ? `${name}_${surname}_${checkin}_${checkout}`
    : `${name}_${surname}_${checkin}`;
  
  // Use crypto to create a short hash
  const hash = createHash('sha256').update(combined).digest('hex').substring(0, 16);
  
  return checkout 
    ? `${name}_${surname}_${checkin}_${checkout}_${hash}`
    : `${name}_${surname}_${checkin}_${hash}`;
}

// Socket.IO Connection
io.on('connection', (socket) => {
  logDebug('🟢 ========== NEW CLIENT CONNECTION ==========');
  logDebug('🟢 Socket ID:', socket.id);
  logDebug('🟢 Time:', new Date().toISOString());
  logDebug('🟢 Client IP:', socket.handshake.address);
  logDebug('🟢 User Agent:', socket.handshake.headers['user-agent']);
  logDebug('🟢 Transport:', socket.conn.transport.name);

  // Join room
  socket.on('join_room', async (data) => {
    // Sadece guestUniqueId kullan
    const guestUniqueId = typeof data === 'object' && data.guestUniqueId ? data.guestUniqueId : null;
    
    logDebug('🔵 ========== SERVER: JOIN ROOM ==========');
    logDebug('🔵 Socket ID:', socket.id);
    logDebug('🔵 Guest Unique ID:', guestUniqueId);
    logDebug('🔵 Time:', new Date().toISOString());
    logDebug('🔵 Client IP:', socket.handshake.address);
    logDebug('🔵 User Agent:', socket.handshake.headers['user-agent']);
    
    // guestUniqueId zorunlu
    if (!guestUniqueId) {
      logDebug('⚠️ Cannot join room: missing guest_unique_id');
      socket.emit('error', { message: 'Guest unique ID bulunamadı' });
      return;
    }
    
    // Room ID sadece guestUniqueId'den oluşur
    const roomId = `guest_${guestUniqueId}`;
    socket.join(roomId);
    logInfo(`✅ Client joined room: ${roomId}`);
    
    // Log room membership
    const room = io.sockets.adapter.rooms.get(roomId);
    const roomSize = room ? room.size : 0;
    logDebug(`📊 Room ${roomId} now has ${roomSize} client(s)`);
    if (room) {
      logDebug(`📊 Socket IDs in room:`, Array.from(room));
    }
    
    try {
      if (process.env.NODE_ENV !== 'production') {
        logDebug('📊 Fetching chat history for guest_unique_id:', guestUniqueId);
      }
      // Send chat history (last 50 messages) filtered by guest_unique_id
      const result = await pool.query(`
        SELECT m.*, a.name as assistant_name, a.surname as assistant_surname, a.avatar as assistant_avatar
        FROM messages m
        LEFT JOIN assistants a ON m.assistant_id = a.id
        WHERE m.guest_unique_id = $1
        ORDER BY m.timestamp DESC 
          LIMIT 50
      `, [guestUniqueId]);
      
      if (process.env.NODE_ENV !== 'production') {
        logDebug('📊 Messages found:', result.rows.length);
      }
      
      // Map database column names (snake_case) to frontend format (camelCase)
      const messages = result.rows.reverse().map(row => {
        // Determine status based on delivered_at and read_at
        let status = 'sent';
        if (row.read_at) {
          status = 'read';
        } else if (row.delivered_at) {
          status = 'delivered';
        }
        
        // Get sender name: if assistant, use assistant name, otherwise use sender_name
        let senderName = row.sender_name;
        if (row.assistant_id && row.assistant_name) {
          senderName = `${row.assistant_name} ${row.assistant_surname || ''}`.trim();
        }
        
        return {
          id: row.id,
          guestUniqueId: row.guest_unique_id,
          senderType: row.sender_type,
          senderName: senderName,
          assistantId: row.assistant_id,
          assistantAvatar: row.assistant_avatar,
          message: row.message,
          timestamp: row.timestamp,
          status: status,
          deliveredAt: row.delivered_at,
          readAt: row.read_at
        };
      });
      
      if (process.env.NODE_ENV !== 'production') {
        logDebug('📤 Sending chat_history to client');
        logDebug('📤 Message count:', messages.length);
      }
      socket.emit('chat_history', messages);
      if (process.env.NODE_ENV !== 'production') {
        logDebug('✅ chat_history sent successfully');
      }
    } catch (error) {
      console.error('❌ Error loading chat history:', error);
      socket.emit('chat_history', []);
    }
  });

  // Load older messages
  socket.on('load_older_messages', async (data) => {
    const { guestUniqueId, beforeTimestamp, limit = 50 } = data;
    
    try {
      if (!guestUniqueId) {
        socket.emit('older_messages', []);
        return;
      }
      
      const result = await pool.query(`
        SELECT m.*, a.name as assistant_name, a.surname as assistant_surname, a.avatar as assistant_avatar
        FROM messages m
        LEFT JOIN assistants a ON m.assistant_id = a.id
        WHERE m.guest_unique_id = $1 
        AND m.timestamp < $2
        ORDER BY m.timestamp DESC 
        LIMIT $3
      `, [guestUniqueId, beforeTimestamp, limit]);
      
      // Map database column names (snake_case) to frontend format (camelCase)
      const messages = result.rows.reverse().map(row => {
        // Determine status based on delivered_at and read_at
        let status = 'sent';
        if (row.read_at) {
          status = 'read';
        } else if (row.delivered_at) {
          status = 'delivered';
        }
        
        // Get sender name: if assistant, use assistant name, otherwise use sender_name
        let senderName = row.sender_name;
        if (row.assistant_id && row.assistant_name) {
          senderName = `${row.assistant_name} ${row.assistant_surname || ''}`.trim();
        }
        
        return {
          id: row.id,
          guestUniqueId: row.guest_unique_id,
          senderType: row.sender_type,
          senderName: senderName,
          assistantId: row.assistant_id,
          assistantAvatar: row.assistant_avatar,
          message: row.message,
          timestamp: row.timestamp,
          status: status,
          deliveredAt: row.delivered_at,
          readAt: row.read_at
        };
      });
      
      socket.emit('older_messages', messages);
    } catch (error) {
      console.error('Error loading older messages:', error);
      socket.emit('older_messages', []);
    }
  });

  // New message
  socket.on('send_message', async (data) => {
    console.log('📨 ========== SERVER: MESSAGE RECEIVED ==========');
    console.log('📨 Socket ID:', socket.id);
    console.log('📨 Raw data:', JSON.stringify(data, null, 2));
    console.log('📨 Time:', new Date().toISOString());
    
    const { guestUniqueId, senderType, senderName, message, assistantId } = data;
    
    console.log('📨 Parsed data:', {
      guestUniqueId,
      senderType,
      senderName,
      assistantId,
      messageLength: message?.length
    });
    
    // Validate guest_unique_id
    if (!guestUniqueId) {
      console.error('❌ ========== CANNOT SAVE MESSAGE ==========');
      console.error('❌ Missing guest_unique_id');
      socket.emit('error', { message: 'Guest unique ID bulunamadı' });
      return;
    }
    
    // Verify room exists
      const roomResult = await pool.query(
      'SELECT room_number, checkin_date FROM rooms WHERE guest_unique_id = $1',
      [guestUniqueId]
    );
    
    if (roomResult.rows.length === 0) {
      console.error('❌ ========== CANNOT SAVE MESSAGE ==========');
      console.error('❌ Room not found for guest_unique_id:', guestUniqueId);
      socket.emit('error', { message: 'Oda bulunamadı' });
      return;
    }
    
    const actualRoomNumber = roomResult.rows[0].room_number;
    const actualCheckinDate = roomResult.rows[0].checkin_date;
    
    // Get assistant_id from cookie if sender is assistant
    let actualAssistantId = assistantId || null;
    if (senderType === 'assistant' && !actualAssistantId) {
      // Try to get from socket handshake cookies
      const cookies = socket.handshake.headers.cookie;
      if (cookies) {
        const assistantIdMatch = cookies.match(/assistant_id=(\d+)/);
        if (assistantIdMatch) {
          actualAssistantId = parseInt(assistantIdMatch[1]);
        }
      }
    }
    
    // Get assistant name if assistant_id is provided
    let actualSenderName = senderName;
    if (actualAssistantId && senderType === 'assistant') {
      const assistantResult = await pool.query(
        'SELECT name, surname FROM assistants WHERE id = $1',
        [actualAssistantId]
      );
      if (assistantResult.rows.length > 0) {
        actualSenderName = `${assistantResult.rows[0].name} ${assistantResult.rows[0].surname || ''}`.trim();
      }
    }
    
    try {
      console.log('💾 Saving message to database...');
      // Save to database with guest_unique_id and assistant_id
      const result = await pool.query(`
        INSERT INTO messages (guest_unique_id, sender_type, assistant_id, message)
        VALUES ($1, $2, $3, $4)
        RETURNING id, timestamp
      `, [
        guestUniqueId,
        senderType,
        actualAssistantId,
        message
      ]);
      
      const messageId = result.rows[0].id;
      const timestamp = result.rows[0].timestamp;
      logDebug('Message saved to database:', { messageId, timestamp });
      
      // Use guest_unique_id for room ID
      const roomId = `guest_${guestUniqueId}`;
      
      // Broadcast message with status
      const messageData = {
        id: messageId,
        guestUniqueId: guestUniqueId,
        senderType,
        senderName: actualSenderName,
        assistantId: actualAssistantId,
        message,
        timestamp: timestamp.toISOString(),
        status: 'sent',
        deliveredAt: null,
        readAt: null
      };
      
      // Send confirmation to sender first
      socket.emit('message_sent', { messageId, status: 'sent' });
      
      // Broadcast to room
      io.to(roomId).emit('new_message', messageData);
      logDebug('Message broadcasted to room:', roomId);
    } catch (error) {
      console.error('Error saving message:', error);
      socket.emit('error', { message: 'Mesaj kaydedilemedi' });
    }
  });

  // Typing indicator
  socket.on('typing', async (data) => {
    const { guestUniqueId } = data;
    
    // guestUniqueId zorunlu
    if (!guestUniqueId) {
      logDebug('⚠️ Cannot handle typing: missing guest_unique_id');
      return;
    }
    
    // Room ID sadece guestUniqueId'den oluşur
    const roomId = `guest_${guestUniqueId}`;
    
    socket.to(roomId).emit('user_typing', {
      senderName: data.senderName,
      senderType: data.senderType
    });
  });

  socket.on('stop_typing', async (data) => {
    const { guestUniqueId } = data;
    
    // guestUniqueId zorunlu
    if (!guestUniqueId) {
      logDebug('⚠️ Cannot handle stop_typing: missing guest_unique_id');
      return;
    }
    
    // Room ID sadece guestUniqueId'den oluşur
    const roomId = `guest_${guestUniqueId}`;
    
    socket.to(roomId).emit('user_stopped_typing');
  });

  // Message delivered status
  socket.on('message_delivered', async (data) => {
    try {
      const { messageId } = data;
      console.log('📬 message_delivered event received:', { messageId, socketId: socket.id });
      if (!messageId) {
        console.log('⚠️ message_delivered: No messageId provided');
        return;
      }
      
      // Update message delivered_at timestamp
      const updateResult = await pool.query(
        'UPDATE messages SET delivered_at = CURRENT_TIMESTAMP WHERE id = $1 AND delivered_at IS NULL RETURNING id',
        [messageId]
      );
      
      if (updateResult.rows.length === 0) {
        logDebug('⚠️ message_delivered: Message not found or already delivered:', messageId);
        return;
      }
      
      logDebug('✅ Message marked as delivered:', messageId);
      
      // Get message info to broadcast status update
      const messageResult = await pool.query(
        'SELECT guest_unique_id FROM messages WHERE id = $1',
        [messageId]
      );
      
      if (messageResult.rows.length > 0) {
        const { guest_unique_id } = messageResult.rows[0];
        
        if (guest_unique_id) {
          // Use guest_unique_id format
          const roomId = `guest_${guest_unique_id}`;
          logDebug('📤 Using guest_unique_id for roomId:', roomId);
          
          logDebug('📤 Broadcasting message_status_update to room:', roomId, { 
          messageId, 
          status: 'delivered',
            guest_unique_id
        });
        
        // Get all sockets in this room for debugging
        const roomSockets = await io.in(roomId).fetchSockets();
          logDebug(`📊 Room ${roomId} has ${roomSockets.length} connected clients`);
        
        // Broadcast status update to room (sender will see delivered tick)
        io.to(roomId).emit('message_status_update', { 
          messageId, 
          status: 'delivered' 
        });
        
          logDebug('✅ message_status_update broadcasted to room:', roomId);
      } else {
          logDebug('⚠️ message_delivered: guest_unique_id not found for messageId:', messageId);
        }
      } else {
        logDebug('⚠️ message_delivered: Message info not found for messageId:', messageId);
      }
    } catch (error) {
      console.error('❌ Error updating delivered status:', error);
    }
  });

  // Message read status
  socket.on('message_read', async (data) => {
    try {
      const { messageIds } = data;
      if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) return;
      
      // Update messages read_at timestamp
      await pool.query(
        'UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE id = ANY($1) AND read_at IS NULL',
        [messageIds]
      );
      
      // Get first message info to broadcast status update
      const messageResult = await pool.query(
        'SELECT guest_unique_id FROM messages WHERE id = $1',
        [messageIds[0]]
      );
      
      if (messageResult.rows.length > 0) {
        const { guest_unique_id } = messageResult.rows[0];
        
        if (guest_unique_id) {
          // Use guest_unique_id format
          const roomId = `guest_${guest_unique_id}`;
          logDebug('📤 Using guest_unique_id for roomId:', roomId);
          
          logDebug('📤 Broadcasting message_status_update (read) to room:', roomId, { 
          messageIds, 
          status: 'read',
            guest_unique_id
        });
        
        // Broadcast status update to room (sender will see read ticks)
        io.to(roomId).emit('message_status_update', { 
          messageIds, 
          status: 'read' 
        });
        
          logDebug('✅ message_status_update (read) broadcasted to room:', roomId);
        } else {
          logDebug('⚠️ message_read: guest_unique_id not found for messageIds:', messageIds);
        }
      } else {
        logDebug('⚠️ message_read: Message info not found for messageIds:', messageIds);
      }
    } catch (error) {
      console.error('Error updating read status:', error);
    }
  });

  socket.on('disconnect', (reason) => {
    logDebug('🔴 ========== CLIENT DISCONNECTED ==========');
    logDebug('🔴 Socket ID:', socket.id);
    logDebug('🔴 Reason:', reason);
    logDebug('🔴 Time:', new Date().toISOString());
  });
});

// REST API Endpoints

// Get all active rooms (with optional date range filter)
app.get('/api/rooms', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    logDebug('🏨 GET /api/rooms - start_date:', start_date, 'end_date:', end_date);
    
    let query = 'SELECT * FROM rooms WHERE is_active = true';
    const params = [];
    
    if (start_date && end_date) {
      query += ' AND checkin_date >= $1 AND checkin_date <= $2 ORDER BY checkin_date ASC, room_number ASC';
      params.push(start_date, end_date);
      logDebug('Filtering rooms by date range:', start_date, 'to', end_date);
    } else if (start_date) {
      query += ' AND checkin_date >= $1 ORDER BY checkin_date ASC, room_number ASC';
      params.push(start_date);
      logDebug('Filtering rooms from date:', start_date);
    } else {
      query += ' ORDER BY checkin_date DESC, room_number ASC';
      logDebug('🔍 No date filter, returning all active rooms');
    }
    
    logDebug('📊 Executing query:', query);
    logDebug('📊 Query params:', params);
    
    const result = await pool.query(query, params);
    logDebug('✅ Found', result.rows.length, 'rooms');
    if (result.rows.length > 0) {
      logDebug('📋 Sample rooms:', result.rows.slice(0, 3).map(r => ({
        room_number: r.room_number,
        checkin_date: r.checkin_date,
        guest_name: r.guest_name
      })));
    }
    
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Error fetching rooms:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ error: 'Database error', message: error.message });
  }
});

// Get room details
app.get('/api/rooms/:roomNumber', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms WHERE room_number = $1', [req.params.roomNumber]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching room:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get messages for a room
app.get('/api/messages/:roomNumber', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM messages 
      WHERE room_number = $1 
      ORDER BY timestamp DESC 
      LIMIT 100
    `, [req.params.roomNumber]);
    
    // Map database column names (snake_case) to frontend format (camelCase)
    const messages = result.rows.reverse().map(row => ({
      id: row.id,
      roomNumber: row.room_number,
      senderType: row.sender_type,
      senderName: row.sender_name,
      message: row.message,
      timestamp: row.timestamp
    }));
    
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create/Update room
app.post('/api/rooms', async (req, res) => {
  try {
    const { roomNumber, guestName, guestSurname, checkinDate, checkoutDate } = req.body;
    
    // Generate guest_unique_id if guest info is provided
    const guest_unique_id = generateGuestUniqueId(guestName, guestSurname, checkinDate, checkoutDate);
    
    await pool.query(`
      INSERT INTO rooms (room_number, guest_name, guest_surname, checkin_date, checkout_date, guest_unique_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(room_number, checkin_date) 
      DO UPDATE SET 
        guest_name = EXCLUDED.guest_name, 
        guest_surname = EXCLUDED.guest_surname,
        checkin_date = EXCLUDED.checkin_date, 
        checkout_date = EXCLUDED.checkout_date, 
        guest_unique_id = COALESCE(EXCLUDED.guest_unique_id, rooms.guest_unique_id),
        is_active = true
    `, [roomNumber, guestName, guestSurname, checkinDate, checkoutDate, guest_unique_id]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error creating/updating room:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get profile photo for a room
app.get('/api/rooms/:roomNumber/profile-photo', async (req, res) => {
  try {
    const { roomNumber } = req.params;
    logDebug('📸 Fetching profile photo for room:', roomNumber);
    
    const result = await pool.query(
      'SELECT profile_photo FROM rooms WHERE room_number = $1',
      [roomNumber]
    );
    
    if (result.rows.length === 0) {
      logDebug('⚠️ Room not found:', roomNumber);
      // Return null instead of 404 - room might not exist yet
      return res.json({ profilePhoto: null });
    }
    
    const profilePhoto = result.rows[0].profile_photo || null;
    logDebug('✅ Profile photo fetched:', profilePhoto ? 'exists' : 'null');
    res.json({ profilePhoto });
  } catch (error) {
    console.error('❌ Error fetching profile photo:', error);
    console.error('❌ Error stack:', error.stack);
    // Return null instead of 500 - don't break the app
    res.json({ profilePhoto: null });
  }
});

// Get profile photo for a guest (by guest_unique_id)
app.get('/api/guests/:guestUniqueId/profile-photo', async (req, res) => {
  try {
    const { guestUniqueId } = req.params;
    logDebug('📸 Fetching profile photo for guest:', guestUniqueId);
    
    const result = await pool.query(
      'SELECT profile_photo FROM rooms WHERE guest_unique_id = $1',
      [guestUniqueId]
    );
    
    if (result.rows.length === 0) {
      logDebug('⚠️ Guest not found:', guestUniqueId);
      // Return null instead of 404 - guest might not exist yet
      return res.json({ profilePhoto: null });
    }
    
    const profilePhoto = result.rows[0].profile_photo || null;
    logDebug('✅ Profile photo fetched:', profilePhoto ? 'exists' : 'null');
    res.json({ profilePhoto });
  } catch (error) {
    console.error('❌ Error fetching profile photo:', error);
    console.error('❌ Error stack:', error.stack);
    // Return null instead of 500 - don't break the app
    res.json({ profilePhoto: null });
  }
});

// Save profile photo for a guest (by guest_unique_id)
app.post('/api/guests/:guestUniqueId/profile-photo', async (req, res) => {
  try {
    const { profilePhoto } = req.body;
    const { guestUniqueId } = req.params;
    
    logDebug('📸 Saving profile photo for guest:', guestUniqueId);
    logDebug('📸 Photo data length:', profilePhoto ? profilePhoto.length : 0);
    
    if (!profilePhoto) {
      return res.status(400).json({ error: 'Profile photo data is required' });
    }
    
    // Check if photo data is too large (PostgreSQL TEXT can handle up to 1GB, but we'll limit to 5MB for base64)
    if (profilePhoto.length > 5 * 1024 * 1024) {
      console.error('❌ Profile photo too large:', profilePhoto.length);
      return res.status(400).json({ error: 'Profile photo is too large (max 5MB)' });
    }
    
    // Update room with profile photo using guest_unique_id
    const result = await pool.query(
      'UPDATE rooms SET profile_photo = $1 WHERE guest_unique_id = $2 RETURNING id, room_number',
      [profilePhoto, guestUniqueId]
    );
    
    if (result.rows.length === 0) {
      logDebug('⚠️ Guest not found:', guestUniqueId);
      return res.status(404).json({ error: 'Guest not found' });
    }
    
    logDebug('✅ Profile photo saved for guest:', guestUniqueId);
    
    // Emit Socket.IO event to notify assistants about profile photo update
    const roomNumber = result.rows[0].room_number;
    io.emit('profile_photo_updated', {
      guest_unique_id: guestUniqueId,
      room_number: roomNumber,
      profile_photo: profilePhoto
    });
    console.log('📢 Emitted profile_photo_updated event for guest:', guestUniqueId);
    
    res.json({ success: true, roomNumber: result.rows[0].room_number });
  } catch (error) {
    console.error('❌ Error saving profile photo:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ error: 'Database error' });
  }
});

// Save profile photo for a room
app.post('/api/rooms/:roomNumber/profile-photo', async (req, res) => {
  try {
    const { profilePhoto } = req.body;
    const { roomNumber } = req.params;
    
    logDebug('📸 Saving profile photo for room:', roomNumber);
    logDebug('📸 Photo data length:', profilePhoto ? profilePhoto.length : 0);
    
    if (!profilePhoto) {
      return res.status(400).json({ error: 'Profile photo data is required' });
    }
    
    // Check if photo data is too large (PostgreSQL TEXT can handle up to 1GB, but we'll limit to 5MB for base64)
    if (profilePhoto.length > 5 * 1024 * 1024) {
      console.error('❌ Profile photo too large:', profilePhoto.length);
      return res.status(400).json({ error: 'Profile photo is too large (max 5MB)' });
    }
    
    // Update or insert room with profile photo
    // First check if room exists
    const roomCheck = await pool.query(
      'SELECT id FROM rooms WHERE room_number = $1',
      [roomNumber]
    );
    
    if (roomCheck.rows.length === 0) {
      // Room doesn't exist, create it with minimal data
    await pool.query(`
        INSERT INTO rooms (room_number, profile_photo, is_active)
        VALUES ($1, $2, true)
    `, [roomNumber, profilePhoto]);
    } else {
      // Room exists, update profile photo
      await pool.query(`
        UPDATE rooms 
        SET profile_photo = $1
        WHERE room_number = $2
      `, [profilePhoto, roomNumber]);
    }
    
    logDebug('Profile photo saved successfully');
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error saving profile photo:', error);
    console.error('❌ Error details:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      stack: error.stack
    });
    res.status(500).json({ 
      error: 'Database error',
      message: error.message 
    });
  }
});

// Dashboard stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalMessages = await pool.query('SELECT COUNT(*) as count FROM messages');
    const activeRooms = await pool.query('SELECT COUNT(*) as count FROM rooms WHERE is_active = true');
    
    res.json({
      totalMessages: parseInt(totalMessages.rows[0].count),
      activeRooms: parseInt(activeRooms.rows[0].count)
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Assistant API Endpoints

// Assistant Login Endpoints
app.post('/api/assistant/login', async (req, res) => {
  try {
    const { user, password } = req.body;
    
    if (!user || !password) {
      return res.status(400).json({ error: 'User ID and password are required' });
    }
    
    // user is the assistant ID, password is the assistant's name
    const assistantId = parseInt(user);
    if (isNaN(assistantId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    
    // Get assistant from database
    const result = await pool.query('SELECT * FROM assistants WHERE id = $1 AND is_active = true', [assistantId]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const assistant = result.rows[0];
    
    // Check if password matches assistant's name (case-insensitive)
    if (assistant.name.toLowerCase().trim() !== password.toLowerCase().trim()) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Set cookie with assistant ID (7 days expiry)
    res.cookie('assistant_id', assistantId.toString(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    
    // Return assistant info (without sensitive data)
    res.json({
      success: true,
      assistant: {
        id: assistant.id,
        name: assistant.name,
        surname: assistant.surname,
        avatar: assistant.avatar,
        is_active: assistant.is_active
      }
    });
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Check if assistant is logged in
app.get('/api/assistant/me', async (req, res) => {
  try {
    const assistantId = req.cookies?.assistant_id;
    
    if (!assistantId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const result = await pool.query('SELECT id, name, surname, avatar, is_active FROM assistants WHERE id = $1 AND is_active = true', [assistantId]);
    
    if (result.rows.length === 0) {
      // Clear invalid cookie
      res.clearCookie('assistant_id');
      return res.status(401).json({ error: 'Assistant not found or inactive' });
    }
    
    res.json({
      success: true,
      assistant: result.rows[0]
    });
  } catch (error) {
    console.error('Error checking authentication:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Logout
app.post('/api/assistant/logout', async (req, res) => {
  res.clearCookie('assistant_id');
  res.json({ success: true });
});

// Guest Logout Endpoint
app.post('/api/guest/logout', async (req, res) => {
  res.clearCookie('guest_unique_id');
  res.json({ success: true });
});

// ============================================
// Avatar & Ghost Mode API Endpoints
// ============================================

// Update guest avatar
app.post('/api/guest/avatar', async (req, res) => {
  try {
    const guest_unique_id = req.cookies?.guest_unique_id;
    const { avatar_seed, avatar_style } = req.body;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!avatar_seed || !avatar_style) {
      return res.status(400).json({ error: 'avatar_seed and avatar_style are required' });
    }
    
    await pool.query(`
      UPDATE rooms 
      SET avatar_seed = $1, avatar_style = $2
      WHERE guest_unique_id = $3
    `, [avatar_seed, avatar_style, guest_unique_id]);
    
    res.json({ success: true, avatar_seed, avatar_style });
  } catch (error) {
    console.error('Error updating avatar:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Toggle ghost mode
app.post('/api/guest/ghost-mode', async (req, res) => {
  try {
    const guest_unique_id = req.cookies?.guest_unique_id;
    const { enabled } = req.body;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    await pool.query(`
      UPDATE rooms 
      SET ghost_mode = $1
      WHERE guest_unique_id = $2
    `, [enabled === true, guest_unique_id]);
    
    res.json({ success: true, ghost_mode: enabled });
  } catch (error) {
    console.error('Error updating ghost mode:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// ============================================
// Location Tracking API Endpoints
// ============================================

// Update user location
app.post('/api/location/update', async (req, res) => {
  try {
    const guest_unique_id = req.cookies?.guest_unique_id;
    const { latitude, longitude, accuracy } = req.body;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }
    
    // Check if ghost mode is enabled (with retry)
    const roomResult = await retryQuery(() => 
      pool.query(`
        SELECT ghost_mode FROM rooms WHERE guest_unique_id = $1
      `, [guest_unique_id])
    );
    
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Guest not found' });
    }
    
    // Only save location if ghost mode is disabled
    if (!roomResult.rows[0].ghost_mode) {
      await retryQuery(() =>
        pool.query(`
          INSERT INTO user_locations (guest_unique_id, latitude, longitude, accuracy)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING
        `, [guest_unique_id, latitude, longitude, accuracy || null])
      );
      
      // Keep only last location per user (delete old ones)
      await retryQuery(() =>
        pool.query(`
          DELETE FROM user_locations 
          WHERE guest_unique_id = $1 
          AND id NOT IN (
            SELECT id FROM user_locations 
            WHERE guest_unique_id = $1 
            ORDER BY timestamp DESC 
            LIMIT 1
          )
        `, [guest_unique_id])
      );
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating location:', error);
    // Don't expose database errors to client
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Get all active users' locations (for map)
app.get('/api/location/users', async (req, res) => {
  try {
    const guest_unique_id = req.cookies?.guest_unique_id;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Get locations from last 2 minutes (active users)
    const result = await pool.query(`
      SELECT DISTINCT ON (r.guest_unique_id)
        r.guest_unique_id,
        r.guest_name,
        r.avatar_seed,
        r.avatar_style,
        ul.latitude,
        ul.longitude,
        ul.accuracy,
        ul.timestamp
      FROM rooms r
      LEFT JOIN user_locations ul ON r.guest_unique_id = ul.guest_unique_id
      WHERE r.is_active = true
        AND r.ghost_mode = false
        AND ul.timestamp > NOW() - INTERVAL '2 minutes'
        AND r.guest_unique_id != $1
      ORDER BY r.guest_unique_id, ul.timestamp DESC
    `, [guest_unique_id]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching user locations:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get current guest info (for session check)
// ============================================
// Guest Authentication Routes
// ============================================

// Login endpoint - authenticate guest
app.post('/api/auth/login', async (req, res) => {
  try {
    const { roomNumber, firstName, lastName } = req.body;
    
    if (!roomNumber || !firstName || !lastName) {
      return res.status(400).json({ success: false, error: 'Room number, first name, and last name are required' });
    }
    
    // Find guest by room number and name
    const result = await pool.query(`
      SELECT *
      FROM rooms
      WHERE room_number = $1
        AND LOWER(guest_name) = LOWER($2)
        AND LOWER(guest_surname) = LOWER($3)
        AND is_active = true
        AND checkin_date <= CURRENT_DATE
        AND (checkout_date IS NULL OR checkout_date >= CURRENT_DATE)
      ORDER BY checkin_date DESC
      LIMIT 1
    `, [roomNumber, firstName, lastName]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        error: 'Guest not found. Please check your room number and name.' 
      });
    }
    
    const guest = result.rows[0];
    
    // Set cookie with guest_unique_id
    res.cookie('guest_unique_id', guest.guest_unique_id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });
    
    // Set authentication flag
    res.cookie('is_authenticated', 'true', {
      httpOnly: false, // Allow JS to read this
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    
    logInfo(`✅ Guest logged in: ${guest.guest_name} ${guest.guest_surname} (Room ${guest.room_number})`);
    
    res.json({
      success: true,
      guest: {
        id: guest.id,
        room_number: guest.room_number,
        guest_name: guest.guest_name,
        guest_surname: guest.guest_surname,
        checkin_date: guest.checkin_date,
        checkout_date: guest.checkout_date,
        guest_unique_id: guest.guest_unique_id,
        avatar_seed: guest.avatar_seed,
        avatar_style: guest.avatar_style,
        ghost_mode: guest.ghost_mode
      }
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('guest_unique_id');
  res.clearCookie('is_authenticated');
  logInfo('✅ Guest logged out');
  res.json({ success: true });
});

// Check authentication status
app.get('/api/auth/status', (req, res) => {
  const guestUniqueId = req.cookies?.guest_unique_id;
  const isAuthenticated = req.cookies?.is_authenticated === 'true';
  
  res.json({
    success: true,
    isAuthenticated,
    hasSession: !!guestUniqueId
  });
});

app.get('/api/guest/me', async (req, res) => {
  try {
    const guestUniqueId = req.cookies?.guest_unique_id;
    
    if (!guestUniqueId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    // Find guest by unique_id (with retry)
    const result = await retryQuery(() =>
      pool.query(`
        SELECT 
          r.*,
          tra.team_id,
          t.name as team_name
        FROM rooms r
        LEFT JOIN team_room_assignments tra ON r.guest_unique_id = tra.guest_unique_id AND tra.is_active = true
        LEFT JOIN teams t ON tra.team_id = t.id AND t.is_active = true
        WHERE r.guest_unique_id = $1
          AND r.is_active = true
        LIMIT 1
      `, [guestUniqueId])
    );
    
    if (result.rows.length === 0) {
      res.clearCookie('guest_unique_id');
      return res.status(404).json({ success: false, error: 'Guest not found' });
    }
    
    const guest = result.rows[0];
    
    res.json({
      success: true,
      guest: {
        guest_unique_id: guest.guest_unique_id,
        guest_name: guest.guest_name,
        guest_surname: guest.guest_surname,
        checkin_date: guest.checkin_date,
        checkout_date: guest.checkout_date,
        room_number: guest.room_number,
        team_id: guest.team_id || null,
        team_name: guest.team_name || null,
        avatar_seed: guest.avatar_seed || null,
        avatar_style: guest.avatar_style || 'avataaars',
        ghost_mode: guest.ghost_mode || false
      }
    });
  } catch (error) {
    console.error('Error getting guest info:', error);
    // Don't expose database errors to client
    res.status(500).json({ success: false, error: 'Failed to retrieve guest information' });
  }
});

// Guest Login Endpoint
app.post('/api/guest/login', async (req, res) => {
  try {
    const { name, surname, checkin_date, checkout_date } = req.body;
    
    if (!name || !surname || !checkin_date || !checkout_date) {
      return res.status(400).json({ error: 'Ad, soyad, giriş tarihi ve çıkış tarihi gereklidir' });
    }
    
    // Find guest by name, surname, checkin_date and checkout_date
    const result = await pool.query(`
      SELECT 
        r.*,
        tra.team_id,
        t.name as team_name
      FROM rooms r
      LEFT JOIN team_room_assignments tra ON r.guest_unique_id = tra.guest_unique_id AND tra.is_active = true
      LEFT JOIN teams t ON tra.team_id = t.id AND t.is_active = true
      WHERE LOWER(TRIM(r.guest_name)) = LOWER(TRIM($1))
        AND LOWER(TRIM(r.guest_surname)) = LOWER(TRIM($2))
        AND r.checkin_date = $3::date
        AND r.checkout_date = $4::date
        AND r.is_active = true
      ORDER BY r.checkin_date DESC
      LIMIT 1
    `, [name, surname, checkin_date, checkout_date]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Misafir bulunamadı. Lütfen bilgilerinizi kontrol edin.' });
    }
    
    const guest = result.rows[0];
    
    // If guest_unique_id is null, generate it
    let guest_unique_id = guest.guest_unique_id;
    if (!guest_unique_id && guest.checkin_date) {
      // Use guest_name if available, otherwise use surname or 'Guest'
      const guestName = guest.guest_name || guest.guest_surname || 'Guest';
      const guestSurname = guest.guest_surname || '';
      
      console.log('🔧 Generating guest_unique_id with:', { guestName, guestSurname, checkin_date: guest.checkin_date, checkout_date: guest.checkout_date });
      
      guest_unique_id = generateGuestUniqueId(guestName, guestSurname, guest.checkin_date, guest.checkout_date);
      
      if (guest_unique_id) {
        // Update the room with the generated guest_unique_id
        await pool.query(
          'UPDATE rooms SET guest_unique_id = $1 WHERE id = $2',
          [guest_unique_id, guest.id]
        );
        
        logDebug(`Generated guest_unique_id: ${guest_unique_id}`);
      } else {
        console.error('❌ generateGuestUniqueId returned null for:', { guestName, guestSurname, checkin_date: guest.checkin_date });
      }
    }
    
    // If still null, return error
    if (!guest_unique_id) {
      console.error('❌ Cannot generate guest_unique_id: missing required data', {
        guest_name: guest.guest_name,
        guest_surname: guest.guest_surname,
        checkin_date: guest.checkin_date,
        guest_unique_id: guest.guest_unique_id
      });
      return res.status(500).json({ error: 'Misafir bilgileri eksik. Lütfen yönetici ile iletişime geçin.' });
    }
    
    // Set cookie for session management
    res.cookie('guest_unique_id', guest_unique_id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    
    // Return guest info
    res.json({
      success: true,
      guest_unique_id: guest_unique_id,
      guest_name: guest.guest_name,
      guest_surname: guest.guest_surname,
      checkin_date: guest.checkin_date,
      checkout_date: guest.checkout_date,
      room_number: guest.room_number,
      team_id: guest.team_id || null,
      team_name: guest.team_name || null
    });
  } catch (error) {
    console.error('Error during guest login:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get all assistants
app.get('/api/assistants', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        a.*,
        COALESCE(
          (
            SELECT string_agg(t.name, ', ' ORDER BY t.name)
            FROM teams t
            INNER JOIN assistant_teams at ON t.id = at.team_id
            WHERE at.assistant_id = a.id 
              AND at.is_active = true 
              AND t.is_active = true
          ),
          ''
        ) as teams
      FROM assistants a
      ORDER BY a.name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching assistants:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get single assistant
app.get('/api/assistants/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM assistants WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assistant not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching assistant:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create assistant
app.post('/api/assistants', async (req, res) => {
  try {
    const { name, surname, spoken_languages, avatar } = req.body;
    const result = await pool.query(
      'INSERT INTO assistants (name, surname, spoken_languages, avatar) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, surname || '', spoken_languages || null, avatar || null]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating assistant:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Update assistant
app.put('/api/assistants/:id', async (req, res) => {
  try {
    const { name, surname, spoken_languages, avatar } = req.body;
    
    // Validate required fields
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    // Handle avatar - limit size to prevent database issues
    let avatarValue = null;
    if (avatar) {
      // Check if avatar is base64 string and limit size (max 500KB base64 = ~375KB image)
      if (typeof avatar === 'string' && avatar.length > 0) {
        // Base64 string can be up to ~670KB for TEXT field, but we'll limit to 500KB for safety
        if (avatar.length > 500000) {
          console.warn('Avatar too large, truncating or rejecting');
          return res.status(400).json({ error: 'Avatar image is too large. Please use an image smaller than 375KB' });
        }
        avatarValue = avatar;
      } else {
        avatarValue = null;
      }
    }
    
    console.log('Updating assistant:', {
      id: req.params.id,
      name,
      surname,
      spoken_languages,
      avatarLength: avatarValue ? avatarValue.length : 0
    });
    
    const result = await pool.query(
      'UPDATE assistants SET name = $1, surname = $2, spoken_languages = $3, avatar = $4 WHERE id = $5 RETURNING *',
      [name, surname || '', spoken_languages || null, avatarValue, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assistant not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating assistant:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      hint: error.hint
    });
    res.status(500).json({ error: 'Database error', message: error.message });
  }
});

// Delete assistant
app.delete('/api/assistants/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM assistants WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assistant not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting assistant:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Teams API Endpoints

// Get all teams
app.get('/api/teams', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    
    const result = await pool.query(`
      SELECT 
        t.*,
        COALESCE((
          SELECT COUNT(DISTINCT tra.guest_unique_id)
          FROM team_room_assignments tra
          INNER JOIN rooms r ON tra.guest_unique_id = r.guest_unique_id
          WHERE tra.team_id = t.id
            AND tra.is_active = true
            AND r.is_active = true
            AND (
              r.checkout_date IS NULL 
              OR (r.checkout_date + INTERVAL '1 day') >= $1::date
            )
        ), 0) as active_room_count
      FROM teams t
      ORDER BY t.name
    `, [todayStr]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get single team
app.get('/api/teams/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM teams WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching team:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get team assistants
app.get('/api/teams/:id/assistants', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.* FROM assistants a
      INNER JOIN assistant_teams at ON a.id = at.assistant_id
      WHERE at.team_id = $1 AND at.is_active = true
      ORDER BY a.name
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching team assistants:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create team
app.post('/api/teams', async (req, res) => {
  try {
    const { name, description, assistant_ids, avatar } = req.body;
    
    // Create team
    const teamResult = await pool.query(
      'INSERT INTO teams (name, description, avatar) VALUES ($1, $2, $3) RETURNING *',
      [name, description || null, avatar || null]
    );
    const team = teamResult.rows[0];
    
    // Assign assistants to team
    if (assistant_ids && assistant_ids.length > 0) {
      for (const assistantId of assistant_ids) {
        await pool.query(
          'INSERT INTO assistant_teams (assistant_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [assistantId, team.id]
        );
      }
    }
    
    res.json(team);
  } catch (error) {
    console.error('Error creating team:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Update team
app.put('/api/teams/:id', async (req, res) => {
  try {
    const { name, description, assistant_ids, avatar } = req.body;
    
    // Update team
    const teamResult = await pool.query(
      'UPDATE teams SET name = $1, description = $2, avatar = COALESCE($3, avatar) WHERE id = $4 RETURNING *',
      [name, description || null, avatar || null, req.params.id]
    );
    
    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    // Update assistant assignments
    if (assistant_ids !== undefined) {
      // Remove all current assignments
      await pool.query('UPDATE assistant_teams SET is_active = false WHERE team_id = $1', [req.params.id]);
      
      // Add new assignments
      if (assistant_ids.length > 0) {
        for (const assistantId of assistant_ids) {
          await pool.query(
            `INSERT INTO assistant_teams (assistant_id, team_id, is_active) 
             VALUES ($1, $2, true) 
             ON CONFLICT (assistant_id, team_id) 
             DO UPDATE SET is_active = true`,
            [assistantId, req.params.id]
          );
        }
      }
    }
    
    res.json(teamResult.rows[0]);
  } catch (error) {
    console.error('Error updating team:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete team
app.delete('/api/teams/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM teams WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting team:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Team Assignments API Endpoints

// Get team assignments (with optional checkin_date filter)
app.get('/api/team-assignments', async (req, res) => {
  try {
    const { checkin_date } = req.query;
    logDebug('GET /api/team-assignments - checkin_date:', checkin_date);
    
    let query = `
      SELECT 
        tra.id,
        tra.guest_unique_id,
        t.name as team_name,
        r.room_number,
        r.checkin_date,
        r.guest_name,
        r.guest_surname,
        r.profile_photo
      FROM team_room_assignments tra
      INNER JOIN teams t ON tra.team_id = t.id
      LEFT JOIN rooms r ON tra.guest_unique_id = r.guest_unique_id
      WHERE tra.is_active = true
    `;
    const params = [];
    
    if (checkin_date) {
      logDebug('Filtering by checkin_date:', checkin_date);
      query += ' AND r.checkin_date = $1';
      params.push(checkin_date);
    }
    
    query += ' ORDER BY r.checkin_date DESC, r.room_number';
    
    logDebug('📊 Executing query:', query);
    logDebug('📊 Query params:', params);
    
    const result = await pool.query(query, params);
    logDebug('✅ Found', result.rows.length, 'assignments');
    logDebug('📋 Assignments:', result.rows);
    
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Error fetching team assignments:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ error: 'Database error', message: error.message });
  }
});

// Create team assignments
app.post('/api/team-assignments', async (req, res) => {
  try {
    const { team_id, assignments } = req.body;
    
    if (!team_id || !assignments || assignments.length === 0) {
      return res.status(400).json({ error: 'team_id and assignments are required' });
    }
    
    // Get team assistants
    const assistantsResult = await pool.query(`
      SELECT assistant_id FROM assistant_teams 
      WHERE team_id = $1 AND is_active = true
    `, [team_id]);
    
    const assistantIds = assistantsResult.rows.map(r => r.assistant_id);
    
    if (assistantIds.length === 0) {
      return res.status(400).json({ error: 'Team has no assistants' });
    }
    
    const createdAssignments = [];
    
    for (const assignment of assignments) {
      const { room_number, checkin_date, guest_name, guest_surname, guest_unique_id: provided_guest_unique_id, checkout_date } = assignment;
      
      // Use provided guest_unique_id if available, otherwise generate it
      let guest_unique_id = provided_guest_unique_id || null;
      if (!guest_unique_id && guest_name && checkin_date) {
        // If checkout_date is not provided, try to get it from the room
        let checkoutDate = checkout_date;
        if (!checkoutDate && room_number && checkin_date) {
          try {
            const roomResult = await pool.query(
              'SELECT checkout_date FROM rooms WHERE room_number = $1 AND checkin_date = $2 LIMIT 1',
              [room_number, checkin_date]
            );
            if (roomResult.rows.length > 0) {
              checkoutDate = roomResult.rows[0].checkout_date;
            }
          } catch (error) {
            console.error('Error fetching checkout_date from room:', error);
          }
        }
        guest_unique_id = generateGuestUniqueId(guest_name, guest_surname, checkin_date, checkoutDate);
      }
      
      // guest_unique_id is required
      if (!guest_unique_id) {
        return res.status(400).json({ error: 'guest_unique_id is required. Provide guest_name, guest_surname, checkin_date, and checkout_date to generate it.' });
      }
      
      // Create team-room assignment using guest_unique_id
      let assignmentResult;
      try {
        assignmentResult = await pool.query(
          `INSERT INTO team_room_assignments (team_id, guest_unique_id)
           VALUES ($1, $2)
           ON CONFLICT (team_id, guest_unique_id) 
         DO UPDATE SET is_active = true
         RETURNING *`,
          [team_id, guest_unique_id]
      );
      } catch (error) {
        console.error('Error creating team assignment:', error);
        throw error;
      }
      
      createdAssignments.push(assignmentResult.rows[0]);
      
      // Update room table with guest_unique_id if it was generated
      if (guest_unique_id) {
        try {
          await pool.query(
            `UPDATE rooms 
             SET guest_unique_id = COALESCE(guest_unique_id, $1)
             WHERE guest_unique_id = $1 OR (room_number = $2 AND checkin_date = $3 AND (guest_unique_id IS NULL OR guest_unique_id = ''))`,
            [guest_unique_id, room_number || null, checkin_date || null]
          );
          logDebug('Updated room with guest_unique_id:', guest_unique_id);
        } catch (error) {
          console.error('Error updating room table with guest_unique_id:', error);
          // Don't fail the assignment if room update fails
        }
      }
      
      // Auto-assign all team assistants to the room (using guest_unique_id)
      if (guest_unique_id) {
      for (const assistantId of assistantIds) {
        await pool.query(
            `INSERT INTO assistant_assignments (assistant_id, guest_unique_id, is_active)
           VALUES ($1, $2, true)
             ON CONFLICT (assistant_id, guest_unique_id) 
           DO UPDATE SET is_active = true`,
            [assistantId, guest_unique_id]
          );
        }
      }
      
      // Notify all team assistants to join the room via Socket.IO (using guest_unique_id)
      if (guest_unique_id) {
        // Get room_number and checkin_date from rooms table for notification
        const roomInfo = await pool.query(
          'SELECT room_number, checkin_date FROM rooms WHERE guest_unique_id = $1 LIMIT 1',
          [guest_unique_id]
        );
        if (roomInfo.rows.length > 0) {
      io.emit('auto_join_room', {
            roomNumber: roomInfo.rows[0].room_number,
            checkinDate: roomInfo.rows[0].checkin_date,
            guestUniqueId: guest_unique_id,
        teamId: team_id,
        assistantIds: assistantIds
      });
        }
      }
    }
    
    res.json({ success: true, assignments: createdAssignments });
  } catch (error) {
    console.error('Error creating team assignments:', error);
    res.status(500).json({ error: 'Database error', message: error.message });
  }
});

// Delete team assignment
app.delete('/api/team-assignments/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE team_room_assignments SET is_active = false WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting team assignment:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Team Invite QR Code Endpoints



// Update yesterday's checkin dates to today (for testing/demo purposes)
app.post('/api/admin/update-checkin-dates', async (req, res) => {
  try {
    // Get yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    // Get today's date
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    // First, check how many rooms have yesterday's checkin date
    const checkResult = await pool.query(
      `SELECT room_number, guest_name, checkin_date 
       FROM rooms 
       WHERE checkin_date = $1::date`,
      [yesterdayStr]
    );
    
    if (checkResult.rows.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No rooms found with yesterday\'s checkin date',
        updatedRooms: 0,
        updatedMessages: 0
      });
    }
    
    // Update checkin_date to today and regenerate guest_unique_id
    // First get all rooms that will be updated
    const roomsToUpdate = await pool.query(
      `SELECT room_number, guest_name, guest_surname, checkin_date, checkout_date 
       FROM rooms 
       WHERE checkin_date = $1::date`,
      [yesterdayStr]
    );
    
    // Update each room with new guest_unique_id
    for (const room of roomsToUpdate.rows) {
      const guest_unique_id = generateGuestUniqueId(room.guest_name, room.guest_surname, todayStr, room.checkout_date);
      await pool.query(
      `UPDATE rooms 
         SET checkin_date = $1::date,
             guest_unique_id = $2
         WHERE room_number = $3 AND checkin_date = $4::date`,
        [todayStr, guest_unique_id, room.room_number, yesterdayStr]
      );
    }
    
    const updateResult = await pool.query(
      `SELECT room_number, guest_name, guest_surname, checkin_date, guest_unique_id
       FROM rooms 
       WHERE checkin_date = $1::date`,
      [todayStr]
    );
    
    // Also update messages' checkin_date if they reference these rooms
    const messagesUpdateResult = await pool.query(
      `UPDATE messages 
       SET checkin_date = $1::date 
       WHERE checkin_date = $2::date`,
      [todayStr, yesterdayStr]
    );
    
    res.json({ 
      success: true, 
      message: `Updated ${updateResult.rows.length} rooms and ${messagesUpdateResult.rowCount} messages`,
      updatedRooms: updateResult.rows.length,
      updatedMessages: messagesUpdateResult.rowCount,
      rooms: updateResult.rows.map(r => ({
        roomNumber: r.room_number,
        guestName: r.guest_name,
        checkinDate: r.checkin_date
      }))
    });
  } catch (error) {
    console.error('Error updating checkin dates:', error);
    res.status(500).json({ error: 'Database error', details: error.message });
  }
});

// ============================================
// Admin Middleware
// ============================================

// Middleware to check if user is authenticated as assistant
async function requireAssistant(req, res, next) {
  try {
    const assistantId = req.cookies?.assistant_id;
    
    if (!assistantId) {
      return res.status(401).json({ error: 'Unauthorized: Assistant authentication required' });
    }
    
    const result = await pool.query(
      'SELECT id, name, surname, is_active FROM assistants WHERE id = $1 AND is_active = true',
      [assistantId]
    );
    
    if (result.rows.length === 0) {
      res.clearCookie('assistant_id');
      return res.status(401).json({ error: 'Unauthorized: Assistant not found or inactive' });
    }
    
    req.assistant = result.rows[0];
    next();
  } catch (error) {
    console.error('Error checking assistant authentication:', error);
    res.status(500).json({ error: 'Database error' });
  }
}

// ============================================
// Info Posts & Activities API Endpoints
// ============================================

// Get all activities (for timeline calendar only) - Public
app.get('/api/activities', async (req, res) => {
  try {
    const { date, type, category, year } = req.query;
    
    // If date is specified, we need to check both exact matches and recurring patterns
    if (date) {
      const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
      console.log(`📅 Filtering activities by date: ${dateStr}`);
      
      // Import RRule dynamically (ES module)
      let RRule;
      try {
        const rruleModule = await import('rrule');
        // rrule package exports RRule in default export
        // Test showed: rruleModule.default.RRule exists
        if (rruleModule.default) {
          if (rruleModule.default.RRule) {
            RRule = rruleModule.default.RRule;
          } else if (typeof rruleModule.default.fromString === 'function') {
            // If default IS the RRule class itself
            RRule = rruleModule.default;
          } else {
            console.error('❌ RRule not found in default export. Keys:', Object.keys(rruleModule.default));
            RRule = null;
          }
        } else if (rruleModule.RRule) {
          RRule = rruleModule.RRule;
        } else {
          console.error('❌ RRule not found in rrule module. Available keys:', Object.keys(rruleModule));
          RRule = null;
        }
        
        // Verify RRule has fromString method
        if (RRule && typeof RRule.fromString !== 'function') {
          console.error('❌ RRule.fromString is not a function. RRule type:', typeof RRule);
          RRule = null;
        }
      } catch (e) {
        console.error('❌ Error importing rrule:', e.message, e.stack);
        RRule = null;
      }
      
      if (!RRule) {
        console.warn('⚠️ RRule not available, skipping recurring pattern checks');
      } else {
        logDebug('RRule imported successfully');
      }
      
      const selectedDate = new Date(dateStr + 'T00:00:00');
      
      // Get all activities (including recurring ones)
      let query = `
        SELECT * FROM activities 
        WHERE is_active = true
      `;
      const params = [];
      let paramCount = 1;
      
      // Filter by year (skip if all=true OR if date is specified)
      // When date is specified, we need all activities to check recurring patterns
      if (req.query.all !== 'true' && year && !date) {
        query += ` AND (activity_date IS NULL OR EXTRACT(YEAR FROM activity_date) = $${paramCount++})`;
        params.push(parseInt(year));
      }
      
      if (type && type !== 'Tümü') {
        query += ` AND type = $${paramCount++}`;
        params.push(type);
      }
      
      if (category) {
        query += ` AND category = $${paramCount++}`;
        params.push(category);
      }
      
      query += ` ORDER BY activity_date ASC, start_time ASC, display_order ASC`;
      
      const result = await retryQuery(() => pool.query(query, params));
      logDebug(`Activities query returned ${result.rows.length} results`);
      
      // Filter results: include activities that match the date either:
      // 1. Exact date match (activity_date = selected date)
      // 2. Recurring pattern match (rrule includes selected date)
      const filteredActivities = result.rows.filter(activity => {
        // Exact date match - normalize dates for comparison
        let activityDateStr = null;
        if (activity.activity_date) {
          if (activity.activity_date instanceof Date) {
            activityDateStr = activity.activity_date.toISOString().split('T')[0];
          } else {
            // PostgreSQL returns date as string in format 'YYYY-MM-DD'
            const dateStr = String(activity.activity_date);
            activityDateStr = dateStr.split('T')[0].split(' ')[0]; // Handle both 'YYYY-MM-DD' and 'YYYY-MM-DD HH:MM:SS'
          }
        }
        
        // Exact date match
        if (activityDateStr === dateStr) {
          return true;
        }
        
        // Check recurring pattern
        if (activity.rrule && activity.activity_date && RRule) {
          try {
            const startDate = new Date(activityDateStr + 'T00:00:00');
            
            // Check if selected date is within recurring range
            if (selectedDate >= startDate) {
              // Check recurring_until limit
              if (activity.recurring_until) {
                const untilDate = new Date(activity.recurring_until + 'T23:59:59');
                if (selectedDate > untilDate) {
                  return false;
                }
              }
              
              // For DAILY frequency, simple range check is sufficient
              if (activity.rrule.includes('FREQ=DAILY')) {
                return true;
              }
              
              // For other frequencies (WEEKLY, MONTHLY, etc.), use RRule to check
              const rrule = RRule.fromString(activity.rrule);
              const endCheckDate = new Date(selectedDate);
              endCheckDate.setHours(23, 59, 59, 999);
              const occurrences = rrule.between(startDate, endCheckDate, true);
              
              return occurrences.some(occ => {
                const occDate = occ.toISOString().split('T')[0];
                return occDate === dateStr;
              });
            }
          } catch (e) {
            logDebug(`Error parsing RRule for activity ${activity.id}:`, e.message);
            return false;
          }
        }
        
        return false;
      });
      
      // Update activity_date for recurring activities to show the selected date
      const activitiesWithDate = filteredActivities.map(activity => ({
        ...activity,
        activity_date: activity.activity_date === dateStr ? activity.activity_date : dateStr
      }));
      
      logDebug(`Found ${activitiesWithDate.length} activities for ${dateStr}`);
      res.json(activitiesWithDate);
    } else {
      // No date filter - return all activities
      let query = `
        SELECT * FROM activities 
        WHERE is_active = true
      `;
      const params = [];
      let paramCount = 1;
      
      // Filter by year (skip if all=true)
      if (req.query.all !== 'true' && year) {
        query += ` AND EXTRACT(YEAR FROM activity_date) = $${paramCount++}`;
        params.push(parseInt(year));
      }
      
      if (type && type !== 'Tümü') {
        query += ` AND type = $${paramCount++}`;
        params.push(type);
      }
      
      if (category) {
        query += ` AND category = $${paramCount++}`;
        params.push(category);
      }
      
      query += ` ORDER BY activity_date ASC, start_time ASC, display_order ASC`;
      
      const result = await retryQuery(() => pool.query(query, params));
      res.json(result.rows);
    }
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ error: 'Failed to load activities' });
  }
});

// Get story tray items (for info section)
app.get('/api/story-tray-items', async (req, res) => {
  try {
    const result = await retryQuery(() =>
      pool.query(`
        SELECT 
          id,
          title,
          icon,
          video_url,
          image_url,
          display_order,
          is_active,
          created_at,
          updated_at
        FROM story_tray_items
        WHERE is_active = true
        ORDER BY display_order ASC, created_at DESC
      `)
    );
    
    // Parse JSON arrays for image_url and video_url
    const items = result.rows.map(item => {
      if (item.image_url) {
        try {
          item.image_url = JSON.parse(item.image_url);
        } catch (e) {
          // If not JSON, keep as is (single value)
        }
      }
      if (item.video_url) {
        try {
          item.video_url = JSON.parse(item.video_url);
        } catch (e) {
          // If not JSON, keep as is (single value)
        }
      }
      return item;
    });
    
    res.json(items);
  } catch (error) {
    console.error('Error fetching story tray items:', error);
    res.status(500).json({ error: 'Failed to load story tray items' });
  }
});

// ============================================
// Admin Endpoints for Story Tray Items
// ============================================

// Get all story tray items (admin - includes inactive)
app.get('/api/admin/story-tray-items', async (req, res) => {
  try {
    const result = await retryQuery(() =>
      pool.query(`
        SELECT * FROM story_tray_items 
        ORDER BY display_order ASC, created_at DESC
      `)
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching story tray items (admin):', error);
    res.status(500).json({ error: 'Failed to load story tray items' });
  }
});

// Get single story tray item (admin)
app.get('/api/admin/story-tray-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await retryQuery(() =>
      pool.query('SELECT * FROM story_tray_items WHERE id = $1', [id])
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story tray item not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching story tray item (admin):', error);
    res.status(500).json({ error: 'Failed to load story tray item' });
  }
});

// Create story tray item
app.post('/api/admin/story-tray-items', async (req, res) => {
  try {
    const { title, icon, display_order, is_active, video_url, image_url } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const result = await retryQuery(() =>
      pool.query(`
        INSERT INTO story_tray_items (
          title, icon, display_order, is_active, video_url, image_url
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [title, icon || null, display_order || 0, is_active !== false, video_url || null, image_url || null])
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating story tray item:', error);
    res.status(500).json({ error: 'Failed to create story tray item' });
  }
});

// Update story tray item
app.put('/api/admin/story-tray-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, icon, display_order, is_active, video_url, image_url } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const result = await retryQuery(() =>
      pool.query(`
        UPDATE story_tray_items
        SET title = $1, icon = $2, display_order = $3, is_active = $4, 
            video_url = $5, image_url = $6, updated_at = CURRENT_TIMESTAMP
        WHERE id = $7
        RETURNING *
      `, [title, icon || null, display_order || 0, is_active !== false, video_url || null, image_url || null, id])
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story tray item not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating story tray item:', error);
    res.status(500).json({ error: 'Failed to update story tray item' });
  }
});

// Delete story tray item
app.delete('/api/admin/story-tray-items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await retryQuery(() =>
      pool.query('DELETE FROM story_tray_items WHERE id = $1 RETURNING *', [id])
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story tray item not found' });
    }
    
    res.json({ success: true, message: 'Story tray item deleted' });
  } catch (error) {
    console.error('Error deleting story tray item:', error);
    res.status(500).json({ error: 'Failed to delete story tray item' });
  }
});

// Upload photo/video for story tray item
app.post('/api/admin/story-tray-items/:id/upload', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    let image_url = req.body.image_url;
    let video_url = req.body.video_url;
    
    // If file was uploaded, use the file path
    if (req.file) {
      // Use absolute URL for better compatibility across devices
      const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      const filePath = join(uploadsDir, req.file.filename);
      
      // Verify file was actually saved
      if (fs.existsSync(filePath)) {
        console.log(`✅ File uploaded successfully: ${req.file.filename}`);
        console.log(`   Path: ${filePath}`);
        console.log(`   URL: ${fileUrl}`);
        console.log(`   Size: ${fs.statSync(filePath).size} bytes`);
      } else {
        console.error(`❌ File upload failed: ${req.file.filename} not found in ${uploadsDir}`);
      }
      
      if (req.file.mimetype.startsWith('image/')) {
        image_url = fileUrl;
      } else if (req.file.mimetype.startsWith('video/')) {
        video_url = fileUrl;
      }
    }
    
    const result = await retryQuery(() =>
      pool.query(`
        UPDATE story_tray_items
        SET image_url = $1, video_url = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *
      `, [image_url || null, video_url || null, id])
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story tray item not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading file for story tray item:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// ============================================
// Admin Endpoints for Activities
// ============================================

// Get all activities (admin - includes inactive) - No auth required for viewing
app.get('/api/admin/activities', async (req, res) => {
  try {
    const result = await retryQuery(() =>
      pool.query(`
        SELECT * FROM activities 
        ORDER BY display_order ASC, created_at DESC
      `)
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching activities (admin):', error);
    res.status(500).json({ error: 'Failed to load activities' });
  }
});

// Get single activity (admin) - No auth required for viewing
app.get('/api/admin/activities/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM activities WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching activity (admin):', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create activity
app.post('/api/admin/activities', async (req, res) => {
  try {
    const { 
      title, icon, display_order, is_active, activity_date, start_time, end_time, end_date,
      description, category, type, location, instructor_name, age_group, capacity,
      featured, map_latitude, map_longitude, video_url, image_url,
      recurring_rule, recurring_until, rrule
    } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const result = await pool.query(`
      INSERT INTO activities (
        title, icon, display_order, is_active, activity_date, start_time, end_time, end_date,
        description, category, type, location, instructor_name, age_group, capacity,
        featured, map_latitude, map_longitude, video_url, image_url,
        recurring_rule, recurring_until, rrule
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      RETURNING *
    `, [
      title.trim(),
      icon || null,
      display_order || 0,
      is_active !== undefined ? is_active : true,
      activity_date || null,
      start_time || null,
      end_time || null,
      end_date || null,
      description || null,
      category || null,
      type || null,
      location || null,
      instructor_name || null,
      age_group || null,
      capacity || null,
      featured || false,
      map_latitude || null,
      map_longitude || null,
      video_url || null,
      image_url || null,
      recurring_rule || null,
      recurring_until || null,
      rrule || null
    ]);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating activity:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Update activity
app.put('/api/admin/activities/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      title, icon, display_order, is_active, activity_date, start_time, end_time, end_date,
      description, category, type, location, instructor_name, age_group, capacity,
      featured, map_latitude, map_longitude, video_url, image_url,
      recurring_rule, recurring_until, rrule
    } = req.body;
    
    const result = await pool.query(`
      UPDATE activities 
      SET 
        title = COALESCE($1, title),
        icon = COALESCE($2, icon),
        display_order = COALESCE($3, display_order),
        is_active = COALESCE($4, is_active),
        activity_date = COALESCE($5, activity_date),
        start_time = COALESCE($6, start_time),
        end_time = COALESCE($7, end_time),
        end_date = COALESCE($8, end_date),
        description = COALESCE($9, description),
        category = COALESCE($10, category),
        type = COALESCE($11, type),
        location = COALESCE($12, location),
        instructor_name = COALESCE($13, instructor_name),
        age_group = COALESCE($14, age_group),
        capacity = COALESCE($15, capacity),
        featured = COALESCE($16, featured),
        map_latitude = COALESCE($17, map_latitude),
        map_longitude = COALESCE($18, map_longitude),
        video_url = COALESCE($19, video_url),
        image_url = COALESCE($20, image_url),
        recurring_rule = COALESCE($21, recurring_rule),
        recurring_until = COALESCE($22, recurring_until),
        rrule = COALESCE($23, rrule),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $24
      RETURNING *
    `, [
      title, icon, display_order, is_active, activity_date, start_time, end_time, end_date,
      description, category, type, location, instructor_name, age_group, capacity,
      featured, map_latitude, map_longitude, video_url, image_url,
      recurring_rule, recurring_until, rrule, id
    ]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating activity:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete activity
app.delete('/api/admin/activities/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('DELETE FROM activities WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }
    
    res.json({ success: true, message: 'Activity deleted' });
  } catch (error) {
    console.error('Error deleting activity:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Update activity date/time (for drag and drop)
app.patch('/api/admin/activities/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    const { activity_date, start_time, end_time } = req.body;
    
    if (!activity_date) {
      return res.status(400).json({ error: 'activity_date is required' });
    }
    
    const result = await pool.query(`
      UPDATE activities 
      SET 
        activity_date = $1,
        start_time = COALESCE($2, start_time),
        end_time = COALESCE($3, end_time),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [activity_date, start_time || null, end_time || null, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error moving activity:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Upload photo/video for activity (supports both file upload and URL)
app.post('/api/admin/activities/:id/upload', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    let image_url = req.body.image_url;
    let video_url = req.body.video_url;
    
    // If file was uploaded, use the file path
    if (req.file) {
      // Use absolute URL for better compatibility across devices
      const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      const filePath = join(uploadsDir, req.file.filename);
      
      // Verify file was actually saved
      if (fs.existsSync(filePath)) {
        console.log(`✅ File uploaded successfully: ${req.file.filename}`);
        console.log(`   Path: ${filePath}`);
        console.log(`   URL: ${fileUrl}`);
        console.log(`   Size: ${fs.statSync(filePath).size} bytes`);
      } else {
        console.error(`❌ File upload failed: ${req.file.filename} not found in ${uploadsDir}`);
      }
      
      if (req.file.mimetype.startsWith('image/')) {
        image_url = fileUrl;
        video_url = null;
      } else if (req.file.mimetype.startsWith('video/')) {
        video_url = fileUrl;
        image_url = null;
      }
    }
    
    if (!image_url && !video_url) {
      return res.status(400).json({ error: 'image_url, video_url, or file is required' });
    }
    
    const updateFields = [];
    const values = [];
    let paramCount = 1;
    
    if (image_url) {
      updateFields.push(`image_url = $${paramCount++}`);
      values.push(image_url);
      // Clear video_url if uploading image
      updateFields.push(`video_url = NULL`);
    }
    
    if (video_url) {
      updateFields.push(`video_url = $${paramCount++}`);
      values.push(video_url);
      // Clear image_url if uploading video
      updateFields.push(`image_url = NULL`);
    }
    
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    
    const query = `
      UPDATE activities 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;
    
    const result = await pool.query(query, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading media for activity:', error);
    res.status(500).json({ error: 'Database error', message: error.message });
  }
});

// Helper function to parse JSON arrays in post data
function parsePostMedia(post) {
  if (post.image_url) {
    try {
      post.image_url = JSON.parse(post.image_url);
    } catch (e) {
      // If not JSON, convert to array
      post.image_url = [post.image_url];
    }
  }
  if (post.video_url) {
    try {
      post.video_url = JSON.parse(post.video_url);
    } catch (e) {
      // If not JSON, convert to array
      post.video_url = [post.video_url];
    }
  }
  return post;
}

// Get all info posts - Public
// Map search endpoint - search locations by name
app.get('/api/map/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length === 0) {
      return res.json([]);
    }
    
    // Translation map for common search terms (translate to Turkish for database search)
    // Database stores names in Turkish, so we translate search terms to Turkish
    const translationMap = {
      // English to Turkish (based on database location names)
      'reception': 'resepsiyon',
      'lobby': 'lobby',
      'restaurant': 'restoran',
      'restaurant terrace': 'restoran teras',
      'spa': 'spa',
      'beach club': 'beach club',
      'beach': 'sahil',
      'pool': 'havuz',
      'main pool': 'ana havuz',
      'activity pool': 'aktivite havuz',
      'family pool': 'family havuz',
      'bar': 'bar',
      'lobby bar': 'lobby bar',
      'lounge bar': 'lounge bar',
      'beach bar': 'sahil bar',
      'cinema': 'sinema',
      'game': 'oyun',
      'game room': 'oyun salon',
      'shop': 'shop',
      'shops': 'shops',
      'doctor': 'doktor',
      'tennis': 'tenis',
      'tennis court': 'tenis court',
      'volleyball': 'voleybol',
      'volleyball court': 'voleybol court',
      'aquapark': 'aquapark',
      'aqua park': 'aquapark',
      'bakery': 'pastane',
      'terrace': 'teras',
      'ice cream': 'dondurma',
      'fruit': 'meyve',
      'family': 'aile',
      'activity': 'aktivite',
      'main': 'ana',
      'court': 'court',
      'water sports': 'su sporlar',
      'animation': 'animasyon',
      'desk': 'desk',
      'animation desk': 'animasyon desk',
      'cuisine': 'cuisine',
      'cuisine 24': 'cuisine 24',
      'boccia': 'boccia',
      'luna park': 'luna park',
      'pier': 'iskele',
      'wc': 'wc',
      'toilet': 'wc',
      'elevator': 'asansör',
      'lift': 'asansör',
      // German to Turkish
      'empfang': 'resepsiyon',
      'restaurant': 'restoran',
      'strand': 'sahil',
      'pool': 'havuz',
      'bar': 'bar',
      'kino': 'sinema',
      'spiel': 'oyun',
      'laden': 'shop',
      'arzt': 'doktor',
      'tennis': 'tenis',
      'volleyball': 'voleybol',
      'bäckerei': 'pastane',
      'terrasse': 'teras',
      'eis': 'dondurma',
      'obst': 'meyve',
      'familie': 'aile',
      'aktivität': 'aktivite',
      'haupt': 'ana',
      'platz': 'court',
      'wassersport': 'su sporlar',
      'animation': 'animasyon',
      'küche': 'cuisine',
      // Russian to Turkish
      'ресепшн': 'resepsiyon',
      'ресторан': 'restoran',
      'пляж': 'sahil',
      'бассейн': 'havuz',
      'бар': 'bar',
      'кино': 'sinema',
      'игра': 'oyun',
      'магазин': 'shop',
      'доктор': 'doktor',
      'теннис': 'tenis',
      'волейбол': 'voleybol',
      'пекарня': 'pastane',
      'терраса': 'teras',
      'мороженое': 'dondurma',
      'фрукты': 'meyve',
      'семья': 'aile',
      'активность': 'aktivite',
      'главный': 'ana',
      'корт': 'court',
      'водный спорт': 'su sporlar',
      'анимация': 'animasyon',
      'кухня': 'cuisine',
    };
    
    // Try to translate the search term to Turkish
    const searchQuery = q.trim().toLowerCase();
    let searchTerm = translationMap[searchQuery] || searchQuery;
    
    // Also try partial matches in translation map
    for (const [key, value] of Object.entries(translationMap)) {
      if (searchQuery.includes(key)) {
        searchTerm = value;
        break;
      }
    }
    
    // Search in database with Turkish names
    // Use ILIKE for case-insensitive search
    searchTerm = `%${searchTerm}%`;
    
    const result = await pool.query(`
      SELECT id, name, category, latitude, longitude, distance_km
      FROM map_search_locations
      WHERE LOWER(name) LIKE $1
      ORDER BY id, name
      LIMIT 20
    `, [searchTerm]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error searching map locations:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get featured/popular locations for map chips (non-room locations: id >= 1000)
app.get('/api/map/locations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, category, latitude, longitude, distance_km
      FROM map_search_locations
      WHERE id >= 1000
      ORDER BY id, name
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching map locations:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/info-posts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM info_posts 
      WHERE is_active = true 
      ORDER BY display_order ASC, created_at ASC
    `);
    const posts = result.rows.map(parsePostMedia);
    res.json(posts);
  } catch (error) {
    console.error('Error fetching info posts:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// ============================================
// Admin Endpoints for Info Posts
// ============================================

// Get all info posts (admin - includes inactive) - No auth required for viewing
app.get('/api/admin/info-posts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM info_posts
      ORDER BY display_order ASC, created_at DESC
    `);
    const posts = result.rows.map(parsePostMedia);
    res.json(posts);
  } catch (error) {
    console.error('Error fetching info posts (admin):', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get single info post (admin)
// Get single info post (admin) - No auth required for viewing
app.get('/api/admin/info-posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM info_posts WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    res.json(parsePostMedia(result.rows[0]));
  } catch (error) {
    console.error('Error fetching info post (admin):', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create info post
app.post('/api/admin/info-posts', requireAssistant, async (req, res) => {
  try {
    const { post_id, title, icon, caption, display_order, is_active, location, image_url, video_url } = req.body;
    
    if (!post_id || !title) {
      return res.status(400).json({ error: 'post_id and title are required' });
    }

    // Handle arrays: convert single values to arrays, ensure arrays are JSON strings
    let mediaImage = null;
    let mediaVideo = null;
    
    if (image_url) {
      if (Array.isArray(image_url)) {
        mediaImage = JSON.stringify(image_url.filter(url => url && url.trim()));
      } else if (typeof image_url === 'string') {
        // Single value - convert to array
        const trimmed = image_url.trim();
        mediaImage = trimmed ? JSON.stringify([trimmed]) : null;
      }
    }
    
    if (video_url) {
      if (Array.isArray(video_url)) {
        mediaVideo = JSON.stringify(video_url.filter(url => url && url.trim()));
      } else if (typeof video_url === 'string') {
        // Single value - convert to array
        const trimmed = video_url.trim();
        mediaVideo = trimmed ? JSON.stringify([trimmed]) : null;
      }
    }
    
    const result = await pool.query(`
      INSERT INTO info_posts (post_id, title, icon, location, image_url, video_url, caption, display_order, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      post_id.trim(),
      title.trim(),
      icon || null,
      location || null,
      mediaImage,
      mediaVideo,
      caption || null,
      display_order || 0,
      is_active !== undefined ? is_active : true
    ]);
    
    // Parse JSON arrays in response
    const post = result.rows[0];
    if (post.image_url) {
      try {
        post.image_url = JSON.parse(post.image_url);
      } catch (e) {
        // If not JSON, convert to array
        post.image_url = [post.image_url];
      }
    }
    if (post.video_url) {
      try {
        post.video_url = JSON.parse(post.video_url);
      } catch (e) {
        // If not JSON, convert to array
        post.video_url = [post.video_url];
      }
    }
    
    res.json(post);
  } catch (error) {
    console.error('Error creating info post:', error);
    if (error.code === '23505') { // Unique violation
      return res.status(400).json({ error: 'Post ID already exists' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

// Update info post - No auth required (for media management)
app.put('/api/admin/info-posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, icon, caption, display_order, is_active, image_url, video_url, location } = req.body;

    const updateFields = [];
    const values = [];
    let paramCount = 1;

    if (title !== undefined) { updateFields.push(`title = $${paramCount++}`); values.push(title); }
    if (icon !== undefined) { updateFields.push(`icon = $${paramCount++}`); values.push(icon); }
    if (location !== undefined) { updateFields.push(`location = $${paramCount++}`); values.push(location); }
    if (caption !== undefined) { updateFields.push(`caption = $${paramCount++}`); values.push(caption); }
    if (display_order !== undefined) { updateFields.push(`display_order = $${paramCount++}`); values.push(display_order); }
    if (is_active !== undefined) { updateFields.push(`is_active = $${paramCount++}`); values.push(is_active); }

    // Media: handle arrays
    if (image_url !== undefined) {
      if (image_url === null || (Array.isArray(image_url) && image_url.length === 0)) {
        updateFields.push(`image_url = NULL`);
      } else {
        const imageArray = Array.isArray(image_url) 
          ? image_url.filter(url => url && url.trim())
          : [image_url.trim()];
        updateFields.push(`image_url = $${paramCount++}`);
        values.push(imageArray.length > 0 ? JSON.stringify(imageArray) : null);
      }
    }
    
    if (video_url !== undefined) {
      if (video_url === null || (Array.isArray(video_url) && video_url.length === 0)) {
        updateFields.push(`video_url = NULL`);
      } else {
        const videoArray = Array.isArray(video_url)
          ? video_url.filter(url => url && url.trim())
          : [video_url.trim()];
        updateFields.push(`video_url = $${paramCount++}`);
        values.push(videoArray.length > 0 ? JSON.stringify(videoArray) : null);
      }
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(`
      UPDATE info_posts
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    // Parse JSON arrays in response
    const post = result.rows[0];
    if (post.image_url) {
      try {
        post.image_url = JSON.parse(post.image_url);
      } catch (e) {
        post.image_url = [post.image_url];
      }
    }
    if (post.video_url) {
      try {
        post.video_url = JSON.parse(post.video_url);
      } catch (e) {
        post.video_url = [post.video_url];
      }
    }
    
    res.json(post);
  } catch (error) {
    console.error('Error updating info post:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete info post
app.delete('/api/admin/info-posts/:id', requireAssistant, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query('DELETE FROM info_posts WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    res.json({ success: true, message: 'Post deleted' });
  } catch (error) {
    console.error('Error deleting info post:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Upload photo/video for info post (supports both file upload and URL, adds to existing array)
app.post('/api/admin/info-posts/:id/upload', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    let image_url = req.body.image_url;
    let video_url = req.body.video_url;
    
    // If file was uploaded, use the file path
    if (req.file) {
      // Use absolute URL for better compatibility across devices
      const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      const filePath = join(uploadsDir, req.file.filename);
      
      if (fs.existsSync(filePath)) {
        logDebug(`File uploaded successfully: ${req.file.filename} -> ${fileUrl}`);
      } else {
        console.error(`File upload failed: ${req.file.filename} not found`);
      }
      
      if (req.file.mimetype.startsWith('image/')) {
        image_url = fileUrl;
      } else if (req.file.mimetype.startsWith('video/')) {
        video_url = fileUrl;
      }
    }
    
    if (!image_url && !video_url) {
      return res.status(400).json({ error: 'image_url, video_url, or file is required' });
    }

    // Get current post to append to existing arrays
    const currentPost = await pool.query('SELECT image_url, video_url FROM info_posts WHERE id = $1', [id]);
    if (currentPost.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const updateFields = [];
    const values = [];
    let paramCount = 1;

    if (image_url) {
      // Parse existing array or create new one
      let existingImages = [];
      if (currentPost.rows[0].image_url) {
        try {
          existingImages = JSON.parse(currentPost.rows[0].image_url);
        } catch (e) {
          existingImages = [currentPost.rows[0].image_url];
        }
      }
      // Add new image if not already in array
      if (!existingImages.includes(image_url)) {
        existingImages.push(image_url);
      }
      updateFields.push(`image_url = $${paramCount++}`);
      values.push(JSON.stringify(existingImages));
    }
    
    if (video_url) {
      // Parse existing array or create new one
      let existingVideos = [];
      if (currentPost.rows[0].video_url) {
        try {
          existingVideos = JSON.parse(currentPost.rows[0].video_url);
        } catch (e) {
          existingVideos = [currentPost.rows[0].video_url];
        }
      }
      // Add new video if not already in array
      if (!existingVideos.includes(video_url)) {
        existingVideos.push(video_url);
      }
      updateFields.push(`video_url = $${paramCount++}`);
      values.push(JSON.stringify(existingVideos));
    }
    
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    
    const result = await pool.query(`
      UPDATE info_posts 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `, values);
    
    // Parse JSON arrays in response
    const post = result.rows[0];
    if (post.image_url) {
      try {
        post.image_url = JSON.parse(post.image_url);
      } catch (e) {
        post.image_url = [post.image_url];
      }
    }
    if (post.video_url) {
      try {
        post.video_url = JSON.parse(post.video_url);
      } catch (e) {
        post.video_url = [post.video_url];
      }
    }
    
    res.json(post);
  } catch (error) {
    console.error('Error uploading media for info post:', error);
    res.status(500).json({ error: 'Database error', message: error.message });
  }
});

// Get single info post by post_id
app.get('/api/info-posts/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    const result = await pool.query(`
      SELECT * FROM info_posts 
      WHERE post_id = $1 AND is_active = true
    `, [postId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    res.json(parsePostMedia(result.rows[0]));
  } catch (error) {
    console.error('Error fetching info post:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Like/Unlike a post
app.post('/api/info-posts/:postId/like', async (req, res) => {
  try {
    const { postId } = req.params;
    const guest_unique_id = req.cookies?.guest_unique_id;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Get post by post_id
    const postResult = await pool.query(`
      SELECT id FROM info_posts WHERE post_id = $1 AND is_active = true
    `, [postId]);
    
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const postDbId = postResult.rows[0].id;
    
    // Check if already liked
    const likeCheck = await pool.query(`
      SELECT id FROM post_likes 
      WHERE post_id = $1 AND guest_unique_id = $2
    `, [postDbId, guest_unique_id]);
    
    let liked = false;
    
    if (likeCheck.rows.length > 0) {
      // Unlike
      await pool.query(`
        DELETE FROM post_likes 
        WHERE post_id = $1 AND guest_unique_id = $2
      `, [postDbId, guest_unique_id]);
      
      // Decrease likes count
      await pool.query(`
        UPDATE info_posts 
        SET likes_count = GREATEST(likes_count - 1, 0)
        WHERE id = $1
      `, [postDbId]);
    } else {
      // Like
      await pool.query(`
        INSERT INTO post_likes (post_id, guest_unique_id)
        VALUES ($1, $2)
      `, [postDbId, guest_unique_id]);
      
      // Increase likes count
      await pool.query(`
        UPDATE info_posts 
        SET likes_count = likes_count + 1
        WHERE id = $1
      `, [postDbId]);
      
      liked = true;
    }
    
    // Get updated likes count
    const countResult = await pool.query(`
      SELECT likes_count FROM info_posts WHERE id = $1
    `, [postDbId]);
    
    res.json({
      liked,
      likesCount: parseInt(countResult.rows[0].likes_count) || 0
    });
  } catch (error) {
    console.error('Error toggling like:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get post likes
app.get('/api/info-posts/:postId/likes', async (req, res) => {
  try {
    const { postId } = req.params;
    const guest_unique_id = req.cookies?.guest_unique_id;
    
    const postResult = await pool.query(`
      SELECT id FROM info_posts WHERE post_id = $1 AND is_active = true
    `, [postId]);
    
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const postDbId = postResult.rows[0].id;
    const countResult = await pool.query(`
      SELECT COUNT(*) as count FROM post_likes WHERE post_id = $1
    `, [postDbId]);
    
    let userLiked = false;
    if (guest_unique_id) {
      const likeCheck = await pool.query(`
        SELECT id FROM post_likes 
        WHERE post_id = $1 AND guest_unique_id = $2
      `, [postDbId, guest_unique_id]);
      userLiked = likeCheck.rows.length > 0;
    }
    
    res.json({ 
      count: parseInt(countResult.rows[0].count) || 0,
      userLiked: userLiked
    });
  } catch (error) {
    console.error('Error fetching likes:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get post comments
app.get('/api/info-posts/:postId/comments', async (req, res) => {
  try {
    const { postId } = req.params;
    
    const postResult = await pool.query(`
      SELECT id FROM info_posts WHERE post_id = $1 AND is_active = true
    `, [postId]);
    
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const postDbId = postResult.rows[0].id;
    const result = await pool.query(`
      SELECT 
        pc.*,
        r.guest_name,
        r.guest_surname,
        r.profile_photo
      FROM post_comments pc
      INNER JOIN rooms r ON pc.guest_unique_id = r.guest_unique_id
      WHERE pc.post_id = $1
      ORDER BY pc.created_at ASC
    `, [postDbId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Add comment to post
app.post('/api/info-posts/:postId/comments', async (req, res) => {
  try {
    const { postId } = req.params;
    const { comment } = req.body;
    const guest_unique_id = req.cookies?.guest_unique_id;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!comment || comment.trim().length === 0) {
      return res.status(400).json({ error: 'Comment is required' });
    }
    
    const postResult = await pool.query(`
      SELECT id FROM info_posts WHERE post_id = $1 AND is_active = true
    `, [postId]);
    
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const postDbId = postResult.rows[0].id;
    
    const result = await pool.query(`
      INSERT INTO post_comments (post_id, guest_unique_id, comment)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [postDbId, guest_unique_id, comment.trim()]);
    
    // Get guest info
    const guestResult = await pool.query(`
      SELECT guest_name, guest_surname, profile_photo
      FROM rooms
      WHERE guest_unique_id = $1
    `, [guest_unique_id]);
    
    const commentData = result.rows[0];
    if (guestResult.rows.length > 0) {
      commentData.guest_name = guestResult.rows[0].guest_name;
      commentData.guest_surname = guestResult.rows[0].guest_surname;
      commentData.profile_photo = guestResult.rows[0].profile_photo;
    }
    
    res.json(commentData);
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete comment
app.delete('/api/info-posts/comments/:commentId', async (req, res) => {
  try {
    const { commentId } = req.params;
    const guest_unique_id = req.cookies?.guest_unique_id;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Check if comment belongs to user
    const checkResult = await pool.query(`
      SELECT id FROM post_comments 
      WHERE id = $1 AND guest_unique_id = $2
    `, [commentId, guest_unique_id]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found or unauthorized' });
    }
    
    await pool.query(`
      DELETE FROM post_comments WHERE id = $1
    `, [commentId]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Bookmark/Unbookmark a post
app.post('/api/info-posts/:postId/bookmark', async (req, res) => {
  try {
    const { postId } = req.params;
    const guest_unique_id = req.cookies?.guest_unique_id;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const postResult = await pool.query(`
      SELECT id FROM info_posts WHERE post_id = $1 AND is_active = true
    `, [postId]);
    
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const postDbId = postResult.rows[0].id;
    
    // Check if already bookmarked
    const bookmarkCheck = await pool.query(`
      SELECT id FROM post_bookmarks 
      WHERE post_id = $1 AND guest_unique_id = $2
    `, [postDbId, guest_unique_id]);
    
    let bookmarked = false;
    
    if (bookmarkCheck.rows.length > 0) {
      // Unbookmark
      await pool.query(`
        DELETE FROM post_bookmarks 
        WHERE post_id = $1 AND guest_unique_id = $2
      `, [postDbId, guest_unique_id]);
    } else {
      // Bookmark
      await pool.query(`
        INSERT INTO post_bookmarks (post_id, guest_unique_id)
        VALUES ($1, $2)
      `, [postDbId, guest_unique_id]);
      bookmarked = true;
    }
    
    res.json({ bookmarked });
  } catch (error) {
    console.error('Error toggling bookmark:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get bookmarked posts
app.get('/api/info-posts/bookmarked', async (req, res) => {
  try {
    const guest_unique_id = req.cookies?.guest_unique_id;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const result = await pool.query(`
      SELECT ip.*
      FROM info_posts ip
      INNER JOIN post_bookmarks pb ON ip.id = pb.post_id
      WHERE pb.guest_unique_id = $1 AND ip.is_active = true
      ORDER BY pb.created_at DESC
    `, [guest_unique_id]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching bookmarked posts:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get DMs for a post
app.get('/api/info-posts/:postId/dm', async (req, res) => {
  try {
    const { postId } = req.params;
    const guest_unique_id = req.cookies?.guest_unique_id;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const postResult = await pool.query(`
      SELECT id FROM info_posts WHERE post_id = $1 AND is_active = true
    `, [postId]);
    
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const postDbId = postResult.rows[0].id;
    
    // Get DMs where user is sender or receiver
    const result = await pool.query(`
      SELECT 
        dm.*,
        r1.guest_name as from_name,
        r1.guest_surname as from_surname,
        r1.profile_photo as from_photo,
        r2.guest_name as to_name,
        r2.guest_surname as to_surname,
        r2.profile_photo as to_photo
      FROM direct_messages dm
      LEFT JOIN rooms r1 ON dm.from_guest_unique_id = r1.guest_unique_id
      LEFT JOIN rooms r2 ON dm.to_guest_unique_id = r2.guest_unique_id
      WHERE dm.post_id = $1 
        AND (dm.from_guest_unique_id = $2 OR dm.to_guest_unique_id = $2)
      ORDER BY dm.created_at ASC
    `, [postDbId, guest_unique_id]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching DMs:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Send DM
app.post('/api/info-posts/:postId/dm', async (req, res) => {
  try {
    const { postId } = req.params;
    const { to_guest_unique_id, message } = req.body;
    const from_guest_unique_id = req.cookies?.guest_unique_id;
    
    if (!from_guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!to_guest_unique_id || !message || message.trim().length === 0) {
      return res.status(400).json({ error: 'to_guest_unique_id and message are required' });
    }
    
    const postResult = await pool.query(`
      SELECT id FROM info_posts WHERE post_id = $1 AND is_active = true
    `, [postId]);
    
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const postDbId = postResult.rows[0].id;
    
    const result = await pool.query(`
      INSERT INTO direct_messages (post_id, from_guest_unique_id, to_guest_unique_id, message)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [postDbId, from_guest_unique_id, to_guest_unique_id, message.trim()]);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error sending DM:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get all DMs for current user
app.get('/api/dms', async (req, res) => {
  try {
    const guest_unique_id = req.cookies?.guest_unique_id;
    
    if (!guest_unique_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const result = await pool.query(`
      SELECT 
        dm.*,
        ip.post_id,
        ip.title as post_title,
        r1.guest_name as from_name,
        r1.guest_surname as from_surname,
        r1.profile_photo as from_photo,
        r2.guest_name as to_name,
        r2.guest_surname as to_surname,
        r2.profile_photo as to_photo
      FROM direct_messages dm
      INNER JOIN info_posts ip ON dm.post_id = ip.id
      LEFT JOIN rooms r1 ON dm.from_guest_unique_id = r1.guest_unique_id
      LEFT JOIN rooms r2 ON dm.to_guest_unique_id = r2.guest_unique_id
      WHERE dm.from_guest_unique_id = $1 OR dm.to_guest_unique_id = $1
      ORDER BY dm.created_at DESC
    `, [guest_unique_id]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching DMs:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get assistant's assigned rooms (filtered by check-in date)
// Get assistant's teams
app.get('/api/assistant/:assistantId/teams', async (req, res) => {
  try {
    const { assistantId } = req.params;
    const result = await pool.query(`
      SELECT t.id, t.name, t.description
      FROM teams t
      INNER JOIN assistant_teams at ON t.id = at.team_id
      WHERE at.assistant_id = $1 
        AND at.is_active = true 
        AND t.is_active = true
      ORDER BY t.name
    `, [assistantId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching assistant teams:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/assistant/:assistantId/rooms', async (req, res) => {
  try {
    const { assistantId } = req.params;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    
    // Get rooms assigned to assistant's teams with last message info
    // Filter logic:
    // 1. Show rooms until checkout_date + 1 day
    // 2. If guest sent a message, show until last_message_time + 2 days
    // 3. Use whichever is later
    const result = await pool.query(`
      WITH room_messages AS (
      SELECT 
        r.id,
        r.room_number,
        r.guest_name,
        r.guest_surname,
        r.checkin_date,
        r.checkout_date,
          r.guest_unique_id,
        r.profile_photo,
        r.is_active,
        r.adult_count,
        r.child_count,
        r.country,
        r.agency,
        MAX(tra.assigned_at) as assigned_at,
        (
          SELECT m.message 
          FROM messages m 
          WHERE m.guest_unique_id = r.guest_unique_id
          ORDER BY m.timestamp DESC 
          LIMIT 1
        ) as last_message,
        (
          SELECT m.timestamp 
          FROM messages m 
          WHERE m.guest_unique_id = r.guest_unique_id
          ORDER BY m.timestamp DESC 
          LIMIT 1
        ) as last_message_time,
          (
            SELECT m.timestamp 
          FROM messages m 
          WHERE m.guest_unique_id = r.guest_unique_id
              AND m.sender_type = 'guest'
            ORDER BY m.timestamp DESC 
            LIMIT 1
          ) as last_guest_message_time,
        COALESCE((
          SELECT COUNT(*)::INTEGER
          FROM messages m 
          WHERE m.guest_unique_id = r.guest_unique_id
            AND m.sender_type NOT IN ('assistant', 'staff')
            AND m.read_at IS NULL
          ), 0) as unread_count
      FROM rooms r
      INNER JOIN team_room_assignments tra ON r.guest_unique_id = tra.guest_unique_id
      INNER JOIN assistant_teams at ON tra.team_id = at.team_id
      WHERE at.assistant_id = $1 
        AND at.is_active = true
        AND tra.is_active = true
        AND r.is_active = true
      GROUP BY 
        r.id,
        r.room_number,
        r.guest_name,
        r.guest_surname,
        r.checkin_date,
        r.checkout_date,
          r.guest_unique_id,
        r.profile_photo,
        r.is_active,
        r.adult_count,
        r.child_count,
        r.country,
        r.agency
      )
      SELECT 
        *,
        COALESCE(last_message_time, checkin_date) as sort_timestamp,
        -- Calculate expiry date: max of (checkout_date + 1 day) or (last_guest_message_time + 2 days)
        GREATEST(
          CASE 
            WHEN checkout_date IS NOT NULL 
            THEN (checkout_date + INTERVAL '1 day')::date
            ELSE NULL
          END,
          CASE 
            WHEN last_guest_message_time IS NOT NULL 
            THEN (last_guest_message_time::date + INTERVAL '2 days')::date
            ELSE NULL
          END
        ) as expiry_date
      FROM room_messages
      WHERE 
        -- Show if expiry_date >= today
        -- expiry_date is the maximum of (checkout_date + 1 day) and (last_guest_message_time + 2 days)
        GREATEST(
          CASE 
            WHEN checkout_date IS NOT NULL 
            THEN (checkout_date + INTERVAL '1 day')::date
            ELSE NULL
          END,
          CASE 
            WHEN last_guest_message_time IS NOT NULL 
            THEN (last_guest_message_time::date + INTERVAL '2 days')::date
            ELSE NULL
          END
        ) >= $2::date
      ORDER BY 
        last_message_time DESC NULLS LAST,
        room_number ASC
    `, [assistantId, todayStr]);
    
    console.log(`📋 Assistant ${assistantId} rooms (all active):`, result.rows.length);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Error fetching assistant rooms:', error);
    console.error('❌ Error details:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      hint: error.hint,
      position: error.position
    });
    res.status(500).json({ 
      error: 'Database error',
      message: error.message,
      detail: error.detail
    });
  }
});


// Initialize test data: 15 assistants, 5 teams (3 assistants each), 32 guests (4 per day for 8 days: Jan 3-10)
async function initializeTestData() {
  try {
    // Check if already initialized (optional - can be removed if you want to allow re-initialization)
    const existingAssistants = await pool.query('SELECT COUNT(*) as count FROM assistants');
    if (parseInt(existingAssistants.rows[0].count) >= 15) {
      console.log('ℹ️ Test data already exists. Use /api/test-data/initialize to re-initialize.');
      return;
    }
    
    console.log('🔄 Starting test data initialization...');
    
    // 15 Assistants with unique names and different languages
    const assistants = [
      { name: 'Ahmet', surname: 'Yıldız', spoken_languages: 'Türkçe, İngilizce, Almanca' },
      { name: 'Elif', surname: 'Kaya', spoken_languages: 'Türkçe, İngilizce, Fransızca' },
      { name: 'Mehmet', surname: 'Demir', spoken_languages: 'Türkçe, İngilizce, Rusça' },
      { name: 'Zeynep', surname: 'Şahin', spoken_languages: 'Türkçe, İngilizce, İspanyolca' },
      { name: 'Can', surname: 'Özkan', spoken_languages: 'Türkçe, İngilizce, İtalyanca' },
      { name: 'Lena', surname: 'Podorozhna', spoken_languages: 'Türkçe, İngilizce, Ukraynaca' },
      { name: 'Ayşe', surname: 'Çelik', spoken_languages: 'Türkçe, İngilizce, Arapça' },
      { name: 'Fatma', surname: 'Arslan', spoken_languages: 'Türkçe, İngilizce, Farsça' },
      { name: 'Mustafa', surname: 'Doğan', spoken_languages: 'Türkçe, İngilizce, Yunanca' },
      { name: 'Hatice', surname: 'Şimşek', spoken_languages: 'Türkçe, İngilizce, Bulgarca' },
      { name: 'İbrahim', surname: 'Yılmaz', spoken_languages: 'Türkçe, İngilizce, Romence' },
      { name: 'Zeliha', surname: 'Kurt', spoken_languages: 'Türkçe, İngilizce, Sırpça' },
      { name: 'Hasan', surname: 'Özdemir', spoken_languages: 'Türkçe, İngilizce, Hırvatça' },
      { name: 'Emine', surname: 'Aydın', spoken_languages: 'Türkçe, İngilizce, Macarca' },
      { name: 'Osman', surname: 'Koç', spoken_languages: 'Türkçe, İngilizce, Çekçe' }
    ];
    
    // Create assistants
    const assistantIds = [];
    for (const assistant of assistants) {
    const result = await pool.query(`
        INSERT INTO assistants (name, surname, spoken_languages, is_active)
        VALUES ($1, $2, $3, true)
        RETURNING id
      `, [assistant.name, assistant.surname, assistant.spoken_languages]);
      assistantIds.push(result.rows[0].id);
      console.log(`✅ Created assistant: ${assistant.name} ${assistant.surname} (ID: ${result.rows[0].id})`);
    }
    
    // Create 5 teams
    const teams = [
      { name: 'Reception Team', description: 'Front desk and guest services' },
      { name: 'Concierge Team', description: 'Guest assistance and recommendations' },
      { name: 'VIP Services Team', description: 'Premium guest services' },
      { name: 'Event Coordination Team', description: 'Event and activity management' },
      { name: 'Guest Relations Team', description: 'Guest satisfaction and feedback' }
    ];
    
    const teamIds = [];
    for (const team of teams) {
    const result = await pool.query(`
        INSERT INTO teams (name, description, is_active)
        VALUES ($1, $2, true)
        RETURNING id
      `, [team.name, team.description]);
      teamIds.push(result.rows[0].id);
      console.log(`✅ Created team: ${team.name} (ID: ${result.rows[0].id})`);
    }
    
    // Assign assistants to teams (3 assistants per team)
    // Team 1: assistants 0-2
    // Team 2: assistants 3-5
    // Team 3: assistants 6-8
    // Team 4: assistants 9-11
    // Team 5: assistants 12-14
    for (let teamIndex = 0; teamIndex < 5; teamIndex++) {
      for (let i = 0; i < 3; i++) {
        const assistantIndex = teamIndex * 3 + i;
        await pool.query(`
          INSERT INTO assistant_teams (assistant_id, team_id, is_active)
          VALUES ($1, $2, true)
        `, [assistantIds[assistantIndex], teamIds[teamIndex]]);
      }
      console.log(`✅ Assigned assistants ${teamIndex * 3}-${teamIndex * 3 + 2} to team ${teamIndex + 1}`);
    }
    
    // Guest names (different from assistant names)
    const guestFirstNames = [
      'Ali', 'Ayşe', 'Fatma', 'Mustafa', 'Hatice', 'İbrahim', 'Zeliha', 'Hasan', 'Emine', 'Osman',
      'John', 'Sarah', 'Michael', 'Emma', 'David', 'Olivia', 'James', 'Sophia', 'Robert', 'Isabella',
      'Thomas', 'Charlotte', 'Charles', 'Amelia', 'Joseph', 'Mia', 'Daniel', 'Harper', 'Matthew', 'Evelyn',
      'Mark', 'Abigail', 'Steven', 'Emily', 'Paul', 'Sofia', 'Andrew', 'Avery', 'Joshua', 'Ella',
      'Kenneth', 'Madison', 'Kevin', 'Scarlett', 'Brian', 'Victoria', 'George', 'Aria', 'Edward', 'Grace',
      'Henry', 'Lily', 'Jack', 'Chloe', 'Oliver', 'Zoe', 'Lucas', 'Nora', 'Alexander', 'Hannah',
      'Benjamin', 'Aubrey', 'Mason', 'Addison', 'Ethan', 'Eleanor', 'Logan', 'Natalie', 'Jackson', 'Luna',
      'Levi', 'Penelope', 'Sebastian', 'Riley', 'Mateo', 'Layla', 'Jack', 'Lillian', 'Owen', 'Aurora'
    ];
    
    const guestLastNames = [
      'Yılmaz', 'Demir', 'Kaya', 'Şahin', 'Özkan', 'Çelik', 'Arslan', 'Doğan', 'Şimşek', 'Yıldız',
      'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
      'Hernandez', 'Lopez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee',
      'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young',
      'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams',
      'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell', 'Carter', 'Roberts', 'Gomez', 'Phillips',
      'Evans', 'Turner', 'Diaz', 'Parker', 'Cruz', 'Edwards', 'Collins', 'Reyes', 'Stewart', 'Morris',
      'Rogers', 'Reed', 'Cook', 'Morgan', 'Bell', 'Murphy', 'Bailey', 'Rivera', 'Cooper', 'Richardson'
    ];
    
    const countries = [
      'Türkiye', 'Almanya', 'İngiltere', 'Fransa', 'İtalya', 'İspanya', 'Rusya', 'Ukrayna', 'Polonya', 'Hollanda',
      'Belçika', 'İsviçre', 'Avusturya', 'İsveç', 'Norveç', 'Danimarka', 'Finlandiya', 'Yunanistan', 'Bulgaristan', 'Romanya',
      'ABD', 'Kanada', 'Brezilya', 'Arjantin', 'Meksika', 'Japonya', 'Güney Kore', 'Çin', 'Hindistan', 'Avustralya'
    ];
    
    const agencies = [
      'Booking.com', 'Expedia', 'Agoda', 'Hotels.com', 'Trivago', 'Pegasus', 'Turkish Airlines', 'TUI', 'Thomas Cook', 'Jet2',
      'Onur Air', 'SunExpress', 'Corendon', 'Freebird', 'Atlasjet', 'Direct Booking', 'Travel Agency', 'Tour Operator', 'Corporate', 'Group Booking'
    ];
    
    // Room numbers (301-400)
    const roomNumbers = Array.from({ length: 100 }, (_, i) => String(301 + i));
    
    // Generate guests for next 15 days (5 per day = 75 total)
    const today = new Date();
    const inserts = [];
    let usedNames = new Set(); // Track used name combinations
    
    for (let day = 0; day < 15; day++) {
      const checkinDate = new Date(today);
      checkinDate.setDate(today.getDate() + day);
      const checkinDateStr = checkinDate.toISOString().split('T')[0];
      
      // 5 guests per day
      for (let i = 0; i < 5; i++) {
        let firstName, lastName, nameKey;
        // Ensure unique name combination
        do {
          firstName = guestFirstNames[Math.floor(Math.random() * guestFirstNames.length)];
          lastName = guestLastNames[Math.floor(Math.random() * guestLastNames.length)];
          nameKey = `${firstName}_${lastName}`;
        } while (usedNames.has(nameKey));
        usedNames.add(nameKey);
        
        const roomNumber = roomNumbers[Math.floor(Math.random() * roomNumbers.length)];
        const adultCount = Math.floor(Math.random() * 3) + 1; // 1-3 adults
        const childCount = Math.random() > 0.6 ? Math.floor(Math.random() * 3) : 0; // 40% chance of children
        const country = countries[Math.floor(Math.random() * countries.length)];
        const agency = agencies[Math.floor(Math.random() * agencies.length)];
        
        // Checkout date (1-7 days after checkin)
        const checkoutDate = new Date(checkinDate);
        checkoutDate.setDate(checkinDate.getDate() + Math.floor(Math.random() * 7) + 1);
        const checkoutDateStr = checkoutDate.toISOString().split('T')[0];
        
        const guest_unique_id = generateGuestUniqueId(firstName, lastName, checkinDateStr, checkoutDateStr);
        
        inserts.push({
            roomNumber,
            firstName,
            lastName,
            checkinDateStr,
            checkoutDateStr,
            adultCount,
            childCount,
            agency,
          country,
          guest_unique_id
        });
      }
    }
    
    // Batch insert rooms
    const chunkSize = 50;
    let totalInserted = 0;
    
    for (let i = 0; i < inserts.length; i += chunkSize) {
      const chunk = inserts.slice(i, i + chunkSize);
      
      const values = chunk.map((_, idx) => {
        const base = idx * 10;
        return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8}, $${base+9}, $${base+10}, true)`;
      }).join(', ');
      
      const params = chunk.flatMap(ins => [
        ins.roomNumber, ins.firstName, ins.lastName, ins.checkinDateStr,
        ins.checkoutDateStr, ins.guest_unique_id, ins.adultCount, ins.childCount, ins.agency, ins.country
      ]);
      
      try {
        const result = await pool.query(`
          INSERT INTO rooms (
            room_number, guest_name, guest_surname, checkin_date, 
            checkout_date, guest_unique_id, adult_count, child_count, agency, country, is_active
          )
          VALUES ${values}
          ON CONFLICT (guest_unique_id) DO NOTHING
        `, params);
        
        totalInserted += result.rowCount || 0;
        } catch (error) {
        console.error(`⚠️ Error inserting chunk ${i / chunkSize + 1}:`, error.message);
      }
    }
    
    // Assign rooms to teams (distribute evenly across 5 teams)
    const roomsResult = await pool.query(`
      SELECT guest_unique_id FROM rooms 
      WHERE checkin_date >= '2026-01-03'::date
        AND checkin_date <= '2026-01-10'::date
      ORDER BY checkin_date, guest_unique_id
    `);
    
    for (let i = 0; i < roomsResult.rows.length; i++) {
      const teamId = teamIds[i % 5]; // Distribute across 5 teams
      await pool.query(`
        INSERT INTO team_room_assignments (team_id, guest_unique_id, is_active)
        VALUES ($1, $2, true)
        ON CONFLICT (team_id, guest_unique_id) DO NOTHING
      `, [teamId, roomsResult.rows[i].guest_unique_id]);
    }
    
    console.log(`✅ Test data initialization completed:`);
    console.log(`   - ${assistantIds.length} assistants created`);
    console.log(`   - ${teamIds.length} teams created (3 assistants each)`);
    console.log(`   - ${totalInserted} guests created (4 per day for Jan 3-10, 2026)`);
    console.log(`   - Rooms assigned to teams`);
  } catch (error) {
    console.error('❌ Error initializing test data:', error);
  }
}

// Initialize database and start server
// Initialize database and start server
const serverStartTime = Date.now(); // Track server startup time
const PORT = process.env.PORT || 3000;

console.log('');
console.log('🚀 [STARTUP] Starting Voyage Sorgun Chat Server...');
console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`   Node version: ${process.version}`);
console.log(`   Started at: ${new Date().toISOString()}`);
console.log('');

initializeDatabase()
  .then(() => {
    const dbInitTime = ((Date.now() - serverStartTime) / 1000).toFixed(3);
    console.log('');
    console.log('📊 [STEP 2/3] Database initialization completed');
    console.log(`   ⏱️  Database init time: ${dbInitTime}s`);
    console.log('');
    console.log('📊 [STEP 3/3] Starting HTTP server...');
    
    // Start HTTP server after database is initialized
    httpServer.listen(PORT, () => {
      const totalStartupTime = ((Date.now() - serverStartTime) / 1000).toFixed(2);
      console.log(`\n✅ Server running on port ${PORT} (${totalStartupTime}s)`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
    });
  })
  .catch((error) => {
    console.error('');
    console.error('❌ [FATAL] Failed to initialize database');
    console.error(`   Error: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    console.error('');
    process.exit(1);
  });

// Health check

// Get database status
app.get('/api/test-data/status', async (req, res) => {
  try {
    const assistants = await pool.query('SELECT COUNT(*) as count FROM assistants');
    const teams = await pool.query('SELECT COUNT(*) as count FROM teams');
    const guests = await pool.query('SELECT COUNT(*) as count FROM rooms WHERE is_active = true');
    const messages = await pool.query('SELECT COUNT(*) as count FROM messages');
    const assignments = await pool.query('SELECT COUNT(*) as count FROM team_room_assignments WHERE is_active = true');
    
    res.json({
      success: true,
      counts: {
        assistants: parseInt(assistants.rows[0].count),
        teams: parseInt(teams.rows[0].count),
        guests: parseInt(guests.rows[0].count),
        messages: parseInt(messages.rows[0].count),
        assignments: parseInt(assignments.rows[0].count)
      }
    });
  } catch (error) {
    console.error('Error getting database status:', error);
    res.status(500).json({ error: 'Database error', message: error.message });
  }
});

// Test data initialization endpoint (manual trigger)
app.post('/api/test-data/initialize', async (req, res) => {
  try {
    console.log('🔄 Manual test data initialization triggered...');
    await initializeTestData();
    res.json({ success: true, message: 'Test data initialized successfully' });
  } catch (error) {
    console.error('❌ Error initializing test data:', error);
    res.status(500).json({ error: 'Failed to initialize test data', message: error.message });
  }
});

// Clear all test data (optional - for reset)
app.post('/api/test-data/clear', async (req, res) => {
  try {
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM team_room_assignments');
    await pool.query('DELETE FROM assistant_assignments');
    await pool.query('DELETE FROM assistant_teams');
    await pool.query('DELETE FROM rooms');
    await pool.query('DELETE FROM assistants');
    await pool.query('DELETE FROM teams');
    
    res.json({ success: true, message: 'Tüm test verileri temizlendi' });
  } catch (error) {
    console.error('Error clearing test data:', error);
    res.status(500).json({ error: 'Failed to clear test data', message: error.message });
  }
});

// Migration endpoint: Update all existing guests with new guest_unique_id algorithm
app.post('/api/migrate/update-guest-unique-ids', async (req, res) => {
  try {
    logInfo('🔄 Starting migration: Updating guest_unique_id for all guests...');
    
    // Get all rooms that need guest_unique_id update
    const rooms = await pool.query(`
      SELECT id, room_number, guest_name, guest_surname, checkin_date, checkout_date, guest_unique_id
      FROM rooms
      WHERE is_active = true
      ORDER BY id
    `);
    
    let updated = 0;
    let skipped = 0;
    
    for (const room of rooms.rows) {
      // Generate new guest_unique_id with checkout_date included
      const newGuestUniqueId = generateGuestUniqueId(
        room.guest_name,
        room.guest_surname,
        room.checkin_date,
        room.checkout_date
      );
      
      if (!newGuestUniqueId) {
        logDebug(`⚠️ Skipping room ${room.id}: Cannot generate guest_unique_id`);
        skipped++;
        continue;
      }
      
      // Update if different or null
      if (!room.guest_unique_id || room.guest_unique_id !== newGuestUniqueId) {
        await pool.query(
          'UPDATE rooms SET guest_unique_id = $1 WHERE id = $2',
          [newGuestUniqueId, room.id]
        );
        updated++;
        logDebug(`✅ Updated room ${room.id}: ${newGuestUniqueId}`);
      } else {
        skipped++;
      }
    }
    
    logInfo(`✅ Migration completed: ${updated} updated, ${skipped} skipped`);
    res.json({ 
      success: true, 
      updated, 
      skipped, 
      total: rooms.rows.length 
    });
  } catch (error) {
    console.error('❌ Migration error:', error);
    res.status(500).json({ error: 'Migration failed', details: error.message });
  }
});

// Cache health check result for 5 seconds to avoid excessive DB queries
let healthCheckCache = { status: 'ok', timestamp: Date.now() };
const HEALTH_CHECK_CACHE_TTL = 5000; // 5 seconds

app.get('/health', async (req, res) => {
  try {
    // Return cached result if recent
    const now = Date.now();
    if (healthCheckCache.timestamp && (now - healthCheckCache.timestamp) < HEALTH_CHECK_CACHE_TTL) {
      return res.json(healthCheckCache);
    }
    
    // Quick database connection test with timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Database check timeout')), 2000)
    );
    
    await Promise.race([
      pool.query('SELECT 1'),
      timeoutPromise
    ]);
    
    healthCheckCache = {
      status: 'ok',
      timestamp: now,
      database: 'connected',
      websocket: 'active'
    };
    
    res.json(healthCheckCache);
  } catch (error) {
    healthCheckCache = {
      status: 'error',
      timestamp: Date.now(),
      database: 'disconnected',
      error: error.message
    };
    res.status(503).json(healthCheckCache);
  }
});

// Serve frontend pages

// Ana sayfa - Landing page (chat yok)
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'landing.html'));
});

// Token doğrulaması ile chat sayfası
app.get('/invite/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    // Token'ı doğrula
    const result = await pool.query(`
      SELECT 
        ri.invite_token,
        ri.room_number,
        ri.expires_at,
        ri.is_active
      FROM room_invites ri
      WHERE ri.invite_token = $1 AND ri.is_active = true
    `, [token]);
    
    if (result.rows.length === 0) {
      // Geçersiz token - hata sayfası
      return res.status(404).sendFile(join(__dirname, 'public', 'invalid-token.html'));
    }
    
    const invite = result.rows[0];
    
    // Token süresi dolmuş mu kontrol et
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return res.status(410).sendFile(join(__dirname, 'public', 'expired-token.html'));
    }
    
    // Geçerli token - chat sayfasını göster (token URL parametresi ile)
    res.redirect(`/join?token=${token}`);
  } catch (error) {
    console.error('Error validating token:', error);
    res.status(500).sendFile(join(__dirname, 'public', 'invalid-token.html'));
  }
});

// /join route'unda token kontrolü
app.get('/join', (req, res) => {
  const token = req.query.token;
  
  // Token yoksa hata sayfası
  if (!token) {
    return res.status(400).sendFile(join(__dirname, 'public', 'invalid-token.html'));
  }
  
  // Chat sayfasını göster (index.html kullanıyoruz)
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/assistant', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'assistant.html'));
});

app.get('/settings', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'settings.html'));
});

app.get('/assistant.html', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'assistant.html'));
});

// Join team page (for QR code scanning)
app.get('/join-team', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Hata - Takım Daveti</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f2f5; }
          .error { background: white; padding: 30px; border-radius: 12px; max-width: 500px; margin: 0 auto; }
          h1 { color: #dc3545; }
          a { color: #008069; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="error">
          <h1>❌ Geçersiz Davet</h1>
          <p>Token bulunamadı. Lütfen geçerli bir QR kod kullanın.</p>
          <a href="/assistant">Assistant Dashboard'a Dön</a>
        </div>
      </body>
      </html>
    `);
  }
  
  // Redirect to assistant page with token
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Takıma Katıl</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f2f5; }
        .container { background: white; padding: 30px; border-radius: 12px; max-width: 500px; margin: 0 auto; }
        h1 { color: #008069; }
        .loading { margin: 20px 0; }
        .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #008069; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Takıma Katılıyorsunuz...</h1>
        <div class="loading">
          <div class="spinner"></div>
        </div>
        <p>Lütfen bekleyin...</p>
      </div>
      <script>
        (function() {
          // Get assistant ID from localStorage or prompt
          let assistantId = localStorage.getItem('assistant_id');
          if (!assistantId) {
            assistantId = prompt("Assistant ID'nizi girin:");
            if (assistantId) {
              localStorage.setItem('assistant_id', assistantId);
            } else {
              alert('Assistant ID gereklidir!');
              window.location.href = '/assistant';
              return;
            }
          }
          
          // Join team
          fetch('/api/teams/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token: '${token}',
              assistant_id: parseInt(assistantId)
            })
          })
          .then(res => res.json())
          .then(data => {
            if (data.success) {
              alert(data.message || 'Takıma başarıyla katıldınız!');
              window.location.href = '/assistant';
            } else {
              alert('Hata: ' + (data.error || 'Bilinmeyen hata'));
              window.location.href = '/assistant';
            }
          })
          .catch(error => {
            console.error('Error:', error);
            alert('Bir hata oluştu. Lütfen tekrar deneyin.');
            window.location.href = '/assistant';
          });
        })();
      </script>
    </body>
    </html>
  `);
});

// ============================================================================
// RESTAURANT RESERVATIONS API ENDPOINTS
// ============================================================================

// Get all restaurants (admin)
app.get('/admin/restaurants', async (req, res) => {
  try {
    console.log('GET /admin/restaurants - Fetching restaurants...');
    const result = await pool.query(`
      SELECT 
        id, name, description, photos, active, 
        opening_hour, closing_hour, price_per_person, currency, rules_json,
        created_at, updated_at
      FROM restaurants
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
    `);
    
    console.log('Raw database rows:', result.rows.length);
    
    const restaurants = result.rows.map(row => {
      let photos = [];
      let rules_json = {};
      
      // Parse photos
      if (row.photos) {
        if (Array.isArray(row.photos)) {
          photos = row.photos;
        } else if (typeof row.photos === 'string') {
          try {
            photos = JSON.parse(row.photos);
          } catch (e) {
            console.warn('Error parsing photos:', e);
            photos = [];
          }
        } else {
          photos = row.photos;
        }
      }
      
      // Parse rules_json
      if (row.rules_json) {
        if (typeof row.rules_json === 'object') {
          rules_json = row.rules_json;
        } else if (typeof row.rules_json === 'string') {
          try {
            rules_json = JSON.parse(row.rules_json);
          } catch (e) {
            console.warn('Error parsing rules_json:', e);
            rules_json = {};
          }
        }
      }
      
      return {
        ...row,
        photos,
        rules_json
      };
    });
    
    console.log('Sending restaurants:', restaurants.length);
    res.json({ success: true, data: restaurants });
  } catch (error) {
    console.error('Error fetching restaurants:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ success: false, error: 'Database error: ' + error.message });
  }
});

// Get single restaurant (admin)
app.get('/admin/restaurants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT 
        id, name, description, photos, active, 
        opening_hour, closing_hour, price_per_person, currency, rules_json,
        created_at, updated_at
      FROM restaurants
      WHERE id = $1 AND deleted_at IS NULL
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }
    
    const restaurant = result.rows[0];
    
    // 🔍 DEBUG: PostgreSQL'den gelen RAW veriyi logla
    console.log('🔍 Raw restaurant from DB:', restaurant);
    console.log('🕐 opening_hour:', restaurant.opening_hour);
    console.log('🕐 closing_hour:', restaurant.closing_hour);
    console.log('🔑 All keys:', Object.keys(restaurant));
    
    restaurant.photos = Array.isArray(restaurant.photos) ? restaurant.photos : (restaurant.photos ? JSON.parse(restaurant.photos) : []);
    restaurant.rules_json = typeof restaurant.rules_json === 'object' ? restaurant.rules_json : (restaurant.rules_json ? JSON.parse(restaurant.rules_json) : {});
    
    console.log('⚡ ABOUT TO SEND RESPONSE:', JSON.stringify(restaurant, null, 2));
    
    res.json({ success: true, data: restaurant });
  } catch (error) {
    console.error('Error fetching restaurant:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Create restaurant (admin)
app.post('/admin/restaurants', async (req, res) => {
  try {
    console.log('POST /admin/restaurants - Request body:', req.body);
    const { name, description, photos, active, opening_hour, closing_hour, price_per_person, currency, rules_json } = req.body;
    
    if (!name || !price_per_person) {
      console.log('Validation failed: name or price_per_person missing');
      return res.status(400).json({ success: false, error: 'Name and price_per_person are required' });
    }
    
    // Prepare photos (ensure it's JSONB compatible)
    let photosJson = '[]';
    if (photos) {
      if (Array.isArray(photos)) {
        photosJson = JSON.stringify(photos);
      } else if (typeof photos === 'string') {
        try {
          // Try to parse if it's a JSON string
          JSON.parse(photos);
          photosJson = photos;
        } catch (e) {
          // If not JSON, treat as single URL
          photosJson = JSON.stringify([photos]);
        }
      }
    }
    
    // Prepare rules_json (ensure it's JSONB compatible)
    let rulesJson = '{}';
    if (rules_json) {
      if (typeof rules_json === 'object') {
        rulesJson = JSON.stringify(rules_json);
      } else if (typeof rules_json === 'string') {
        rulesJson = rules_json;
      }
    }
    
    // Check if restaurants table exists
    try {
      const tableCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'restaurants'
        );
      `);
      
      if (!tableCheck.rows[0].exists) {
        console.error('Restaurants table does not exist. Please run the schema migration.');
        return res.status(500).json({ 
          success: false, 
          error: 'Restaurants table does not exist. Please run the database schema migration.' 
        });
      }
    } catch (tableError) {
      console.error('Error checking restaurants table:', tableError);
      return res.status(500).json({ 
        success: false, 
        error: 'Database error: ' + tableError.message 
      });
    }
    
    const result = await pool.query(`
      INSERT INTO restaurants (name, description, photos, active, opening_hour, closing_hour, price_per_person, currency, rules_json)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING 
        id, name, description, photos, active, 
        opening_hour, closing_hour, price_per_person, currency, rules_json,
        created_at, updated_at
    `, [
      name.trim(),
      description || null,
      photosJson,
      active !== undefined ? active : true,
      opening_hour || null,
      closing_hour || null,
      parseFloat(price_per_person),
      currency || 'TRY',
      rulesJson
    ]);
    
    const restaurant = result.rows[0];
    console.log('Restaurant created:', restaurant);
    
    restaurant.photos = Array.isArray(restaurant.photos) ? restaurant.photos : (restaurant.photos ? JSON.parse(restaurant.photos) : []);
    restaurant.rules_json = typeof restaurant.rules_json === 'object' ? restaurant.rules_json : (restaurant.rules_json ? JSON.parse(restaurant.rules_json) : {});
    
    console.log('Sending response:', { success: true, data: restaurant });
    res.status(201).json({ success: true, data: restaurant });
  } catch (error) {
    console.error('Error creating restaurant:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ success: false, error: 'Database error: ' + error.message });
  }
});

// Update restaurant (admin)
app.put('/admin/restaurants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, photos, active, opening_hour, closing_hour, price_per_person, currency, rules_json } = req.body;
    
    // Check if restaurant exists
    const checkResult = await pool.query(`
      SELECT id FROM restaurants WHERE id = $1 AND deleted_at IS NULL
    `, [id]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }
    
    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name.trim());
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description || null);
    }
    if (photos !== undefined) {
      let photosJson = '[]';
      if (Array.isArray(photos)) {
        photosJson = JSON.stringify(photos);
      } else if (typeof photos === 'string') {
        try {
          JSON.parse(photos);
          photosJson = photos;
        } catch (e) {
          photosJson = JSON.stringify([photos]);
        }
      }
      updates.push(`photos = $${paramCount++}::jsonb`);
      values.push(photosJson);
    }
    if (active !== undefined) {
      updates.push(`active = $${paramCount++}`);
      values.push(active);
    }
    if (opening_hour !== undefined) {
      updates.push(`opening_hour = $${paramCount++}`);
      values.push(opening_hour || null);
    }
    if (closing_hour !== undefined) {
      updates.push(`closing_hour = $${paramCount++}`);
      values.push(closing_hour || null);
    }
    if (price_per_person !== undefined) {
      updates.push(`price_per_person = $${paramCount++}`);
      values.push(parseFloat(price_per_person));
    }
    if (currency !== undefined) {
      updates.push(`currency = $${paramCount++}`);
      values.push(currency);
    }
    if (rules_json !== undefined) {
      let rulesJson = '{}';
      if (typeof rules_json === 'object') {
        rulesJson = JSON.stringify(rules_json);
      } else if (typeof rules_json === 'string') {
        rulesJson = rules_json;
      }
      updates.push(`rules_json = $${paramCount++}::jsonb`);
      values.push(rulesJson);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    
    // Add updated_at
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    
    const result = await pool.query(`
      UPDATE restaurants
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING 
        id, name, description, photos, active, 
        opening_hour, closing_hour, price_per_person, currency, rules_json,
        created_at, updated_at
    `, values);
    
    const restaurant = result.rows[0];
    restaurant.photos = Array.isArray(restaurant.photos) ? restaurant.photos : (restaurant.photos ? JSON.parse(restaurant.photos) : []);
    restaurant.rules_json = typeof restaurant.rules_json === 'object' ? restaurant.rules_json : (restaurant.rules_json ? JSON.parse(restaurant.rules_json) : {});
    
    res.json({ success: true, data: restaurant });
  } catch (error) {
    console.error('Error updating restaurant:', error);
    res.status(500).json({ success: false, error: 'Database error: ' + error.message });
  }
});

// Delete restaurant (admin) - Soft delete
app.delete('/admin/restaurants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      UPDATE restaurants
      SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }
    
    res.json({ success: true, message: 'Restaurant deleted successfully' });
  } catch (error) {
    console.error('Error deleting restaurant:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ============================================================================
// RESTAURANT RESERVATIONS API ENDPOINTS (GUEST)
// ============================================================================

// Get available restaurants for today (guest)
app.get('/restaurants', async (req, res) => {
  try {
    const today = new Date();
    const dayOfWeek = today.getDay() || 7; // Convert Sunday (0) to 7 for Monday=1 format
    
    const result = await pool.query(`
      SELECT 
        r.id, r.name, r.description, r.photos, r.active,
        r.opening_hour, r.closing_hour, r.price_per_person, r.currency, r.rules_json
      FROM restaurants r
      WHERE r.deleted_at IS NULL
        AND r.active = true
        AND (
          r.rules_json->>'working_weekdays' IS NULL
          OR (
            r.rules_json->>'working_weekdays' IS NOT NULL
            AND ($1::int = ANY(
              SELECT jsonb_array_elements_text(r.rules_json->'working_weekdays')::int
            ))
          )
        )
      ORDER BY r.name ASC
    `, [dayOfWeek]);
    
    const restaurants = result.rows.map(row => {
      let photos = [];
      if (row.photos) {
        if (Array.isArray(row.photos)) {
          photos = row.photos;
        } else if (typeof row.photos === 'string') {
          try {
            photos = JSON.parse(row.photos);
          } catch (e) {
            photos = [];
          }
        }
      }
      
      let rules_json = {};
      if (row.rules_json) {
        if (typeof row.rules_json === 'object') {
          rules_json = row.rules_json;
        } else if (typeof row.rules_json === 'string') {
          try {
            rules_json = JSON.parse(row.rules_json);
          } catch (e) {
            rules_json = {};
          }
        }
      }
      
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        photos,
        opening_hour: row.opening_hour,
        closing_hour: row.closing_hour,
        price_per_person: parseFloat(row.price_per_person),
        currency: row.currency,
        rules_json
      };
    });
    
    res.json({ success: true, data: restaurants });
  } catch (error) {
    console.error('Error fetching restaurants:', error);
    res.status(500).json({ success: false, error: 'Database error: ' + error.message });
  }
});

// Create restaurant reservation (guest)
app.post('/reservations', async (req, res) => {
  try {
    const { restaurant_id, guest_unique_id, reservation_date, pax_adult, pax_child, special_requests } = req.body;
    
    if (!restaurant_id || !guest_unique_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'restaurant_id and guest_unique_id are required' 
      });
    }
    
    // Get guest info to determine adult/child count if not provided
    let adultCount = pax_adult;
    let childCount = pax_child || 0;
    
    if (!adultCount || !childCount) {
      const guestResult = await pool.query(`
        SELECT adult_count, child_count
        FROM rooms
        WHERE guest_unique_id = $1
      `, [guest_unique_id]);
      
      if (guestResult.rows.length > 0) {
        adultCount = adultCount || guestResult.rows[0].adult_count || 1;
        childCount = childCount || guestResult.rows[0].child_count || 0;
      } else {
        adultCount = adultCount || 1;
        childCount = childCount || 0;
      }
    }
    
    // Get restaurant info
    const restaurantResult = await pool.query(`
      SELECT id, name, price_per_person, currency, rules_json
      FROM restaurants
      WHERE id = $1 AND deleted_at IS NULL AND active = true
    `, [restaurant_id]);
    
    if (restaurantResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Restaurant not found or not available' });
    }
    
    const restaurant = restaurantResult.rows[0];
    let rules_json = {};
    if (restaurant.rules_json) {
      if (typeof restaurant.rules_json === 'object') {
        rules_json = restaurant.rules_json;
      } else if (typeof restaurant.rules_json === 'string') {
        try {
          rules_json = JSON.parse(restaurant.rules_json);
        } catch (e) {
          rules_json = {};
        }
      }
    }
    
    // Calculate price based on child pricing policy
    const pricePerPerson = parseFloat(restaurant.price_per_person);
    let totalPrice = pricePerPerson * adultCount;
    
    const childPolicy = rules_json.child_pricing_policy || 'free_under_12';
    if (childPolicy === 'free_under_12') {
      // Children are free
      totalPrice = pricePerPerson * adultCount;
    } else if (childPolicy === 'half_price') {
      totalPrice = (pricePerPerson * adultCount) + (pricePerPerson * 0.5 * childCount);
    } else {
      // full_price
      totalPrice = pricePerPerson * (adultCount + childCount);
    }
    
    // Use today's date if not provided
    const resDate = reservation_date || new Date().toISOString().split('T')[0];
    
    // Check for duplicate reservation (same restaurant, same guest, same date)
    const existingCheck = await pool.query(`
      SELECT id
      FROM restaurant_reservations
      WHERE restaurant_id = $1 
        AND guest_unique_id = $2 
        AND reservation_date = $3
        AND status != 'cancelled'
    `, [restaurant_id, guest_unique_id, resDate]);
    
    if (existingCheck.rows.length > 0) {
      return res.status(409).json({ 
        success: false, 
        error: 'You already have a reservation at this restaurant for this date',
        code: 'DUPLICATE_RESERVATION'
      });
    }
    
    // Check max reservations per room per day
    const maxPerDay = rules_json.max_reservation_per_room_per_day;
    if (maxPerDay) {
      const todayReservations = await pool.query(`
        SELECT COUNT(*) as count
        FROM restaurant_reservations
        WHERE guest_unique_id = $1
          AND reservation_date = $2
          AND status != 'cancelled'
      `, [guest_unique_id, resDate]);
      
      if (parseInt(todayReservations.rows[0].count) >= maxPerDay) {
        return res.status(400).json({ 
          success: false, 
          error: `Maximum ${maxPerDay} reservation(s) per day allowed`,
          code: 'LIMIT_EXCEEDED'
        });
      }
    }
    
    // Create reservation
    const result = await pool.query(`
      INSERT INTO restaurant_reservations (
        restaurant_id, guest_unique_id, reservation_date,
        pax_adult, pax_child, total_price, currency, status, special_requests
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8)
      RETURNING 
        id, restaurant_id, guest_unique_id, reservation_date,
        pax_adult, pax_child, total_price, currency, status,
        special_requests, created_at
    `, [
      restaurant_id,
      guest_unique_id,
      resDate,
      adultCount,
      childCount,
      totalPrice,
      restaurant.currency,
      special_requests || null
    ]);
    
    const reservation = result.rows[0];
    
    // Get restaurant name for response
    res.json({
      success: true,
      data: {
        id: reservation.id,
        restaurant: {
          id: restaurant.id,
          name: restaurant.name
        },
        reservation_date: reservation.reservation_date,
        pax_adult: parseInt(reservation.pax_adult),
        pax_child: parseInt(reservation.pax_child),
        total_pax: parseInt(reservation.pax_adult) + parseInt(reservation.pax_child),
        total_price: parseFloat(reservation.total_price),
        currency: reservation.currency,
        status: reservation.status,
        special_requests: reservation.special_requests,
        created_at: reservation.created_at
      }
    });
  } catch (error) {
    console.error('Error creating reservation:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ success: false, error: 'Database error: ' + error.message });
  }
});

// Get guest reservations
app.get('/reservations', async (req, res) => {
  try {
    const { guest_unique_id } = req.query;
    
    if (!guest_unique_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'guest_unique_id query parameter is required' 
      });
    }
    
    // Check if restaurant_reservations table exists
    let tableExists = false;
    try {
      const tableCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'restaurant_reservations'
        );
      `);
      tableExists = tableCheck.rows[0].exists;
    } catch (checkError) {
      console.error('Error checking restaurant_reservations table:', checkError);
      // Continue anyway - will catch error in query
    }
    
    if (!tableExists) {
      // Table doesn't exist yet, return empty array (not an error)
      console.log('restaurant_reservations table does not exist yet, returning empty array');
      return res.json({ success: true, data: [] });
    }
    
    // Try to get reservations with LEFT JOIN (safer if restaurants table missing)
    let result;
    try {
      // First check if restaurants table exists
      const restaurantsTableCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'restaurants'
        );
      `);
      
      const restaurantsTableExists = restaurantsTableCheck.rows[0].exists;
      
      if (restaurantsTableExists) {
        // Use LEFT JOIN if restaurants table exists (exclude soft-deleted restaurants)
        result = await pool.query(`
          SELECT 
            rr.id,
            rr.restaurant_id,
            rr.reservation_date,
            rr.pax_adult,
            rr.pax_child,
            rr.total_price,
            rr.currency,
            rr.status,
            rr.special_requests,
            rr.created_at,
            r.name as restaurant_name,
            r.photos as restaurant_photos
          FROM restaurant_reservations rr
          LEFT JOIN restaurants r ON r.id = rr.restaurant_id AND r.deleted_at IS NULL
          WHERE rr.guest_unique_id = $1
            AND (rr.status IS NULL OR rr.status != 'cancelled')
          ORDER BY rr.reservation_date DESC, rr.created_at DESC
        `, [guest_unique_id]);
        
        console.log(`Query returned ${result.rows.length} rows for guest_unique_id: ${guest_unique_id}`);
      } else {
        // Query without JOIN if restaurants table doesn't exist
        console.log('restaurants table does not exist, querying without JOIN');
        result = await pool.query(`
          SELECT 
            id,
            restaurant_id,
            reservation_date,
            pax_adult,
            pax_child,
            total_price,
            currency,
            status,
            special_requests,
            created_at
          FROM restaurant_reservations
          WHERE guest_unique_id = $1
            AND status != 'cancelled'
          ORDER BY reservation_date DESC, created_at DESC
        `, [guest_unique_id]);
        
        // Map results without restaurant info
        const reservations = result.rows.map(row => ({
          id: row.id,
          restaurant: {
            id: row.restaurant_id,
            name: 'Restoran',
            photos: []
          },
          reservation_date: row.reservation_date,
          pax_adult: parseInt(row.pax_adult),
          pax_child: parseInt(row.pax_child),
          total_pax: parseInt(row.pax_adult) + parseInt(row.pax_child),
          total_price: parseFloat(row.total_price),
          currency: row.currency,
          status: row.status,
          special_requests: row.special_requests,
          created_at: row.created_at
        }));
        
        return res.json({ success: true, data: reservations });
      }
    } catch (queryError) {
      console.error('Error querying restaurant_reservations:', queryError);
      console.error('Error stack:', queryError.stack);
      // Re-throw to be caught by outer catch block
      throw queryError;
    }
    
    console.log(`Found ${result.rows.length} reservations for guest_unique_id: ${guest_unique_id}`);
    
    // Map results (handle null restaurant_name from LEFT JOIN)
    const reservations = result.rows.map(row => {
      console.log('Processing reservation row:', {
        id: row.id,
        restaurant_id: row.restaurant_id,
        restaurant_name: row.restaurant_name,
        status: row.status,
        reservation_date: row.reservation_date
      });
      let photos = [];
      if (row.restaurant_photos) {
        if (Array.isArray(row.restaurant_photos)) {
          photos = row.restaurant_photos;
        } else if (typeof row.restaurant_photos === 'string') {
          try {
            photos = JSON.parse(row.restaurant_photos);
          } catch (e) {
            photos = [];
          }
        }
      }
      
      return {
        id: row.id,
        restaurant: {
          id: row.restaurant_id,
          name: row.restaurant_name || 'Restoran',
          photos
        },
        reservation_date: row.reservation_date,
        pax_adult: parseInt(row.pax_adult),
        pax_child: parseInt(row.pax_child),
        total_pax: parseInt(row.pax_adult) + parseInt(row.pax_child),
        total_price: parseFloat(row.total_price),
        currency: row.currency,
        status: row.status,
        special_requests: row.special_requests,
        created_at: row.created_at
      };
    });
    
    res.json({ success: true, data: reservations });
  } catch (error) {
    console.error('Error fetching reservations:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: 'Database error: ' + error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Cancel reservation (guest)
app.delete('/reservations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { guest_unique_id } = req.query;
    
    if (!guest_unique_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'guest_unique_id query parameter is required' 
      });
    }
    
    // Check if reservation exists and belongs to guest
    const checkResult = await pool.query(`
      SELECT rr.id, rr.reservation_date, r.rules_json
      FROM restaurant_reservations rr
      INNER JOIN restaurants r ON r.id = rr.restaurant_id
      WHERE rr.id = $1 AND rr.guest_unique_id = $2 AND rr.status != 'cancelled'
    `, [id, guest_unique_id]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Reservation not found or already cancelled' 
      });
    }
    
    const reservation = checkResult.rows[0];
    let rules_json = {};
    if (reservation.rules_json) {
      if (typeof reservation.rules_json === 'object') {
        rules_json = reservation.rules_json;
      } else if (typeof reservation.rules_json === 'string') {
        try {
          rules_json = JSON.parse(reservation.rules_json);
        } catch (e) {
          rules_json = {};
        }
      }
    }
    
    // Check cancellation deadline
    const cancellationDeadline = rules_json.cancellation_deadline_minutes || 240; // default 4 hours
    const reservationDateTime = new Date(reservation.reservation_date);
    const now = new Date();
    const deadline = new Date(reservationDateTime.getTime() - (cancellationDeadline * 60 * 1000));
    
    if (now > deadline) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cancellation deadline has passed',
        code: 'CANCELLATION_DEADLINE_PASSED',
        deadline: deadline.toISOString()
      });
    }
    
    // Cancel reservation
    const result = await pool.query(`
      UPDATE restaurant_reservations
      SET status = 'cancelled', 
          cancelled_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, status, cancelled_at
    `, [id]);
    
    res.json({ 
      success: true, 
      data: {
        id: result.rows[0].id,
        status: result.rows[0].status,
        cancelled_at: result.rows[0].cancelled_at
      }
    });
  } catch (error) {
    console.error('Error cancelling reservation:', error);
    res.status(500).json({ success: false, error: 'Database error: ' + error.message });
  }
});

// ============================================================================
// SPA BOOKING API ENDPOINTS
// ============================================================================

// Get all SPA services
app.get('/api/spa/services', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, name, duration_min, price, currency, category, 
        short_description, description, is_active, display_order
      FROM spa_services
      WHERE is_active = true
      ORDER BY display_order ASC, name ASC
    `);
    
    const services = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      durationMin: row.duration_min,
      price: parseFloat(row.price),
      currency: row.currency,
      category: row.category || null,
      shortDescription: row.short_description || null
    }));
    
    res.json(services);
  } catch (error) {
    console.error('Error fetching SPA services:', error);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

// Get SPA availability for date range
app.get('/api/spa/availability', async (req, res) => {
  try {
    const { serviceId, from, to } = req.query;
    
    if (!serviceId || !from || !to) {
      return res.status(400).json({ error: 'serviceId, from, and to are required' });
    }
    
    // Get the most recent snapshot timestamp
    const snapshotResult = await pool.query(`
      SELECT MAX(last_updated_at) as last_updated_at
      FROM spa_availability
      WHERE service_id = $1 AND date BETWEEN $2::date AND $3::date
    `, [serviceId, from, to]);
    
    const lastUpdatedAt = snapshotResult.rows[0]?.last_updated_at || new Date().toISOString();
    
    // Get availability data - group by date, start_time, end_time
    const availabilityResult = await pool.query(`
      SELECT 
        date,
        start_time,
        end_time,
        availability_status,
        therapist_id,
        therapist_display_name,
        therapist_level,
        therapist_tags
      FROM spa_availability
      WHERE service_id = $1 
        AND date BETWEEN $2::date AND $3::date
        AND availability_status IN ('AVAILABLE', 'LIMITED', 'FULL')
      ORDER BY date ASC, start_time ASC, therapist_id ASC
    `, [serviceId, from, to]);
    
    // Group by date and slot (date + start_time + end_time), then by therapists
    const daysMap = new Map();
    const slotsMap = new Map(); // Key: date_start_end
    
    availabilityResult.rows.forEach(row => {
      const dateStr = row.date.toISOString().split('T')[0];
      const startTimeStr = row.start_time.toISOString();
      const endTimeStr = row.end_time.toISOString();
      const slotKey = `${dateStr}_${startTimeStr}_${endTimeStr}`;
      
      // Initialize day if needed
      if (!daysMap.has(dateStr)) {
        daysMap.set(dateStr, {
          date: dateStr,
          slots: [],
          availableCount: 0,
          limitedCount: 0,
          fullCount: 0
        });
      }
      
      const day = daysMap.get(dateStr);
      
      // Initialize or get slot
      if (!slotsMap.has(slotKey)) {
        const slot = {
          start: startTimeStr,
          end: endTimeStr,
          availability: null, // Will be calculated later
          therapists: [],
          isFull: false // Track if slot is marked as FULL
        };
        slotsMap.set(slotKey, slot);
        day.slots.push(slot);
      }
      
      const slot = slotsMap.get(slotKey);
      
      // Check if slot is marked as FULL
      if (row.availability_status === 'FULL') {
        slot.isFull = true;
        slot.therapists = []; // Clear therapists if full
      } else if (row.therapist_id) {
        // Add therapist to slot if available
        const tags = Array.isArray(row.therapist_tags) 
          ? row.therapist_tags 
          : (row.therapist_tags ? (typeof row.therapist_tags === 'string' ? JSON.parse(row.therapist_tags) : []) : []);
        
        slot.therapists.push({
          id: row.therapist_id,
          displayName: row.therapist_display_name || 'Unknown',
          level: row.therapist_level || null,
          tags: tags
        });
      }
    });
    
    // Finalize slot availability based on therapist count and FULL status
    slotsMap.forEach((slot) => {
      if (slot.isFull) {
        slot.availability = 'FULL';
        slot.therapists = [];
      } else {
        const therapistCount = slot.therapists.length;
        if (therapistCount === 0) {
          slot.availability = 'FULL';
        } else if (therapistCount <= 2) {
          slot.availability = 'LIMITED';
        } else {
          slot.availability = 'AVAILABLE';
        }
      }
      // Remove temporary isFull property
      delete slot.isFull;
    });
    
    // Count slots by availability for heat calculation
    daysMap.forEach((day) => {
      day.availableCount = 0;
      day.limitedCount = 0;
      day.fullCount = 0;
      
      day.slots.forEach(slot => {
        if (slot.availability === 'AVAILABLE') {
          day.availableCount++;
        } else if (slot.availability === 'LIMITED') {
          day.limitedCount++;
        } else {
          day.fullCount++;
        }
      });
    });
    
    // Calculate heat indicator (GREEN/YELLOW/RED)
    const days = Array.from(daysMap.values()).map(day => {
      const totalSlots = day.slots.length;
      const availableRatio = totalSlots > 0 ? day.availableCount / totalSlots : 0;
      
      let heat = 'GREEN';
      if (availableRatio < 0.3) {
        heat = 'RED';
      } else if (availableRatio < 0.6) {
        heat = 'YELLOW';
      }
      
      return {
        ...day,
        heat
      };
    });
    
    res.json({
      serviceId,
      from,
      to,
      lastUpdatedAt: new Date(lastUpdatedAt).toISOString(),
      days
    });
  } catch (error) {
    console.error('Error fetching SPA availability:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// Create SPA request
app.post('/api/spa/requests', async (req, res) => {
  try {
    const guestUniqueId = req.cookies?.guest_unique_id;
    
    if (!guestUniqueId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { serviceId, start, end, therapistId, note } = req.body;
    
    if (!serviceId || !start || !end) {
      return res.status(400).json({ error: 'serviceId, start, and end are required' });
    }
    
    // Verify guest exists
    const guestCheck = await pool.query(`
      SELECT guest_unique_id FROM rooms WHERE guest_unique_id = $1 AND is_active = true
    `, [guestUniqueId]);
    
    if (guestCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Guest not found' });
    }
    
    // Get service info and therapist info
    const serviceResult = await pool.query(`
      SELECT id, name FROM spa_services WHERE id = $1 AND is_active = true
    `, [serviceId]);
    
    if (serviceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }
    
    let therapistDisplayName = null;
    if (therapistId) {
      const therapistResult = await pool.query(`
        SELECT therapist_display_name 
        FROM spa_availability 
        WHERE therapist_id = $1 
        LIMIT 1
      `, [therapistId]);
      
      if (therapistResult.rows.length > 0) {
        therapistDisplayName = therapistResult.rows[0].therapist_display_name;
      }
    }
    
    // Generate unique request ID
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Insert request
    const result = await pool.query(`
      INSERT INTO spa_requests (
        request_id, guest_unique_id, service_id, start_time, end_time, 
        therapist_id, therapist_display_name, note, status
      )
      VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, 'PENDING')
      RETURNING request_id, status, created_at
    `, [requestId, guestUniqueId, serviceId, start, end, therapistId || null, therapistDisplayName, note || null]);
    
    res.status(201).json({
      requestId: result.rows[0].request_id,
      status: result.rows[0].status,
      createdAt: result.rows[0].created_at.toISOString()
    });
  } catch (error) {
    console.error('Error creating SPA request:', error);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

// List my SPA requests
app.get('/api/spa/requests', async (req, res) => {
  try {
    const { mine } = req.query;
    const guestUniqueId = req.cookies?.guest_unique_id;
    
    if (mine === 'true') {
      if (!guestUniqueId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      
      const result = await pool.query(`
        SELECT 
          sr.request_id,
          sr.service_id,
          ss.name as service_name,
          ss.price as service_price,
          ss.currency as service_currency,
          sr.start_time,
          sr.end_time,
          sr.therapist_display_name,
          sr.status,
          sr.note,
          sr.created_at,
          sr.updated_at
        FROM spa_requests sr
        INNER JOIN spa_services ss ON sr.service_id = ss.id
        WHERE sr.guest_unique_id = $1
        ORDER BY sr.created_at DESC
      `, [guestUniqueId]);
      
      const requests = result.rows.map(row => ({
        requestId: row.request_id,
        serviceName: row.service_name,
        price: row.service_price,
        currency: row.service_currency,
        servicePrice: row.service_price,
        serviceCurrency: row.service_currency,
        start: row.start_time.toISOString(),
        end: row.end_time.toISOString(),
        therapistDisplayName: row.therapist_display_name,
        status: row.status,
        updatedAt: row.updated_at.toISOString()
      }));
      
      res.json(requests);
    } else {
      return res.status(400).json({ error: 'mine parameter must be true' });
    }
  } catch (error) {
    console.error('Error fetching SPA requests:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Cancel SPA request
app.post('/api/spa/requests/:requestId/cancel', async (req, res) => {
  try {
    const { requestId } = req.params;
    const guestUniqueId = req.cookies?.guest_unique_id;
    
    if (!guestUniqueId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    // Check if request exists and belongs to guest
    const checkResult = await pool.query(`
      SELECT request_id, status, start, service_id
      FROM spa_requests 
      WHERE request_id = $1 AND guest_unique_id = $2
    `, [requestId, guestUniqueId]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    const request = checkResult.rows[0];
    
    // Only allow cancellation for PENDING or CONFIRMED requests
    if (request.status !== 'PENDING' && request.status !== 'CONFIRMED') {
      return res.status(400).json({ error: `Cannot cancel request with status: ${request.status}` });
    }
    
    // Check cancellation deadline (get from settings)
    let cancellationDeadlineMinutes = 240; // default 4 hours
    try {
      const settingsResult = await pool.query(`
        SELECT settings_json FROM hotel_settings WHERE setting_key = 'spa_cancellation_deadline_minutes' LIMIT 1
      `);
      if (settingsResult.rows.length > 0 && settingsResult.rows[0].settings_json) {
        cancellationDeadlineMinutes = settingsResult.rows[0].settings_json.value || 240;
      }
    } catch (e) {
      console.warn('Error fetching SPA cancellation deadline, using default:', e.message);
    }

    // Also check if setting is stored as simple value in settings_json
    if (settingsResult.rows.length > 0 && settingsResult.rows[0].settings_json) {
      const settingsJson = settingsResult.rows[0].settings_json;
      if (typeof settingsJson === 'object' && settingsJson.value !== undefined) {
        cancellationDeadlineMinutes = settingsJson.value;
      } else if (typeof settingsJson === 'number') {
        cancellationDeadlineMinutes = settingsJson;
      }
    }

    const reservationDateTime = new Date(request.start);
    const now = new Date();
    const deadline = new Date(reservationDateTime.getTime() - (cancellationDeadlineMinutes * 60 * 1000));
    
    if (now > deadline) {
      return res.status(400).json({ 
        error: 'Cancellation deadline has passed',
        code: 'CANCELLATION_DEADLINE_PASSED',
        deadline: deadline.toISOString(),
        deadlineMinutes: cancellationDeadlineMinutes
      });
    }
    
    // Update request status
    const result = await pool.query(`
      UPDATE spa_requests
      SET status = 'CANCELLED',
          cancelled_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE request_id = $1 AND guest_unique_id = $2
      RETURNING request_id
    `, [requestId, guestUniqueId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Error canceling SPA request:', error);
    res.status(500).json({ error: 'Failed to cancel request' });
  }
});

// Get SPA cancellation deadline setting
app.get('/api/settings/spa-cancellation-deadline-minutes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT settings_json FROM hotel_settings WHERE setting_key = 'spa_cancellation_deadline_minutes' LIMIT 1
    `);
    
    if (result.rows.length > 0 && result.rows[0].settings_json) {
      const settingsJson = result.rows[0].settings_json;
      let value = 240; // default
      if (typeof settingsJson === 'object' && settingsJson.value !== undefined) {
        value = settingsJson.value;
      } else if (typeof settingsJson === 'number') {
        value = settingsJson;
      }
      return res.json({ value });
    }
    
    res.json({ value: 240 }); // default 4 hours
  } catch (error) {
    console.error('Error fetching SPA cancellation deadline setting:', error);
    res.json({ value: 240 }); // default on error
  }
});

// Update SPA cancellation deadline setting
app.post('/api/settings/spa-cancellation-deadline-minutes', async (req, res) => {
  try {
    const { value } = req.body;
    const minutes = parseInt(value) || 240;
    
    if (minutes < 0) {
      return res.status(400).json({ error: 'Value must be non-negative' });
    }
    
    // Upsert setting
    await pool.query(`
      INSERT INTO hotel_settings (setting_key, settings_json, updated_at)
      VALUES ('spa_cancellation_deadline_minutes', $1::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (setting_key) 
      DO UPDATE SET 
        settings_json = $1::jsonb,
        updated_at = CURRENT_TIMESTAMP
    `, [{ value: minutes }]);
    
    res.json({ success: true, value: minutes });
  } catch (error) {
    console.error('Error updating SPA cancellation deadline setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// Update SPA request status (for admin/staff - no auth for now)
app.patch('/api/spa/requests/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { status } = req.body;
    
    if (!status || !['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be PENDING, CONFIRMED, REJECTED, or CANCELLED' });
    }
    
    // Check if request exists
    const checkResult = await pool.query(`
      SELECT request_id, status 
      FROM spa_requests 
      WHERE request_id = $1
    `, [requestId]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    // Update request status
    const result = await pool.query(`
      UPDATE spa_requests
      SET status = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE request_id = $2
      RETURNING request_id, status
    `, [status, requestId]);
    
    res.json({ success: true, requestId: result.rows[0].request_id, status: result.rows[0].status });
  } catch (error) {
    console.error('Error updating SPA request:', error);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

// Get all SPA requests (for admin/staff - no auth for now)
app.get('/api/spa/requests/all', async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = `
      SELECT 
        sr.request_id,
        sr.service_id,
        ss.name as service_name,
        ss.price as service_price,
        ss.currency as service_currency,
        sr.guest_unique_id,
        r.guest_name,
        r.guest_surname,
        r.room_number,
        sr.start_time,
        sr.end_time,
        sr.therapist_display_name,
        sr.status,
        sr.note,
        sr.created_at,
        sr.updated_at
      FROM spa_requests sr
      INNER JOIN spa_services ss ON sr.service_id = ss.id
      LEFT JOIN rooms r ON sr.guest_unique_id = r.guest_unique_id
    `;
    
    const params = [];
    if (status) {
      query += ` WHERE sr.status = $1`;
      params.push(status);
    }
    
    query += ` ORDER BY sr.created_at DESC`;
    
    const result = await pool.query(query, params);
    
    const requests = result.rows.map(row => ({
      requestId: row.request_id,
      serviceId: row.service_id,
      serviceName: row.service_name,
      price: row.service_price,
      currency: row.service_currency,
      servicePrice: row.service_price,
      serviceCurrency: row.service_currency,
      guestUniqueId: row.guest_unique_id,
      guestName: row.guest_name || 'Bilinmiyor',
      guestSurname: row.guest_surname || '',
      roomNumber: row.room_number || '-',
      start: row.start_time.toISOString(),
      end: row.end_time.toISOString(),
      therapistDisplayName: row.therapist_display_name,
      status: row.status,
      note: row.note,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    }));
    
    res.json({ success: true, requests });
  } catch (error) {
    console.error('Error fetching all SPA requests:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// HTTP server is now started in the database initialization promise (see above)
// This ensures the server only starts after the database is ready

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  httpServer.close(async () => {
    console.log('HTTP server closed');
    await pool.end();
    console.log('Database pool closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  httpServer.close(async () => {
    console.log('HTTP server closed');
    await pool.end();
    console.log('Database pool closed');
    process.exit(0);
  });
});
