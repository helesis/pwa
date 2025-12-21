# 🏨 Voyage Sorgun Chat System

Gerçek zamanlı tone analizi ile akıllı otel müşteri iletişim sistemi.

## ✨ Özellikler

### 🎯 Tone Analizi (Claude AI)
- Gerçek zamanlı mesaj analizi
- Negatif/Nötr/Pozitif sentiment tespiti
- Aciliyet seviyesi belirleme
- Kategori sınıflandırma (teknik sorun, room service, vb.)
- Otomatik yönetici bildirimi

### 💬 Real-time Messaging
- WebSocket (Socket.IO) ile anlık iletişim
- Yazma göstergesi (typing indicator)
- Mesaj okundu/iletildi durumu
- Mesaj geçmişi
- Çoklu kullanıcı desteği

### 📊 Database
- PostgreSQL (production-ready)
- Mesaj kayıtları
- Oda yönetimi
- Tone alert geçmişi
- İstatistikler
- Connection pooling

### 📱 PWA (Progressive Web App)
- Ana ekrana eklenebilir
- Offline çalışabilir
- Push notification
- Tam ekran mod
- iOS ve Android uyumlu

### 🔔 Bildirimler
- Gerçek push notification
- Yönetici alert sistemi
- Slack entegrasyonu (opsiyonel)
- Email alert (opsiyonel)

## 🚀 Kurulum

### Gereksinimler

