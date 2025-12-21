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
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        tone_sentiment VARCHAR(20),
        tone_urgency VARCHAR(20),
        tone_category VARCHAR(50)
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_number VARCHAR(50) UNIQUE NOT NULL,
        guest_name VARCHAR(100),
        checkin_date DATE,
        checkout_date DATE,
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS tone_alerts (
        id SERIAL PRIMARY KEY,
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        room_number VARCHAR(50),
        sentiment VARCHAR(20),
        urgency VARCHAR(20),
        alert_sent BOOLEAN DEFAULT false,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room_number ON messages(room_number);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_tone_alerts_room_number ON tone_alerts(room_number);
    `);
    
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  }
}

// Initialize on startup
initializeDatabase().catch(console.error);

// Claude API Tone Analysis
async function analyzeToneWithClaude(message) {
  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
  
  if (!CLAUDE_API_KEY) {
    console.log('⚠️  Claude API key not found, using fallback analysis');
    return analyzeToneFallback(message);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Aşağıdaki otel müşteri mesajını analiz et ve sadece JSON formatında döndür:

Mesaj: "${message}"

Döndür:
{
  "sentiment": "positive/neutral/negative",
  "urgency": "low/medium/high/critical",
  "category": "kategori (örn: teknik sorun, room service, genel soru)",
  "alert_manager": true/false,
  "reason": "kısa açıklama"
}`
        }]
      })
    });

    const data = await response.json();
    const content = data.content[0].text;
    
    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      console.log('🎯 Claude Analysis:', analysis);
      return analysis;
    }
    
    throw new Error('No JSON in response');
    
  } catch (error) {
    console.error('Claude API error:', error.message);
    return analyzeToneFallback(message);
  }
}

// Fallback tone analysis (keyword-based)
function analyzeToneFallback(message) {
  const lowerMessage = message.toLowerCase();
  
  const negativeTriggers = [
    'çalışmıyor', 'kötü', 'berbat', 'rezalet', 'şikayet', 
    'kızgınım', 'yetersiz', 'bekliyorum', 'saattir', 'kimse',
    'hiç', 'asla', 'problem', 'sorun', 'arızalı'
  ];
  
  const urgentTriggers = [
    'acil', 'hemen', 'şimdi', 'derhal', 'çabuk',
    'saattir', 'gün', 'hafta'
  ];
  
  const positiveTriggers = [
    'teşekkür', 'harika', 'mükemmel', 'güzel', 'süper',
    'muhteşem', 'çok iyi', 'beğendik', 'memnun'
  ];

  const technicalTriggers = [
    'klima', 'tv', 'internet', 'wifi', 'duş', 'musluk',
    'elektrik', 'ışık', 'su', 'soğuk', 'sıcak'
  ];

  let sentiment = 'neutral';
  let urgency = 'medium';
  let category = 'genel soru';
  let alert = false;

  // Check sentiment
  const negativeCount = negativeTriggers.filter(t => lowerMessage.includes(t)).length;
  const positiveCount = positiveTriggers.filter(t => lowerMessage.includes(t)).length;
  
  if (negativeCount > 0) {
    sentiment = 'negative';
    alert = true;
  } else if (positiveCount > 0) {
    sentiment = 'positive';
  }

  // Check urgency
  const urgentCount = urgentTriggers.filter(t => lowerMessage.includes(t)).length;
  if (urgentCount > 1 || negativeCount > 2) {
    urgency = 'critical';
    alert = true;
  } else if (urgentCount > 0 || negativeCount > 0) {
    urgency = 'high';
  } else if (positiveCount > 0) {
    urgency = 'low';
  }

  // Check category
  if (technicalTriggers.some(t => lowerMessage.includes(t))) {
    category = 'teknik sorun';
  } else if (lowerMessage.includes('servis') || lowerMessage.includes('yemek')) {
    category = 'room service';
  } else if (lowerMessage.includes('rezervasyon') || lowerMessage.includes('oda')) {
    category = 'rezervasyon';
  }

  return {
    sentiment,
    urgency,
    category,
    alert_manager: alert,
    reason: `${negativeCount} negatif kelime, ${urgentCount} aciliyet göstergesi`
  };
}

