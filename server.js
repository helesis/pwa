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

      -- Team-Room eşleştirmesi (check-in date'e göre)
      CREATE TABLE IF NOT EXISTS team_room_assignments (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        room_number VARCHAR(50) NOT NULL,
        checkin_date DATE NOT NULL,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(team_id, room_number, checkin_date)
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
        console.log('⚠️ message_delivered: Message not found or already delivered:', messageId);
        return;
      }
      
      console.log('✅ Message marked as delivered:', messageId);
      
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
        
        console.log('📤 Broadcasting message_status_update to room:', roomId, { 
          messageId, 
          status: 'delivered',
          room_number,
          checkin_date: checkinDateStr
        });
        
        // Get all sockets in this room for debugging
        const roomSockets = await io.in(roomId).fetchSockets();
        console.log(`📊 Room ${roomId} has ${roomSockets.length} connected clients`);
        
        // Broadcast status update to room (sender will see delivered tick)
        io.to(roomId).emit('message_status_update', { 
          messageId, 
          status: 'delivered' 
        });
        
        console.log('✅ message_status_update broadcasted to room:', roomId);
      } else {
        console.log('⚠️ message_delivered: Message info not found for messageId:', messageId);
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
        
        console.log('📤 Broadcasting message_status_update (read) to room:', roomId, { 
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
        
        console.log('✅ message_status_update (read) broadcasted to room:', roomId);
      }
    } catch (error) {
      console.error('Error updating read status:', error);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('🔴 ========== CLIENT DISCONNECTED ==========');
    console.log('🔴 Socket ID:', socket.id);
    console.log('🔴 Reason:', reason);
    console.log('🔴 Time:', new Date().toISOString());
  });
});

// REST API Endpoints