- Node.js 18+ 
- npm veya yarn
- PostgreSQL (local veya Render'da)
- Claude API Key ([console.anthropic.com](https://console.anthropic.com/))

### Adım 1: Projeyi İndir

```bash
# Bu dosyaları bir klasöre kaydedin
mkdir voyage-chat
cd voyage-chat
```

### Adım 2: Dependencies Yükle

```bash
npm install
```

### Adım 3: Konfigürasyon

`.env` dosyası oluşturun:

```bash
cp .env.example .env
```

`.env` dosyasını düzenleyin:

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/voyage_chat
CLAUDE_API_KEY=your_actual_api_key_here
FRONTEND_URL=http://localhost:3000
```

**PostgreSQL Kurulumu (Local):**
- macOS: `brew install postgresql@14 && brew services start postgresql@14`
- Linux: `sudo apt-get install postgresql postgresql-contrib`
- Windows: [PostgreSQL installer](https://www.postgresql.org/download/windows/)

Database oluşturun:
```bash
createdb voyage_chat
```

Claude API Key almak için:
1. https://console.anthropic.com/ adresine gidin
2. API Keys bölümünden yeni key oluşturun
3. Key'i `.env` dosyasına yapıştırın

### Adım 4: Serveri Başlat

```bash
npm start
```

Ya da development modunda (auto-restart):

```bash
npm run dev
```

### Adım 5: Tarayıcıda Aç

```
http://localhost:3000
```

## 📱 Mobil Test

### iPhone (Safari)

1. Safari'de `http://localhost:3000` açın
2. Paylaş butonuna tıklayın
3. "Ana Ekrana Ekle" seçin
4. Uygulama gibi kullanın!

### Android (Chrome)

1. Chrome'da `http://localhost:3000` açın
2. Menü > "Ana ekrana ekle"
3. Uygulama gibi kullanın!

## 🧪 Test

### Tone Analizi Test

**Negatif Mesajlar:**
```
"Klima çalışmıyor, çok kötü bir durum!"
"3 saattir bekliyorum, rezalet!"
"Oda servisi hiç gelmiyor"
```

**Pozitif Mesajlar:**
```
"Harika bir tatil geçiriyoruz, teşekkürler!"
"Çok memnun kaldık, mükemmel hizmet"
"Her şey için teşekkür ederiz"
```

**Nötr Mesajlar:**
```
"Oda servisi menüsü var mı?"
"Check-out saati kaçta?"
"Havuz sıcaklığı kaç derece?"
```

### API Test

```bash
# Tone analizi testi
curl -X POST http://localhost:3000/api/test/tone \
  -H "Content-Type: application/json" \
  -d '{"message":"Klima çalışmıyor, çok kötü!"}'

# İstatistikler
curl http://localhost:3000/api/stats

# Aktif odalar
curl http://localhost:3000/api/rooms

# Alert listesi
curl http://localhost:3000/api/alerts
```

## 📊 API Endpoints

### REST API

```
GET  /api/rooms              - Tüm aktif odalar
GET  /api/rooms/:number      - Oda detayları
GET  /api/messages/:number   - Oda mesajları
GET  /api/alerts             - Tone alert'ler
GET  /api/stats              - İstatistikler
POST /api/rooms              - Yeni oda ekle
POST /api/test/tone          - Tone analizi test
POST /api/alerts/:id/sent    - Alert'i okundu işaretle
```

### WebSocket Events

**Client → Server:**
```javascript
socket.emit('join_room', roomNumber);
socket.emit('send_message', { roomNumber, senderType, senderName, message });
socket.emit('typing', { roomNumber, senderName });
socket.emit('stop_typing', { roomNumber });
```

**Server → Client:**
```javascript
socket.on('chat_history', messages);
socket.on('new_message', messageData);
socket.on('tone_analysis', analysis);
socket.on('tone_alert', alert);
socket.on('user_typing', data);
socket.on('user_stopped_typing');
```

## 🎨 Customization

### Renk Teması Değiştirme

`public/index.html` içinde CSS değişkenlerini düzenleyin:

```css
:root {
    --voyage-navy: #1A4D6D;      /* Ana renk */
    --voyage-blue: #2C6E8F;      /* İkincil renk */
    --voyage-gold: #C9A961;      /* Vurgu rengi */
    --voyage-sand: #F5F1E8;      /* Arka plan */
}
```

### Oda Numarası Dinamik Yapma

`public/index.html` içinde:

```javascript
// URL'den oda numarası al
const urlParams = new URLSearchParams(window.location.search);
const ROOM_NUMBER = urlParams.get('room') || '301';
```

Kullanım: `http://localhost:3000?room=405`

## 📈 Production Deployment

### Option 1: Render.com (Önerilen) ⭐

Detaylı deployment rehberi için [DEPLOY.md](./DEPLOY.md) dosyasına bakın.

**Hızlı Başlangıç:**
1. GitHub'a push edin
2. Render Dashboard → New → Blueprint
3. Repository'nizi seçin (render.yaml otomatik algılanır)
4. PostgreSQL database oluşturun
5. Environment variables ekleyin
6. Deploy!

**Maliyet:** Ücretsiz (Starter plan) veya $7/ay (Standard plan)

### Option 2: Railway.app

1. GitHub'a push edin
2. Railway.app'te "New Project"
3. Repo'yu seçin
4. PostgreSQL database ekleyin
5. Environment variables ekleyin
6. Deploy!

**Maliyet:** ~$5/ay

### Option 3: DigitalOcean

```bash
# VPS'e bağlanın
ssh root@your-server-ip

# Node.js yükleyin
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Projeyi klonlayın
git clone your-repo
cd voyage-chat

# Dependencies
npm install

# PM2 ile servis olarak çalıştırın
npm install -g pm2
pm2 start server.js --name voyage-chat
pm2 startup
pm2 save
```

### Option 3: Vercel (Frontend) + Railway (Backend)

Frontend ve backend'i ayrı deploy edin.

## 🔐 Güvenlik

### Production için:

1. **HTTPS kullanın** (Let's Encrypt)
2. **CORS ayarlayın:**
   ```javascript
   cors: {
     origin: "https://yourdomain.com",
     methods: ["GET", "POST"]
   }
   ```
3. **Rate limiting ekleyin:**
   ```bash
   npm install express-rate-limit
   ```
4. **Environment variables'ı güvenli tutun**
5. **Database şifresi ekleyin** (production'da PostgreSQL kullanın)

## 💰 Maliyet

### Aylık İşletme Maliyeti

| Kalem | Tutar |
|-------|-------|
| Hosting (Railway) | $5-20 |
| Claude API (15K mesaj/ay) | $7-15 |
| Domain | $1 |
| **TOPLAM** | **$13-36/ay** |

**~400-1,100 TL/ay** (WhatsApp API'den 7x daha ucuz!)

## 🐛 Troubleshooting

### Port zaten kullanımda

```bash
# Portu değiştirin
PORT=3001 npm start
```

### Claude API çalışmıyor

```bash
# API key'i kontrol edin
echo $CLAUDE_API_KEY

# Fallback analiz kullanılıyor mu?
# Log'larda "⚠️ Claude API key not found" yazıyorsa
```

### WebSocket bağlanamıyor

```bash
# CORS hatası varsa server.js'de:
cors: {
  origin: "*",  // Geçici olarak
  credentials: true
}
```

### Database hatası

```bash
# PostgreSQL bağlantısını kontrol edin
psql $DATABASE_URL -c "SELECT 1"

# Database tablolarını manuel oluşturun (gerekirse)
psql $DATABASE_URL < schema.sql

# Connection string formatı:
# postgresql://user:password@host:port/database
```

## 📚 İleri Seviye

### Slack Entegrasyonu

```javascript
// server.js'e ekleyin
import axios from 'axios';

async function sendSlackAlert(alert) {
  await axios.post(process.env.SLACK_WEBHOOK_URL, {
    text: `🚨 Oda ${alert.roomNumber}: ${alert.message}`,
    attachments: [{
      color: 'danger',
      fields: [
        { title: 'Ton', value: alert.sentiment },
        { title: 'Aciliyet', value: alert.urgency }
      ]
    }]
  });
}
```

### Email Bildirimi

```bash
npm install nodemailer
```

```javascript
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendEmailAlert(alert) {
  await transporter.sendMail({
    from: 'noreply@voyagesorgun.com',
    to: process.env.ALERT_EMAIL,
    subject: `🚨 Oda ${alert.roomNumber} - ${alert.urgency.toUpperCase()}`,
    text: alert.message
  });
}
```

### PostgreSQL Kullanımı

✅ **Zaten entegre edildi!** Proje artık PostgreSQL kullanıyor.

Database connection otomatik olarak `DATABASE_URL` environment variable'ından alınır.

**Local Development:**
```bash
# PostgreSQL başlat
brew services start postgresql@14  # macOS
sudo systemctl start postgresql    # Linux

# Database oluştur
createdb voyage_chat

# .env dosyasında:
DATABASE_URL=postgresql://$(whoami)@localhost:5432/voyage_chat
```

**Production (Render):**
- Render otomatik olarak `DATABASE_URL` sağlar
- `render.yaml` dosyasında database bağlantısı otomatik yapılandırılır

## 🤝 Katkı

Pull request'ler kabul edilir! Büyük değişiklikler için önce issue açın.

## 📝 License

MIT

## 👨‍💻 Geliştirici

Ali - Voyage Sorgun Hospitality

## 📞 Destek

Sorularınız için:
- GitHub Issues
- Email: support@voyagesorgun.com

---

**Made with ❤️ for Voyage Sorgun**