// Socket.IO Connection
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Join room
  socket.on('join_room', async (roomNumber) => {
    socket.join(roomNumber);
    console.log(`👤 Client joined room: ${roomNumber}`);
    
    try {
      // Send chat history
      const result = await pool.query(`
        SELECT * FROM messages 
        WHERE room_number = $1 
        ORDER BY timestamp ASC 
        LIMIT 50
      `, [roomNumber]);
      
      socket.emit('chat_history', result.rows);
    } catch (error) {
      console.error('Error loading chat history:', error);
      socket.emit('chat_history', []);
    }
  });

  // New message
  socket.on('send_message', async (data) => {
    console.log('📨 Message received:', data);
    
    const { roomNumber, senderType, senderName, message } = data;
    
    try {
      // Analyze tone (only for guest messages)
      let toneAnalysis = null;
      if (senderType === 'guest') {
        toneAnalysis = await analyzeToneWithClaude(message);
      }
      
      // Save to database
      const result = await pool.query(`
        INSERT INTO messages (room_number, sender_type, sender_name, message, tone_sentiment, tone_urgency, tone_category)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, timestamp
      `, [
        roomNumber,
        senderType,
        senderName,
        message,
        toneAnalysis?.sentiment || null,
        toneAnalysis?.urgency || null,
        toneAnalysis?.category || null
      ]);
      
      const messageId = result.rows[0].id;
      const timestamp = result.rows[0].timestamp;
      
      // Create alert if needed
      if (toneAnalysis && toneAnalysis.alert_manager) {
        await pool.query(`
          INSERT INTO tone_alerts (message_id, room_number, sentiment, urgency)
          VALUES ($1, $2, $3, $4)
        `, [messageId, roomNumber, toneAnalysis.sentiment, toneAnalysis.urgency]);
        
        console.log('🚨 ALERT: Negative tone detected!');
        
        // Emit alert to managers
        io.emit('tone_alert', {
          messageId,
          roomNumber,
          message,
          sentiment: toneAnalysis.sentiment,
          urgency: toneAnalysis.urgency,
          category: toneAnalysis.category,
          timestamp: new Date().toISOString()
        });
      }
      
      // Broadcast message
      const messageData = {
        id: messageId,
        roomNumber,
        senderType,
        senderName,
        message,
        timestamp: timestamp.toISOString(),
        toneAnalysis
      };
      
      io.to(roomNumber).emit('new_message', messageData);
      
      // Send tone analysis separately
      if (toneAnalysis) {
        socket.emit('tone_analysis', {
          messageId,
          ...toneAnalysis
        });
      }
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
    
    res.json(result.rows.reverse());
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get tone alerts
app.get('/api/alerts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        a.*,
        m.message,
        m.sender_name,
        r.guest_name
      FROM tone_alerts a
      LEFT JOIN messages m ON a.message_id = m.id
      LEFT JOIN rooms r ON a.room_number = r.room_number
      ORDER BY a.timestamp DESC
      LIMIT 50
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Mark alert as sent
app.post('/api/alerts/:id/sent', async (req, res) => {
  try {
    await pool.query('UPDATE tone_alerts SET alert_sent = true WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating alert:', error);
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

// Dashboard stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalMessages = await pool.query('SELECT COUNT(*) as count FROM messages');
    const activeRooms = await pool.query('SELECT COUNT(*) as count FROM rooms WHERE is_active = true');
    const pendingAlerts = await pool.query('SELECT COUNT(*) as count FROM tone_alerts WHERE alert_sent = false');
    
    const sentimentStats = await pool.query(`
      SELECT 
        tone_sentiment,
        COUNT(*) as count
      FROM messages
      WHERE tone_sentiment IS NOT NULL
      GROUP BY tone_sentiment
    `);
    
    res.json({
      totalMessages: parseInt(totalMessages.rows[0].count),
      activeRooms: parseInt(activeRooms.rows[0].count),
      pendingAlerts: parseInt(pendingAlerts.rows[0].count),
      sentimentStats: sentimentStats.rows
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Test tone analysis endpoint
app.post('/api/test/tone', async (req, res) => {
  try {
    const { message } = req.body;
    const analysis = await analyzeToneWithClaude(message);
    res.json(analysis);
  } catch (error) {
    console.error('Error analyzing tone:', error);
    res.status(500).json({ error: 'Analysis error' });
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
  console.log('   ✅ Tone Analysis: Claude AI');
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
