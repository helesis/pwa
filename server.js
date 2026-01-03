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
    // Drop all existing tables in correct order (respecting foreign keys)
    console.log('🗑️ Dropping existing tables...');
    await pool.query(`
      DROP TABLE IF EXISTS messages CASCADE;
      DROP TABLE IF EXISTS team_room_assignments CASCADE;
      DROP TABLE IF EXISTS assistant_teams CASCADE;
      DROP TABLE IF EXISTS assistant_assignments CASCADE;
      DROP TABLE IF EXISTS room_invites CASCADE;
      DROP TABLE IF EXISTS team_invites CASCADE;
      DROP TABLE IF EXISTS rooms CASCADE;
      DROP TABLE IF EXISTS assistants CASCADE;
      DROP TABLE IF EXISTS teams CASCADE;
    `);
    console.log('✅ All tables dropped');
    
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
      logDebug('📊 Fetching chat history for guest_unique_id:', guestUniqueId);
      // Send chat history (last 50 messages) filtered by guest_unique_id
      const result = await pool.query(`
        SELECT m.*, a.name as assistant_name, a.surname as assistant_surname, a.avatar as assistant_avatar
        FROM messages m
        LEFT JOIN assistants a ON m.assistant_id = a.id
        WHERE m.guest_unique_id = $1
        ORDER BY m.timestamp DESC 
          LIMIT 50
      `, [guestUniqueId]);
      
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
      console.log('✅ Message saved to database:', { messageId, timestamp });
      
      // Use guest_unique_id for room ID
      const roomId = `guest_${guestUniqueId}`;
      
      console.log('📡 ========== BROADCASTING MESSAGE ==========');
      console.log('📡 Room ID:', roomId);
      
      // Check how many clients are in this room
      const room = io.sockets.adapter.rooms.get(roomId);
      const roomSize = room ? room.size : 0;
      console.log('📡 Clients in room:', roomSize);
      if (room) {
        console.log('📡 Socket IDs in room:', Array.from(room));
      }
      
      // Broadcast message with status
      const messageData = {
        id: messageId,
        guestUniqueId: guestUniqueId,
        senderType,
        senderName: actualSenderName,
        assistantId: actualAssistantId,
        message,
        timestamp: timestamp.toISOString(),
        status: 'sent', // Initial status: sent
        deliveredAt: null,
        readAt: null
      };
      
      console.log('📡 Message data to broadcast:', {
        id: messageData.id,
        guestUniqueId: messageData.guestUniqueId,
        senderType: messageData.senderType,
        senderName: messageData.senderName,
        assistantId: messageData.assistantId,
        messageLength: messageData.message?.length
      });
      
      // Send confirmation to sender first
      socket.emit('message_sent', { messageId, status: 'sent' });
      console.log('✅ message_sent confirmation sent to sender');
      
      // Broadcast to room (other users will mark as delivered when received)
      io.to(roomId).emit('new_message', messageData);
      console.log('✅ new_message broadcasted to room:', roomId);
      console.log('📡 ========== BROADCAST COMPLETE ==========');
    } catch (error) {
      console.error('❌ Error saving message:', error);
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

// Get current guest info (for session check)
app.get('/api/guest/me', async (req, res) => {
  try {
    const guestUniqueId = req.cookies?.guest_unique_id;
    
    if (!guestUniqueId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    // Find guest by unique_id
    const result = await pool.query(`
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
    `, [guestUniqueId]);
    
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
        team_name: guest.team_name || null
      }
    });
  } catch (error) {
    console.error('Error getting guest info:', error);
    res.status(500).json({ success: false, error: 'Database error' });
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
        
        console.log(`✅ Generated and saved guest_unique_id for guest: ${guest_unique_id}`);
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
      [name, surname || null, spoken_languages || null, avatar || null]
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
    // Always update avatar - if empty string or null, set to null
    const avatarValue = avatar || null;
    const result = await pool.query(
      'UPDATE assistants SET name = $1, surname = $2, spoken_languages = $3, avatar = $4 WHERE id = $5 RETURNING *',
      [name, surname || null, spoken_languages || null, avatarValue, req.params.id]
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
    console.log('📋 GET /api/team-assignments - checkin_date:', checkin_date);
    
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
      console.log('🔍 Filtering by checkin_date:', checkin_date);
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
          console.log('✅ Updated room table with guest_unique_id:', guest_unique_id);
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
        sort_timestamp DESC,
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
initializeDatabase().then(() => {
  console.log('✅ Database initialized, starting server...');
  console.log('ℹ️ Test verisi oluşturmak için: /test-data.html sayfasını ziyaret edin');
}).catch(console.error);

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
  console.log('ℹ️ Test verisi oluşturmak için: /test-data.html sayfasını ziyaret edin');
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
