import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import { randomBytes } from 'crypto';

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
        checkin_date DATE NOT NULL,
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

      -- Add checkin_date column to messages if it doesn't exist
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS checkin_date DATE;
      
      -- Update existing messages: set checkin_date from rooms table where possible
      UPDATE messages m
      SET checkin_date = (
        SELECT r.checkin_date 
        FROM rooms r 
        WHERE r.room_number = m.room_number 
        ORDER BY r.checkin_date DESC 
        LIMIT 1
      )
      WHERE m.checkin_date IS NULL;
      
      CREATE INDEX IF NOT EXISTS idx_messages_room_number ON messages(room_number);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_room_checkin ON messages(room_number, checkin_date);
      CREATE INDEX IF NOT EXISTS idx_rooms_room_checkin ON rooms(room_number, checkin_date);

      -- Assistant'lar tablosu
      CREATE TABLE IF NOT EXISTS assistants (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE,
        password_hash VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Assistant'a atanan odalar
      CREATE TABLE IF NOT EXISTS assistant_assignments (
        id SERIAL PRIMARY KEY,
        assistant_id INTEGER REFERENCES assistants(id) ON DELETE CASCADE,
        room_number VARCHAR(50) REFERENCES rooms(room_number) ON DELETE CASCADE,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(assistant_id, room_number)
      );

      -- QR kod ve davet sistemi
      CREATE TABLE IF NOT EXISTS room_invites (
        id SERIAL PRIMARY KEY,
        room_number VARCHAR(50) REFERENCES rooms(room_number) ON DELETE CASCADE,
        assistant_id INTEGER REFERENCES assistants(id) ON DELETE CASCADE,
        invite_token VARCHAR(255) UNIQUE NOT NULL,
        qr_code_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        used_at TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      );

      -- Rooms tablosuna guest_surname ekle
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS guest_surname VARCHAR(100);

      -- Index'ler
      CREATE INDEX IF NOT EXISTS idx_assistant_assignments_assistant ON assistant_assignments(assistant_id);
      CREATE INDEX IF NOT EXISTS idx_assistant_assignments_room ON assistant_assignments(room_number);
      CREATE INDEX IF NOT EXISTS idx_room_invites_token ON room_invites(invite_token);
      CREATE INDEX IF NOT EXISTS idx_room_invites_room ON room_invites(room_number);
    `);
    
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  }
}

// Initialize on startup (test data will be initialized after DB setup)

// Socket.IO Connection
io.on('connection', (socket) => {
  console.log('🟢 ========== NEW CLIENT CONNECTION ==========');
  console.log('🟢 Socket ID:', socket.id);
  console.log('🟢 Time:', new Date().toISOString());
  console.log('🟢 Client IP:', socket.handshake.address);
  console.log('🟢 User Agent:', socket.handshake.headers['user-agent']);
  console.log('🟢 Transport:', socket.conn.transport.name);

  // Join room
  socket.on('join_room', async (data) => {
    // Support both old format (just roomNumber) and new format (object with roomNumber and checkinDate)
    const roomNumber = typeof data === 'string' ? data : data.roomNumber;
    const checkinDate = typeof data === 'object' && data.checkinDate ? data.checkinDate : null;
    
    console.log('🔵 ========== SERVER: JOIN ROOM ==========');
    console.log('🔵 Socket ID:', socket.id);
    console.log('🔵 Room Number:', roomNumber);
    console.log('🔵 Check-in Date:', checkinDate);
    console.log('🔵 Time:', new Date().toISOString());
    console.log('🔵 Client IP:', socket.handshake.address);
    console.log('🔵 User Agent:', socket.handshake.headers['user-agent']);
    
    // If checkinDate not provided, get it from room
    let actualCheckinDate = checkinDate;
    if (!actualCheckinDate) {
      const roomResult = await pool.query(
        'SELECT checkin_date FROM rooms WHERE room_number = $1',
        [roomNumber]
      );
      if (roomResult.rows.length > 0) {
        actualCheckinDate = roomResult.rows[0].checkin_date;
        console.log('🔵 Check-in date from room:', actualCheckinDate);
      }
    }
    
    // Use room_number + checkin_date as unique room identifier
    const roomId = actualCheckinDate ? `${roomNumber}_${actualCheckinDate}` : roomNumber;
    socket.join(roomId);
    console.log(`✅ Client joined room: ${roomId}`);
    
    try {
      console.log('📊 Fetching chat history for room:', roomNumber, 'check-in:', actualCheckinDate);
      // Send chat history (last 50 messages) filtered by room_number AND checkin_date
      let result;
      if (actualCheckinDate) {
        result = await pool.query(`
          SELECT * FROM messages 
          WHERE room_number = $1 AND checkin_date = $2
          ORDER BY timestamp DESC 
          LIMIT 50
        `, [roomNumber, actualCheckinDate]);
      } else {
        // Fallback: if no checkin_date, use only room_number (for backward compatibility)
        result = await pool.query(`
          SELECT * FROM messages 
          WHERE room_number = $1 
          ORDER BY timestamp DESC 
          LIMIT 50
        `, [roomNumber]);
      }
      
      console.log('📊 Messages found:', result.rows.length);
      
      // Map database column names (snake_case) to frontend format (camelCase)
      const messages = result.rows.reverse().map(row => ({
        id: row.id,
        roomNumber: row.room_number,
        checkinDate: row.checkin_date,
        senderType: row.sender_type,
        senderName: row.sender_name,
        message: row.message,
        timestamp: row.timestamp
      }));
      
      console.log('📤 Sending chat_history to client');
      console.log('📤 Message count:', messages.length);
      socket.emit('chat_history', messages);
      console.log('✅ chat_history sent successfully');
    } catch (error) {
      console.error('Error loading chat history:', error);
      socket.emit('chat_history', []);
    }
  });

  // Load older messages
  socket.on('load_older_messages', async (data) => {
    const { roomNumber, checkinDate, beforeTimestamp, limit = 50 } = data;
    
    try {
      let result;
      if (checkinDate) {
        result = await pool.query(`
          SELECT * FROM messages 
          WHERE room_number = $1 
          AND checkin_date = $2
          AND timestamp < $3
          ORDER BY timestamp DESC 
          LIMIT $4
        `, [roomNumber, checkinDate, beforeTimestamp, limit]);
      } else {
        // Fallback for backward compatibility
        result = await pool.query(`
          SELECT * FROM messages 
          WHERE room_number = $1 
          AND timestamp < $2
          ORDER BY timestamp DESC 
          LIMIT $3
        `, [roomNumber, beforeTimestamp, limit]);
      }
      
      // Map database column names (snake_case) to frontend format (camelCase)
      const messages = result.rows.reverse().map(row => ({
        id: row.id,
        roomNumber: row.room_number,
        checkinDate: row.checkin_date,
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
    
    const { roomNumber, checkinDate, senderType, senderName, message } = data;
    
    // Get checkin_date if not provided
    let actualCheckinDate = checkinDate;
    if (!actualCheckinDate) {
      const roomResult = await pool.query(
        'SELECT checkin_date FROM rooms WHERE room_number = $1',
        [roomNumber]
      );
      if (roomResult.rows.length > 0) {
        actualCheckinDate = roomResult.rows[0].checkin_date;
      }
    }
    
    if (!actualCheckinDate) {
      console.error('❌ Cannot save message: checkin_date not found for room:', roomNumber);
      socket.emit('error', { message: 'Oda bilgisi bulunamadı' });
      return;
    }
    
    try {
      // Save to database with checkin_date
      const result = await pool.query(`
        INSERT INTO messages (room_number, checkin_date, sender_type, sender_name, message)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, timestamp
      `, [
        roomNumber,
        actualCheckinDate,
        senderType,
        senderName,
        message
      ]);
      
      const messageId = result.rows[0].id;
      const timestamp = result.rows[0].timestamp;
      
      // Use room_number + checkin_date as unique room identifier for broadcasting
      const roomId = `${roomNumber}_${actualCheckinDate}`;
      
      // Broadcast message
      const messageData = {
        id: messageId,
        roomNumber,
        checkinDate: actualCheckinDate,
        senderType,
        senderName,
        message,
        timestamp: timestamp.toISOString()
      };
      
      io.to(roomId).emit('new_message', messageData);
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

  socket.on('disconnect', (reason) => {
    console.log('🔴 ========== CLIENT DISCONNECTED ==========');
    console.log('🔴 Socket ID:', socket.id);
    console.log('🔴 Reason:', reason);
    console.log('🔴 Time:', new Date().toISOString());
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
    const { roomNumber } = req.params;
    console.log('📸 Fetching profile photo for room:', roomNumber);
    
    const result = await pool.query(
      'SELECT profile_photo FROM rooms WHERE room_number = $1',
      [roomNumber]
    );
    
    if (result.rows.length === 0) {
      console.log('⚠️ Room not found:', roomNumber);
      // Return null instead of 404 - room might not exist yet
      return res.json({ profilePhoto: null });
    }
    
    const profilePhoto = result.rows[0].profile_photo || null;
    console.log('✅ Profile photo fetched:', profilePhoto ? 'exists' : 'null');
    res.json({ profilePhoto });
  } catch (error) {
    console.error('❌ Error fetching profile photo:', error);
    console.error('❌ Error stack:', error.stack);
    // Return null instead of 500 - don't break the app
    res.json({ profilePhoto: null });
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

// Assistant API Endpoints

// Get assistant's assigned rooms (filtered by check-in date)
app.get('/api/assistant/:assistantId/rooms', async (req, res) => {
  try {
    const { assistantId } = req.params;
    const { date } = req.query; // Optional: filter by date (default: today)
    
    const checkinDate = date || new Date().toISOString().split('T')[0];
    
    const result = await pool.query(`
      SELECT 
        r.id,
        r.room_number,
        r.guest_name,
        r.guest_surname,
        r.checkin_date,
        r.checkout_date,
        r.is_active,
        aa.assigned_at
      FROM rooms r
      INNER JOIN assistant_assignments aa ON r.room_number = aa.room_number
      WHERE aa.assistant_id = $1 
        AND aa.is_active = true
        AND r.checkin_date = $2
        AND r.is_active = true
      ORDER BY r.room_number ASC
    `, [assistantId, checkinDate]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching assistant rooms:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create invite and generate QR code for a room
app.post('/api/assistant/:assistantId/rooms/:roomNumber/invite', async (req, res) => {
  try {
    const { assistantId, roomNumber } = req.params;
    
    // Verify assistant has access to this room
    const assignmentCheck = await pool.query(`
      SELECT * FROM assistant_assignments 
      WHERE assistant_id = $1 AND room_number = $2 AND is_active = true
    `, [assistantId, roomNumber]);
    
    if (assignmentCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Assistant does not have access to this room' });
    }
    
    // Generate unique token
    const inviteToken = randomBytes(32).toString('hex');
    
    // Create invite link
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviteLink = `${frontendUrl}/join?token=${inviteToken}`;
    
    // Generate QR code
    const qrCodeDataUrl = await QRCode.toDataURL(inviteLink, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    
    // Save to database
    const result = await pool.query(`
      INSERT INTO room_invites (room_number, assistant_id, invite_token, qr_code_url, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, created_at
    `, [
      roomNumber,
      assistantId,
      inviteToken,
      qrCodeDataUrl,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days expiry
    ]);
    
    res.json({
      inviteToken,
      qrCodeUrl: qrCodeDataUrl,
      inviteLink,
      expiresAt: result.rows[0].created_at
    });
  } catch (error) {
    console.error('Error creating invite:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get room info by invite token (for guest onboarding)
// Note: Returns info even if token is already used (for guest name loading)
app.get('/api/invite/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const result = await pool.query(`
      SELECT 
        ri.invite_token,
        ri.room_number,
        ri.used_at,
        ri.expires_at,
        r.guest_name,
        r.guest_surname,
        r.checkin_date,
        r.checkout_date
      FROM room_invites ri
      INNER JOIN rooms r ON ri.room_number = r.room_number
      WHERE ri.invite_token = $1 AND ri.is_active = true
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired invite token' });
    }
    
    const invite = result.rows[0];
    
    // Check if expired
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invite token has expired' });
    }
    
    // Return info even if token is already used (for guest name loading after redirect)
    res.json({
      roomNumber: invite.room_number,
      guestName: invite.guest_name,
      guestSurname: invite.guest_surname,
      checkinDate: invite.checkin_date,
      checkoutDate: invite.checkout_date,
      used: !!invite.used_at
    });
  } catch (error) {
    console.error('Error fetching invite:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Mark invite as used
app.post('/api/invite/:token/use', async (req, res) => {
  try {
    const { token } = req.params;
    
    const result = await pool.query(`
      UPDATE room_invites 
      SET used_at = CURRENT_TIMESTAMP
      WHERE invite_token = $1 AND used_at IS NULL
      RETURNING id
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found or already used' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking invite as used:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Initialize test data (rooms with today's check-in date)
async function initializeTestData() {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Create test assistant if not exists
    const assistantResult = await pool.query(`
      INSERT INTO assistants (name, email, is_active)
      VALUES ('Test Assistant', 'assistant@voyage.com', true)
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `);
    
    let assistantId;
    if (assistantResult.rows.length > 0) {
      assistantId = assistantResult.rows[0].id;
    } else {
      const existing = await pool.query('SELECT id FROM assistants WHERE email = $1', ['assistant@voyage.com']);
      assistantId = existing.rows[0].id;
    }
    
    // Create test rooms with today's check-in date
    const testRooms = [
      { number: '301', name: 'Ali', surname: 'Yılmaz' },
      { number: '302', name: 'Ayşe', surname: 'Demir' },
      { number: '303', name: 'Mehmet', surname: 'Kaya' },
      { number: '304', name: 'Zeynep', surname: 'Şahin' },
      { number: '305', name: 'Can', surname: 'Özkan' },
      { number: '306', name: 'Lena', surname: 'Podorozhna' }
    ];
    
    for (const room of testRooms) {
      // Create or update room
      await pool.query(`
        INSERT INTO rooms (room_number, guest_name, guest_surname, checkin_date, checkout_date, is_active)
        VALUES ($1, $2, $3, $4, $5, true)
        ON CONFLICT (room_number) 
        DO UPDATE SET 
          guest_name = EXCLUDED.guest_name,
          guest_surname = EXCLUDED.guest_surname,
          checkin_date = EXCLUDED.checkin_date,
          checkout_date = EXCLUDED.checkout_date,
          is_active = true
      `, [
        room.number,
        room.name,
        room.surname,
        today,
        new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] // 3 days later
      ]);
      
      // Assign to assistant
      await pool.query(`
        INSERT INTO assistant_assignments (assistant_id, room_number, is_active)
        VALUES ($1, $2, true)
        ON CONFLICT (assistant_id, room_number) 
        DO UPDATE SET is_active = true
      `, [assistantId, room.number]);
    }
    
    console.log('✅ Test data initialized');
  } catch (error) {
    console.error('❌ Error initializing test data:', error);
  }
}

// Initialize test data after database setup
initializeDatabase().then(() => {
  initializeTestData();
}).catch(console.error);

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

// Serve frontend pages
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/assistant', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'assistant.html'));
});

app.get('/assistant.html', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'assistant.html'));
});

app.get('/join', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'join.html'));
});

app.get('/join.html', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'join.html'));
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
