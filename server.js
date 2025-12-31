import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

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
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? allowedOrigins 
    : "*",
  credentials: true
}));
app.use(express.json());

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
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
pool.on('connect', () => {
  console.log('✅ PostgreSQL connected');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL error:', err);
});

// Initialize database tables
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        room_number VARCHAR(50) NOT NULL,
        sender_type VARCHAR(20) NOT NULL,
        sender_name VARCHAR(100),
        message TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_number VARCHAR(50) UNIQUE NOT NULL,
        guest_name VARCHAR(100),
        checkin_date DATE,
        checkout_date DATE,
        is_active BOOLEAN DEFAULT true,
        profile_photo TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room_number ON messages(room_number);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    `);
    
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  }
}

// Initialize on startup
initializeDatabase().catch(console.error);

// Socket.IO Connection
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Join room
  socket.on('join_room', async (roomNumber) => {
    socket.join(roomNumber);
    console.log(`👤 Client joined room: ${roomNumber}`);
    
    try {
      // Send chat history (last 50 messages)
      const result = await pool.query(`
        SELECT * FROM messages 
        WHERE room_number = $1 
        ORDER BY timestamp DESC 
        LIMIT 50
      `, [roomNumber]);
      
      // Map database column names (snake_case) to frontend format (camelCase)
      const messages = result.rows.reverse().map(row => ({
        id: row.id,
        roomNumber: row.room_number,
        senderType: row.sender_type,
        senderName: row.sender_name,
        message: row.message,
        timestamp: row.timestamp
      }));
      
      socket.emit('chat_history', messages);
    } catch (error) {
      console.error('Error loading chat history:', error);
      socket.emit('chat_history', []);
    }
  });

  // Load older messages
  socket.on('load_older_messages', async (data) => {
    const { roomNumber, beforeTimestamp, limit = 50 } = data;
    
    try {
      const result = await pool.query(`
        SELECT * FROM messages 
        WHERE room_number = $1 
        AND timestamp < $2
        ORDER BY timestamp DESC 
        LIMIT $3
      `, [roomNumber, beforeTimestamp, limit]);
      
      // Map database column names (snake_case) to frontend format (camelCase)
      const messages = result.rows.reverse().map(row => ({
        id: row.id,
        roomNumber: row.room_number,
        senderType: row.sender_type,
        senderName: row.sender_name,
        message: row.message,
        timestamp: row.timestamp
      }));
      
      socket.emit('older_messages', messages);
    } catch (error) {
      console.error('Error loading older messages:', error);
      socket.emit('older_messages', []);
    }
  });

  // New message
  socket.on('send_message', async (data) => {
    console.log('📨 Message received:', data);
    
    const { roomNumber, senderType, senderName, message } = data;
    
    try {
      // Save to database
      const result = await pool.query(`
        INSERT INTO messages (room_number, sender_type, sender_name, message)
        VALUES ($1, $2, $3, $4)
        RETURNING id, timestamp
      `, [
        roomNumber,
        senderType,
        senderName,
        message
      ]);
      
      const messageId = result.rows[0].id;
      const timestamp = result.rows[0].timestamp;
      
      // Broadcast message
      const messageData = {
        id: messageId,
        roomNumber,
        senderType,
        senderName,
        message,
        timestamp: timestamp.toISOString()
      };
      
      io.to(roomNumber).emit('new_message', messageData);
    } catch (error) {
      console.error('Error saving message:', error);
      socket.emit('error', { message: 'Mesaj kaydedilemedi' });
    }
  });

  // Typing indicator
  socket.on('typing', (data) => {
    socket.to(data.roomNumber).emit('user_typing', {
      senderName: data.senderName,
      senderType: data.senderType
    });
  });

  socket.on('stop_typing', (data) => {
    socket.to(data.roomNumber).emit('user_stopped_typing');
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// REST API Endpoints

// Get all active rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms WHERE is_active = true');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ error: 'Database error' });
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
    const { roomNumber, guestName, checkinDate, checkoutDate } = req.body;
    
    await pool.query(`
      INSERT INTO rooms (room_number, guest_name, checkin_date, checkout_date)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(room_number) 
      DO UPDATE SET 
        guest_name = EXCLUDED.guest_name, 
        checkin_date = EXCLUDED.checkin_date, 
        checkout_date = EXCLUDED.checkout_date, 
        is_active = true
    `, [roomNumber, guestName, checkinDate, checkoutDate]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error creating/updating room:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get profile photo for a room
app.get('/api/rooms/:roomNumber/profile-photo', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT profile_photo FROM rooms WHERE room_number = $1',
      [req.params.roomNumber]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    res.json({ profilePhoto: result.rows[0].profile_photo || null });
  } catch (error) {
    console.error('Error fetching profile photo:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Save profile photo for a room
app.post('/api/rooms/:roomNumber/profile-photo', async (req, res) => {
  try {
    const { profilePhoto } = req.body;
    const { roomNumber } = req.params;
    
    // Update or insert room with profile photo
    await pool.query(`
      INSERT INTO rooms (room_number, profile_photo)
      VALUES ($1, $2)
      ON CONFLICT(room_number) 
      DO UPDATE SET profile_photo = EXCLUDED.profile_photo
    `, [roomNumber, profilePhoto]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving profile photo:', error);
    res.status(500).json({ error: 'Database error' });
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

// Health check
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await pool.query('SELECT 1');
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      database: 'connected',
      websocket: 'active'
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'error', 
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log('');
  console.log('🏨 ════════════════════════════════════════════');
  console.log('   Voyage Sorgun Chat Server');
  console.log('   ════════════════════════════════════════════');
  console.log('');
  console.log(`   🌐 Server: http://localhost:${PORT}`);
  console.log(`   🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`   📊 API: http://localhost:${PORT}/api`);
  console.log('');
  console.log(`   ✅ Database: PostgreSQL`);
  console.log('   ✅ Real-time: Socket.IO');
  console.log('   ✅ PWA: Enabled');
  console.log(`   ✅ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('');
  console.log('🏨 ════════════════════════════════════════════');
  console.log('');
});

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