// Get all active rooms (with optional date range filter)
app.get('/api/rooms', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    console.log('🏨 GET /api/rooms - start_date:', start_date, 'end_date:', end_date);
    
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
      console.log('🔍 No date filter, returning all active rooms');
    }
    
    console.log('📊 Executing query:', query);
    console.log('📊 Query params:', params);
    
    const result = await pool.query(query, params);
    console.log('✅ Found', result.rows.length, 'rooms');
    if (result.rows.length > 0) {
      console.log('📋 Sample rooms:', result.rows.slice(0, 3).map(r => ({
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
    
    console.log('📸 Saving profile photo for room:', roomNumber);
    console.log('📸 Photo data length:', profilePhoto ? profilePhoto.length : 0);
    
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

// Get all assistants
app.get('/api/assistants', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM assistants ORDER BY name');
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
    const { name, email } = req.body;
    const result = await pool.query(
      'INSERT INTO assistants (name, email) VALUES ($1, $2) RETURNING *',
      [name, email || null]
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
    const { name, email } = req.body;
    const result = await pool.query(
      'UPDATE assistants SET name = $1, email = $2 WHERE id = $3 RETURNING *',
      [name, email || null, req.params.id]
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
    const result = await pool.query('SELECT * FROM teams ORDER BY name');
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
    const { name, description, assistant_ids } = req.body;
    
    // Create team
    const teamResult = await pool.query(
      'INSERT INTO teams (name, description) VALUES ($1, $2) RETURNING *',
      [name, description || null]
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
    const { name, description, assistant_ids } = req.body;
    
    // Update team
    const teamResult = await pool.query(
      'UPDATE teams SET name = $1, description = $2 WHERE id = $3 RETURNING *',
      [name, description || null, req.params.id]
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
        t.name as team_name,
        r.guest_name,
        r.guest_surname
      FROM team_room_assignments tra
      INNER JOIN teams t ON tra.team_id = t.id
      LEFT JOIN rooms r ON tra.room_number = r.room_number AND tra.checkin_date = r.checkin_date
      WHERE tra.is_active = true
    `;
    const params = [];
    
    if (checkin_date) {
      console.log('🔍 Filtering by checkin_date:', checkin_date);
      query += ' AND tra.checkin_date = $1';
      params.push(checkin_date);
    }
    
    query += ' ORDER BY tra.checkin_date DESC, tra.room_number';
    
    console.log('📊 Executing query:', query);
    console.log('📊 Query params:', params);
    
    const result = await pool.query(query, params);
    console.log('✅ Found', result.rows.length, 'assignments');
    console.log('📋 Assignments:', result.rows);
    
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
      const { room_number, checkin_date } = assignment;
      
      // Create team-room assignment
      const assignmentResult = await pool.query(
        `INSERT INTO team_room_assignments (team_id, room_number, checkin_date)
         VALUES ($1, $2, $3)
         ON CONFLICT (team_id, room_number, checkin_date) 
         DO UPDATE SET is_active = true
         RETURNING *`,
        [team_id, room_number, checkin_date]
      );
      
      createdAssignments.push(assignmentResult.rows[0]);
      
      // Auto-assign all team assistants to the room
      for (const assistantId of assistantIds) {
        await pool.query(
          `INSERT INTO assistant_assignments (assistant_id, room_number, is_active)
           VALUES ($1, $2, true)
           ON CONFLICT (assistant_id, room_number) 
           DO UPDATE SET is_active = true`,
          [assistantId, room_number]
        );
      }
      
      // Notify all team assistants to join the room via Socket.IO
      // Broadcast to all connected clients (assistants will filter on frontend)
      io.emit('auto_join_room', {
        roomNumber: room_number,
        checkinDate: checkin_date,
        teamId: team_id,
        assistantIds: assistantIds
      });
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
    
    // Update checkin_date to today
    const updateResult = await pool.query(
      `UPDATE rooms 
       SET checkin_date = $1::date 
       WHERE checkin_date = $2::date 
       RETURNING room_number, guest_name, checkin_date`,
      [todayStr, yesterdayStr]
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

// Initialize test data (rooms with random check-ins for next 10 days)
async function initializeTestData() {
  try {
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
      assistantId = existing.rows[0].id;
    }
    
    // Generate random check-ins for next 10 days
    const today = new Date();
    const roomsCreated = [];
    
    for (let day = 0; day < 10; day++) {
      const checkinDate = new Date(today);
      checkinDate.setDate(today.getDate() + day);
      const checkinDateStr = checkinDate.toISOString().split('T')[0];
      
      // Random number of check-ins per day (3-8)
      const checkinsPerDay = Math.floor(Math.random() * 6) + 3;
      
      for (let i = 0; i < checkinsPerDay; i++) {
        // Random room number
        const roomNumber = roomNumbers[Math.floor(Math.random() * roomNumbers.length)];
        
        // Check if room already has a check-in on this date
        const existingCheck = await pool.query(
          'SELECT id FROM rooms WHERE room_number = $1 AND checkin_date = $2',
          [roomNumber, checkinDateStr]
        );
        
        if (existingCheck.rows.length > 0) {
          continue; // Skip if room already has check-in on this date
        }
        
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
        
        // Create room with unique constraint on (room_number, checkin_date)
        // Since room_number is UNIQUE, we need to handle this differently
        // We'll use a composite key approach or allow multiple rooms with same number but different dates
        try {
          await pool.query(`
            INSERT INTO rooms (
              room_number, 
              guest_name, 
              guest_surname, 
              checkin_date, 
              checkout_date, 
              adult_count,
              child_count,
              agency,
              country,
              is_active
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
            ON CONFLICT (room_number, checkin_date) 
            DO UPDATE SET 
              guest_name = EXCLUDED.guest_name,
              guest_surname = EXCLUDED.guest_surname,
              checkout_date = EXCLUDED.checkout_date,
              adult_count = EXCLUDED.adult_count,
              child_count = EXCLUDED.child_count,
              agency = EXCLUDED.agency,
              country = EXCLUDED.country,
              is_active = true
          `, [
            roomNumber,
            firstName,
            lastName,
            checkinDateStr,
            checkoutDateStr,
            adultCount,
            childCount,
            agency,
            country
          ]);
          
          roomsCreated.push({ roomNumber, checkinDate: checkinDateStr, guest: `${firstName} ${lastName}` });
        } catch (error) {
          // If room_number conflict, try with different room number
          console.log(`⚠️ Room ${roomNumber} conflict for ${checkinDateStr}, skipping...`);
        }
      }
    }
    
    console.log(`✅ Test data initialized: ${roomsCreated.length} check-ins created for next 10 days`);
    console.log(`📊 Check-ins per day:`, roomsCreated.reduce((acc, r) => {
      acc[r.checkinDate] = (acc[r.checkinDate] || 0) + 1;
      return acc;
    }, {}));
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
