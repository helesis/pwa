import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import { randomBytes, createHash } from 'crypto';
import cookieParser from 'cookie-parser';

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
        checkin_date DATE,
        sender_type VARCHAR(20) NOT NULL,
        sender_name VARCHAR(100),
        message TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP,
        read_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_number VARCHAR(50) NOT NULL,
        guest_name VARCHAR(100),
        checkin_date DATE,
        checkout_date DATE,
        is_active BOOLEAN DEFAULT true,
        profile_photo TEXT,
        UNIQUE(room_number, checkin_date)
      );

      -- Add checkin_date column to messages if it doesn't exist
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS checkin_date DATE;
      
      -- Add delivered_at and read_at columns if they don't exist
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP;
      
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
      CREATE INDEX IF NOT EXISTS idx_messages_delivered ON messages(delivered_at);
      CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(read_at);
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
      
      -- Rooms tablosuna yeni kolonlar ekle (PMS entegrasyonu için)
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS adult_count INTEGER DEFAULT 1;
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS child_count INTEGER DEFAULT 0;
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS agency VARCHAR(100);
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS country VARCHAR(100);
      
      -- Rooms tablosuna profile_photo ekle (eğer yoksa)
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS profile_photo TEXT;
      
      -- Rooms tablosuna guest_unique_id ekle (ad, soyad, checkin_date'den oluşturulacak)
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS guest_unique_id VARCHAR(255);
      
      -- Guest unique ID için index
      CREATE INDEX IF NOT EXISTS idx_rooms_guest_unique_id ON rooms(guest_unique_id);

      -- Assistants ve Teams tablolarına avatar kolonu ekle
      ALTER TABLE assistants ADD COLUMN IF NOT EXISTS avatar TEXT;
      ALTER TABLE teams ADD COLUMN IF NOT EXISTS avatar TEXT;

      -- Teams (Takımlar) tablosu
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Assistant-Team eşleştirmesi
      CREATE TABLE IF NOT EXISTS assistant_teams (
        id SERIAL PRIMARY KEY,
        assistant_id INTEGER REFERENCES assistants(id) ON DELETE CASCADE,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(assistant_id, team_id)
      );

      -- Team-Room eşleştirmesi (check-in date'e göre veya guest_unique_id ile)
      CREATE TABLE IF NOT EXISTS team_room_assignments (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        room_number VARCHAR(50),
        checkin_date DATE,
        guest_unique_id VARCHAR(255),
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(team_id, room_number, checkin_date)
      );
      
      -- Team-room assignments'a guest_unique_id kolonu ekle (eğer yoksa)
      ALTER TABLE team_room_assignments ADD COLUMN IF NOT EXISTS guest_unique_id VARCHAR(255);
      
      -- Guest unique ID için index
      CREATE INDEX IF NOT EXISTS idx_team_room_assignments_guest_unique_id ON team_room_assignments(guest_unique_id);

      -- Team invite QR codes
      CREATE TABLE IF NOT EXISTS team_invites (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        invite_token VARCHAR(255) UNIQUE NOT NULL,
        qr_code_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        used_at TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      );

      -- Index'ler
      CREATE INDEX IF NOT EXISTS idx_assistant_assignments_assistant ON assistant_assignments(assistant_id);
      CREATE INDEX IF NOT EXISTS idx_assistant_assignments_room ON assistant_assignments(room_number);
      CREATE INDEX IF NOT EXISTS idx_room_invites_token ON room_invites(invite_token);
      CREATE INDEX IF NOT EXISTS idx_room_invites_room ON room_invites(room_number);
      CREATE INDEX IF NOT EXISTS idx_assistant_teams_assistant ON assistant_teams(assistant_id);
      CREATE INDEX IF NOT EXISTS idx_assistant_teams_team ON assistant_teams(team_id);
      CREATE INDEX IF NOT EXISTS idx_team_room_assignments_team ON team_room_assignments(team_id);
      CREATE INDEX IF NOT EXISTS idx_team_room_assignments_room_checkin ON team_room_assignments(room_number, checkin_date);
      CREATE INDEX IF NOT EXISTS idx_team_invites_token ON team_invites(invite_token);
      CREATE INDEX IF NOT EXISTS idx_team_invites_team ON team_invites(team_id);
    `);
    
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
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

// Generate guest unique ID from name, surname and checkin_date
function generateGuestUniqueId(guestName, guestSurname, checkinDate) {
  if (!guestName || !checkinDate) {
    return null;
  }
  
  // Normalize inputs
  const name = (guestName || '').trim().toLowerCase().replace(/\s+/g, '_');
  const surname = (guestSurname || '').trim().toLowerCase().replace(/\s+/g, '_');
  const date = checkinDate instanceof Date 
    ? checkinDate.toISOString().split('T')[0] 
    : String(checkinDate).split('T')[0];
  
  // Create unique ID: name_surname_date (hash for uniqueness)
  const combined = `${name}_${surname}_${date}`;
  
  // Use crypto to create a short hash
  const hash = createHash('sha256').update(combined).digest('hex').substring(0, 16);
  
  return `${name}_${surname}_${date}_${hash}`;
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
    // Support both old format (just roomNumber) and new format (object with roomNumber and checkinDate)
    const roomNumber = typeof data === 'string' ? data : data.roomNumber;
    const checkinDate = typeof data === 'object' && data.checkinDate ? data.checkinDate : null;
    
    logDebug('🔵 ========== SERVER: JOIN ROOM ==========');
    logDebug('🔵 Socket ID:', socket.id);
    logDebug('🔵 Room Number:', roomNumber);
    logDebug('🔵 Check-in Date:', checkinDate);
    logDebug('🔵 Time:', new Date().toISOString());
    logDebug('🔵 Client IP:', socket.handshake.address);
    logDebug('🔵 User Agent:', socket.handshake.headers['user-agent']);
    
    // If checkinDate not provided, get it from room
    let actualCheckinDate = checkinDate;
    if (!actualCheckinDate) {
      const roomResult = await pool.query(
        'SELECT checkin_date FROM rooms WHERE room_number = $1',
        [roomNumber]
      );
      if (roomResult.rows.length > 0) {
        actualCheckinDate = roomResult.rows[0].checkin_date;
        logDebug('🔵 Check-in date from room:', actualCheckinDate);
      }
    }
    
    // Use room_number + checkin_date as unique room identifier
    const roomId = actualCheckinDate ? `${roomNumber}_${actualCheckinDate}` : roomNumber;
    socket.join(roomId);
    logInfo(`✅ Client joined room: ${roomId}`);
    
    try {
      logDebug('📊 Fetching chat history for room:', roomNumber, 'check-in:', actualCheckinDate);
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
      
      logDebug('📊 Messages found:', result.rows.length);
      
      // Map database column names (snake_case) to frontend format (camelCase)
      const messages = result.rows.reverse().map(row => {
        // Determine status based on delivered_at and read_at
        let status = 'sent';
        if (row.read_at) {
          status = 'read';
        } else if (row.delivered_at) {
          status = 'delivered';
        }
        
        return {
          id: row.id,
          roomNumber: row.room_number,
          checkinDate: row.checkin_date,
          senderType: row.sender_type,
          senderName: row.sender_name,
          message: row.message,
          timestamp: row.timestamp,
          status: status,
          deliveredAt: row.delivered_at,
          readAt: row.read_at
        };
      });
      
      logDebug('📤 Sending chat_history to client');
      logDebug('📤 Message count:', messages.length);
      socket.emit('chat_history', messages);
      logDebug('✅ chat_history sent successfully');
    } catch (error) {
      console.error('❌ Error loading chat history:', error);
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
      const messages = result.rows.reverse().map(row => {
        // Determine status based on delivered_at and read_at
        let status = 'sent';
        if (row.read_at) {
          status = 'read';
        } else if (row.delivered_at) {
          status = 'delivered';
        }
        
        return {
          id: row.id,
          roomNumber: row.room_number,
          checkinDate: row.checkin_date,
          senderType: row.sender_type,
          senderName: row.sender_name,
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
      
      // Broadcast message with status
      const messageData = {
        id: messageId,
        roomNumber,
        checkinDate: actualCheckinDate,
        senderType,
        senderName,
        message,
        timestamp: timestamp.toISOString(),
        status: 'sent', // Initial status: sent
        deliveredAt: null,
        readAt: null
      };
      
      // Send confirmation to sender first
      socket.emit('message_sent', { messageId, status: 'sent' });
      
      // Broadcast to room (other users will mark as delivered when received)
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
        'SELECT room_number, checkin_date FROM messages WHERE id = $1',
        [messageId]
      );
      
      if (messageResult.rows.length > 0) {
        const { room_number, checkin_date } = messageResult.rows[0];
        // Normalize checkin_date to YYYY-MM-DD format for roomId
        const checkinDateStr = checkin_date ? checkin_date.toISOString().split('T')[0] : null;
        const roomId = checkinDateStr ? `${room_number}_${checkinDateStr}` : room_number;
        
        logDebug('📤 Broadcasting message_status_update to room:', roomId, { 
          messageId, 
          status: 'delivered',
          room_number,
          checkin_date: checkinDateStr
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
        'SELECT room_number, checkin_date FROM messages WHERE id = $1',
        [messageIds[0]]
      );
      
      if (messageResult.rows.length > 0) {
        const { room_number, checkin_date } = messageResult.rows[0];
        // Normalize checkin_date to YYYY-MM-DD format for roomId
        const checkinDateStr = checkin_date ? checkin_date.toISOString().split('T')[0] : null;
        const roomId = checkinDateStr ? `${room_number}_${checkinDateStr}` : room_number;
        
        logDebug('📤 Broadcasting message_status_update (read) to room:', roomId, { 
          messageIds, 
          status: 'read',
          room_number,
          checkin_date: checkinDateStr
        });
        
        // Broadcast status update to room (sender will see read ticks)
        io.to(roomId).emit('message_status_update', { 
          messageIds, 
          status: 'read' 
        });
        
        logDebug('✅ message_status_update (read) broadcasted to room:', roomId);
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
      console.log('🔍 Filtering rooms by date range:', start_date, 'to', end_date);
    } else if (start_date) {
      query += ' AND checkin_date >= $1 ORDER BY checkin_date ASC, room_number ASC';
      params.push(start_date);
      console.log('🔍 Filtering rooms from date:', start_date);
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
    const guest_unique_id = generateGuestUniqueId(guestName, guestSurname, checkinDate);
    
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
    
    console.log('✅ Profile photo saved successfully');
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
        email: assistant.email,
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
    
    const result = await pool.query('SELECT id, name, email, avatar, is_active FROM assistants WHERE id = $1 AND is_active = true', [assistantId]);
    
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
    const { name, email, avatar } = req.body;
    const result = await pool.query(
      'INSERT INTO assistants (name, email, avatar) VALUES ($1, $2, $3) RETURNING *',
      [name, email || null, avatar || null]
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
    const { name, email, avatar } = req.body;
    // Always update avatar - if empty string or null, set to null
    const avatarValue = avatar || null;
    const result = await pool.query(
      'UPDATE assistants SET name = $1, email = $2, avatar = $3 WHERE id = $4 RETURNING *',
      [name, email || null, avatarValue, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assistant not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating assistant:', error);
    res.status(500).json({ error: 'Database error' });
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
          SELECT COUNT(DISTINCT tra.room_number || '_' || tra.checkin_date)
          FROM team_room_assignments tra
          INNER JOIN rooms r ON tra.room_number = r.room_number 
            AND tra.checkin_date = r.checkin_date
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
    
    // Auto-generate QR code for the team
    try {
      const inviteToken = randomBytes(32).toString('hex');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const inviteLink = `${frontendUrl}/join-team?token=${inviteToken}`;
      
      const qrCodeDataUrl = await QRCode.toDataURL(inviteLink, {
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
      
      await pool.query(`
        INSERT INTO team_invites (team_id, invite_token, qr_code_url, expires_at)
        VALUES ($1, $2, $3, $4)
      `, [
        team.id,
        inviteToken,
        qrCodeDataUrl,
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
      ]);
      
      console.log(`✅ Auto-generated QR code for team ${team.id}`);
    } catch (qrError) {
      console.error('⚠️ Error auto-generating QR code for team:', qrError);
      // Don't fail team creation if QR generation fails
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
    console.log('📋 GET /api/team-assignments - checkin_date:', checkin_date);
    
    let query = `
      SELECT 
        tra.id,
        tra.room_number,
        tra.checkin_date,
        tra.guest_unique_id,
        t.name as team_name,
        r.guest_name,
        r.guest_surname,
        r.profile_photo
      FROM team_room_assignments tra
      INNER JOIN teams t ON tra.team_id = t.id
      LEFT JOIN rooms r ON (tra.room_number = r.room_number AND tra.checkin_date = r.checkin_date) 
                        OR (tra.guest_unique_id IS NOT NULL AND tra.guest_unique_id = r.guest_unique_id)
      WHERE tra.is_active = true
    `;
    const params = [];
    
    if (checkin_date) {
      console.log('🔍 Filtering by checkin_date:', checkin_date);
      query += ' AND tra.checkin_date = $1';
      params.push(checkin_date);
    }
    
    query += ' ORDER BY tra.checkin_date DESC, tra.room_number';
    
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
      const { room_number, checkin_date, guest_name, guest_surname } = assignment;
      
      // Generate guest_unique_id if guest info is provided
      let guest_unique_id = null;
      if (guest_name && checkin_date) {
        guest_unique_id = generateGuestUniqueId(guest_name, guest_surname, checkin_date);
      }
      
      // If room_number is not provided but guest_unique_id is, we can still create assignment
      // This allows pre-assignment before room is assigned
      if (!room_number && !guest_unique_id) {
        return res.status(400).json({ error: 'Either room_number or guest_name+checkin_date is required' });
      }
      
      // Create team-room assignment
      // Use guest_unique_id if available, otherwise use room_number + checkin_date
      let assignmentResult;
      if (guest_unique_id) {
        // Try to insert with guest_unique_id first (using partial unique index)
        try {
          assignmentResult = await pool.query(
            `INSERT INTO team_room_assignments (team_id, room_number, checkin_date, guest_unique_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (team_id, room_number, checkin_date) 
             DO UPDATE SET is_active = true, guest_unique_id = COALESCE(EXCLUDED.guest_unique_id, team_room_assignments.guest_unique_id)
             RETURNING *`,
            [team_id, room_number || null, checkin_date || null, guest_unique_id]
          );
        } catch (conflictError) {
          // If conflict on guest_unique_id (partial unique index), update existing
          if (conflictError.code === '23505' && conflictError.constraint?.includes('guest_unique')) {
            assignmentResult = await pool.query(
              `UPDATE team_room_assignments 
               SET is_active = true, 
                   room_number = COALESCE($2, room_number), 
                   checkin_date = COALESCE($3, checkin_date)
               WHERE team_id = $1 AND guest_unique_id = $4
               RETURNING *`,
              [team_id, room_number || null, checkin_date || null, guest_unique_id]
            );
          } else {
            throw conflictError;
          }
        }
      } else {
        // Fallback to room_number + checkin_date
        assignmentResult = await pool.query(
          `INSERT INTO team_room_assignments (team_id, room_number, checkin_date, guest_unique_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (team_id, room_number, checkin_date) 
           DO UPDATE SET is_active = true, guest_unique_id = COALESCE(EXCLUDED.guest_unique_id, team_room_assignments.guest_unique_id)
           RETURNING *`,
          [team_id, room_number, checkin_date, guest_unique_id]
        );
      }
      
      createdAssignments.push(assignmentResult.rows[0]);
      
      // Auto-assign all team assistants to the room (if room_number exists)
      if (room_number) {
        for (const assistantId of assistantIds) {
          await pool.query(
            `INSERT INTO assistant_assignments (assistant_id, room_number, is_active)
             VALUES ($1, $2, true)
             ON CONFLICT (assistant_id, room_number) 
             DO UPDATE SET is_active = true`,
            [assistantId, room_number]
          );
        }
      }
      
      // Notify all team assistants to join the room via Socket.IO (if room_number exists)
      if (room_number && checkin_date) {
        io.emit('auto_join_room', {
          roomNumber: room_number,
          checkinDate: checkin_date,
          teamId: team_id,
          assistantIds: assistantIds
        });
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

// Generate or get team invite QR code
app.get('/api/teams/:teamId/invite', async (req, res) => {
  try {
    const { teamId } = req.params;
    
    // Check if active invite exists
    const existingInvite = await pool.query(`
      SELECT invite_token, qr_code_url, created_at, expires_at
      FROM team_invites
      WHERE team_id = $1 
        AND is_active = true 
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        AND used_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `, [teamId]);
    
    if (existingInvite.rows.length > 0) {
      const invite = existingInvite.rows[0];
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const inviteLink = `${frontendUrl}/join-team?token=${invite.invite_token}`;
      
      return res.json({
        inviteToken: invite.invite_token,
        qrCodeUrl: invite.qr_code_url,
        inviteLink,
        expiresAt: invite.expires_at,
        createdAt: invite.created_at
      });
    }
    
    // Create new invite
    const inviteToken = randomBytes(32).toString('hex');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviteLink = `${frontendUrl}/join-team?token=${inviteToken}`;
    
    // Generate QR code
    const qrCodeDataUrl = await QRCode.toDataURL(inviteLink, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    
    // Save to database (7 days expiry)
    const result = await pool.query(`
      INSERT INTO team_invites (team_id, invite_token, qr_code_url, expires_at)
      VALUES ($1, $2, $3, $4)
      RETURNING id, created_at
    `, [
      teamId,
      inviteToken,
      qrCodeDataUrl,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    ]);
    
    res.json({
      inviteToken,
      qrCodeUrl: qrCodeDataUrl,
      inviteLink,
      expiresAt: result.rows[0].created_at,
      createdAt: result.rows[0].created_at
    });
  } catch (error) {
    console.error('Error generating team invite:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Join team via invite token
app.post('/api/teams/join', async (req, res) => {
  try {
    const { token, assistant_id } = req.body;
    
    if (!token || !assistant_id) {
      return res.status(400).json({ error: 'Token ve assistant_id gereklidir' });
    }
    
    // Find invite token
    const inviteResult = await pool.query(`
      SELECT team_id, expires_at, used_at, is_active
      FROM team_invites
      WHERE invite_token = $1
    `, [token]);
    
    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Geçersiz token' });
    }
    
    const { team_id, expires_at, used_at, is_active } = inviteResult.rows[0];
    
    if (!is_active) {
      return res.status(410).json({ error: 'Bu davet artık aktif değil' });
    }
    
    if (expires_at && new Date(expires_at) < new Date()) {
      return res.status(410).json({ error: 'Token süresi dolmuş' });
    }
    
    // Check if assistant already in team
    const existingMembership = await pool.query(`
      SELECT id FROM assistant_teams
      WHERE assistant_id = $1 AND team_id = $2
    `, [assistant_id, team_id]);
    
    if (existingMembership.rows.length > 0) {
      // Already in team, just activate
      await pool.query(`
        UPDATE assistant_teams SET is_active = true
        WHERE assistant_id = $1 AND team_id = $2
      `, [assistant_id, team_id]);
      
      return res.json({ 
        success: true, 
        team_id,
        message: 'Zaten bu takımdasınız',
        already_member: true
      });
    }
    
    // Add assistant to team
    await pool.query(`
      INSERT INTO assistant_teams (assistant_id, team_id, is_active)
      VALUES ($1, $2, true)
      ON CONFLICT (assistant_id, team_id) 
      DO UPDATE SET is_active = true
    `, [assistant_id, team_id]);
    
    console.log(`✅ Assistant ${assistant_id} joined team ${team_id} via token`);
    
    res.json({ 
      success: true, 
      team_id,
      message: 'Takıma başarıyla katıldınız'
    });
  } catch (error) {
    console.error('Error joining team:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

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
      `SELECT room_number, guest_name, guest_surname, checkin_date 
       FROM rooms 
       WHERE checkin_date = $1::date`,
      [yesterdayStr]
    );
    
    // Update each room with new guest_unique_id
    for (const room of roomsToUpdate.rows) {
      const guest_unique_id = generateGuestUniqueId(room.guest_name, room.guest_surname, todayStr);
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
    const { date } = req.query; // Optional: filter by date (default: today)
    
    const checkinDate = date || new Date().toISOString().split('T')[0];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    
    // Get rooms assigned to assistant's teams with last message info
    // Use GROUP BY instead of DISTINCT to allow ORDER BY with expressions
    const result = await pool.query(`
      SELECT 
        r.id,
        r.room_number,
        r.guest_name,
        r.guest_surname,
        r.checkin_date,
        r.checkout_date,
        r.is_active,
        r.adult_count,
        r.child_count,
        r.country,
        r.agency,
        MAX(tra.assigned_at) as assigned_at,
        (
          SELECT m.message 
          FROM messages m 
          WHERE m.room_number = r.room_number 
            AND (m.checkin_date = r.checkin_date OR (m.checkin_date IS NULL AND r.checkin_date IS NULL))
          ORDER BY m.timestamp DESC 
          LIMIT 1
        ) as last_message,
        (
          SELECT m.timestamp 
          FROM messages m 
          WHERE m.room_number = r.room_number 
            AND (m.checkin_date = r.checkin_date OR (m.checkin_date IS NULL AND r.checkin_date IS NULL))
          ORDER BY m.timestamp DESC 
          LIMIT 1
        ) as last_message_time,
        COALESCE((
          SELECT COUNT(*)::INTEGER
          FROM messages m 
          WHERE m.room_number = r.room_number 
            AND (m.checkin_date = r.checkin_date OR (m.checkin_date IS NULL AND r.checkin_date IS NULL))
            AND m.sender_type NOT IN ('assistant', 'staff')
            AND m.read_at IS NULL
        ), 0) as unread_count,
        COALESCE((
          SELECT m.timestamp 
          FROM messages m 
          WHERE m.room_number = r.room_number 
            AND (m.checkin_date = r.checkin_date OR (m.checkin_date IS NULL AND r.checkin_date IS NULL))
          ORDER BY m.timestamp DESC 
          LIMIT 1
        ), r.checkin_date) as sort_timestamp
      FROM rooms r
      INNER JOIN team_room_assignments tra ON r.room_number = tra.room_number 
        AND r.checkin_date = tra.checkin_date
      INNER JOIN assistant_teams at ON tra.team_id = at.team_id
      WHERE at.assistant_id = $1 
        AND at.is_active = true
        AND tra.is_active = true
        AND r.checkin_date = $2
        AND r.is_active = true
        AND (
          r.checkout_date IS NULL 
          OR (r.checkout_date + INTERVAL '1 day') >= $3::date
        )
      GROUP BY 
        r.id,
        r.room_number,
        r.guest_name,
        r.guest_surname,
        r.checkin_date,
        r.checkout_date,
        r.is_active,
        r.adult_count,
        r.child_count,
        r.country,
        r.agency
      ORDER BY 
        sort_timestamp DESC,
        r.room_number ASC
    `, [assistantId, checkinDate, todayStr]);
    
    console.log(`📋 Assistant ${assistantId} rooms for ${checkinDate}:`, result.rows.length);
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

// Create invite and generate QR code for a room
app.post('/api/assistant/:assistantId/rooms/:roomNumber/invite', async (req, res) => {
  try {
    const { assistantId, roomNumber } = req.params;
    const { checkin_date } = req.body; // Get checkin_date from request body
    
    // Verify assistant has access to this room through team assignment
    const assignmentCheck = await pool.query(`
      SELECT r.checkin_date, r.checkout_date
      FROM rooms r
      INNER JOIN team_room_assignments tra ON r.room_number = tra.room_number 
        AND r.checkin_date = tra.checkin_date
      INNER JOIN assistant_teams at ON tra.team_id = at.team_id
      WHERE at.assistant_id = $1 
        AND r.room_number = $2
        AND at.is_active = true
        AND tra.is_active = true
        AND r.is_active = true
        AND ($3::date IS NULL OR r.checkin_date = $3::date)
      LIMIT 1
    `, [assistantId, roomNumber, checkin_date || null]);
    
    if (assignmentCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Assistant does not have access to this room' });
    }
    
    const roomCheckinDate = checkin_date || assignmentCheck.rows[0].checkin_date;
    
    // Generate unique token
    const inviteToken = randomBytes(32).toString('hex');
    
    // Create invite link with checkin_date if available
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    let inviteLink = `${frontendUrl}/join?token=${inviteToken}`;
    if (roomCheckinDate) {
      inviteLink += `&checkin_date=${roomCheckinDate}`;
    }
    
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
      expiresAt: result.rows[0].created_at,
      checkinDate: roomCheckinDate
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

// Initialize test data (rooms with random check-ins for next 10 days)
async function initializeTestData() {
  try {
    // Skip if ENABLE_TEST_DATA is not set to 'true'
    if (process.env.ENABLE_TEST_DATA !== 'true') {
      console.log('ℹ️ Test data initialization skipped (ENABLE_TEST_DATA not set to "true")');
      return;
    }
    
    console.log('🔄 Starting test data initialization...');
    
    // Random data pools
    const firstNames = [
      'Ali', 'Ayşe', 'Mehmet', 'Zeynep', 'Can', 'Lena', 'John', 'Maria', 'David', 'Anna',
      'Michael', 'Sarah', 'James', 'Emma', 'Robert', 'Olivia', 'William', 'Sophia', 'Richard', 'Isabella',
      'Thomas', 'Charlotte', 'Charles', 'Amelia', 'Joseph', 'Mia', 'Daniel', 'Harper', 'Matthew', 'Evelyn',
      'Mark', 'Abigail', 'Donald', 'Emily', 'Steven', 'Elizabeth', 'Paul', 'Sofia', 'Andrew', 'Avery',
      'Joshua', 'Ella', 'Kenneth', 'Madison', 'Kevin', 'Scarlett', 'Brian', 'Victoria', 'George', 'Aria'
    ];
    
    const lastNames = [
      'Yılmaz', 'Demir', 'Kaya', 'Şahin', 'Özkan', 'Podorozhna', 'Smith', 'Johnson', 'Williams', 'Brown',
      'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Wilson', 'Anderson',
      'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White', 'Harris', 'Sanchez',
      'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott',
      'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera'
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
      assistantId = existing.rows[0]?.id;
    }
    
    // Generate random check-ins for next 10 days
    const today = new Date();
    const inserts = [];
    
    for (let day = 0; day < 10; day++) {
      const checkinDate = new Date(today);
      checkinDate.setDate(today.getDate() + day);
      const checkinDateStr = checkinDate.toISOString().split('T')[0];
      
      // Random number of check-ins per day (3-8)
      const checkinsPerDay = Math.floor(Math.random() * 6) + 3;
      
      for (let i = 0; i < checkinsPerDay; i++) {
        // Random room number
        const roomNumber = roomNumbers[Math.floor(Math.random() * roomNumbers.length)];
        
        // Random guest data
        const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
        const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
        const adultCount = Math.floor(Math.random() * 3) + 1; // 1-3 adults
        const childCount = Math.random() > 0.6 ? Math.floor(Math.random() * 3) : 0; // 40% chance of children
        const country = countries[Math.floor(Math.random() * countries.length)];
        const agency = agencies[Math.floor(Math.random() * agencies.length)];
        
        // Checkout date (1-7 days after checkin)
        const checkoutDate = new Date(checkinDate);
        checkoutDate.setDate(checkinDate.getDate() + Math.floor(Math.random() * 7) + 1);
        const checkoutDateStr = checkoutDate.toISOString().split('T')[0];
        
        inserts.push({
          roomNumber,
          firstName,
          lastName,
          checkinDateStr,
          checkoutDateStr,
          adultCount,
          childCount,
          agency,
          country
        });
      }
    }
    
    // Batch insert - process in chunks of 50 to avoid query size limits
    const chunkSize = 50;
    let totalInserted = 0;
    
    for (let i = 0; i < inserts.length; i += chunkSize) {
      const chunk = inserts.slice(i, i + chunkSize);
      
      const values = chunk.map((_, idx) => {
        const base = idx * 10;
        return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8}, $${base+9}, $${base+10}, true)`;
      }).join(', ');
      
      const params = chunk.flatMap(ins => {
        const guest_unique_id = generateGuestUniqueId(ins.firstName, ins.lastName, ins.checkinDateStr);
        return [
          ins.roomNumber, ins.firstName, ins.lastName, ins.checkinDateStr,
          ins.checkoutDateStr, ins.adultCount, ins.childCount, ins.agency, ins.country, guest_unique_id
        ];
      });
      
      try {
        const result = await pool.query(`
          INSERT INTO rooms (
            room_number, guest_name, guest_surname, checkin_date, 
            checkout_date, adult_count, child_count, agency, country, guest_unique_id, is_active
          )
          VALUES ${values}
          ON CONFLICT (room_number, checkin_date) DO NOTHING
        `, params);
        
        totalInserted += result.rowCount || 0;
      } catch (error) {
        console.error(`⚠️ Error inserting chunk ${i / chunkSize + 1}:`, error.message);
      }
    }
    
    // Count actual check-ins created
    const result = await pool.query(`
      SELECT COUNT(*) as count 
      FROM rooms 
      WHERE checkin_date >= CURRENT_DATE 
        AND checkin_date <= CURRENT_DATE + INTERVAL '10 days'
    `);
    
    const actualCount = parseInt(result.rows[0].count);
    console.log(`✅ Test data initialization completed: ${actualCount} check-ins found for next 10 days`);
    console.log(`📊 Attempted to insert: ${inserts.length}, Actually inserted: ${totalInserted}`);
  } catch (error) {
    console.error('❌ Error initializing test data:', error);
  }
}

// Initialize database and start server
initializeDatabase().then(() => {
  // Server will start immediately, test data will initialize in background
  console.log('✅ Database initialized, starting server...');
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
  
  // Initialize test data in background (non-blocking, after server starts)
  // This prevents blocking Render deploy
  setTimeout(() => {
    initializeTestData().catch(err => {
      console.error('⚠️ Test data initialization failed (non-critical):', err.message);
    });
  }, 3000); // Wait 3 seconds after server starts
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
