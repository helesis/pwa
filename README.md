# 🏨 Voyage Sorgun Chat System

Gerçek zamanlı tone analizi ile akıllı otel müşteri iletişim sistemi. WhatsApp benzeri kullanıcı deneyimi ve kapsamlı assistant/takım yönetimi ile profesyonel otel iletişim platformu.

## ✨ Özellikler

### 🎯 Tone Analizi (Claude AI)
- Gerçek zamanlı mesaj analizi
- Negatif/Nötr/Pozitif sentiment tespiti
- Aciliyet seviyesi belirleme
- Kategori sınıflandırması (teknik sorun, room service, vb.)
- Otomatik yönetici bildirimi

### 💬 Real-time Messaging
- WebSocket (Socket.IO) ile anlık iletişim
- Yazma göstergesi (typing indicator)
- WhatsApp benzeri mesaj durumu takibi:
  - ✅ Gönderildi (gri tek tik)
  - ✅✅ İletildi (gri çift tik)
  - ✅✅ Okundu (mavi çift tik)
- Optimistic UI updates (anında mesaj görüntüleme)
- Mesaj geçmişi
- Çoklu kullanıcı desteği
- Son mesaj önizlemesi ve zaman damgası
- Okunmamış mesaj sayısı

### 👥 Assistant & Takım Yönetimi
- **Assistant Yönetimi:**
  - Assistant oluşturma, düzenleme, silme
  - Avatar desteği (fotoğraf yükleme)
  - Email kaydı
  - Takım ataması
  
- **Takım Yönetimi:**
  - Takım oluşturma, düzenleme, silme
  - Avatar desteği (fotoğraf yükleme)
  - Assistant'ları takıma atama
  - QR kod ile takıma katılım
  - Aktif oda sayısı takibi

- **Oda-Takım Eşleştirme:**
  - Misafir odalarını takımlara atama
  - Check-in tarihine göre filtreleme
  - Eşleşmemiş odalar listesi
  - Otomatik oda atama bildirimleri

### 📱 WhatsApp Benzeri Mobil UI
- **Assistant Dashboard:**
  - Liste görünümü (misafir listesi)
  - Chat görünümü (yazışma ekranı)
  - iOS benzeri geri butonu
  - Responsive tasarım (mobil/desktop)
  - Son mesaj önizlemesi
  - Göreceli zaman gösterimi (Şimdi, 5 dk, 2 sa, vb.)
  
- **Misafir Chat:**
  - WhatsApp benzeri arayüz
  - Optimistic mesaj gönderimi
  - Mesaj durumu göstergeleri
  - Fotoğraf gönderme desteği

### 🔐 Güvenli Erişim Sistemi
- Token bazlı QR kod sistemi
- Misafir odalarına token ile erişim
- Süresi dolmuş token kontrolü
- Geçersiz token kontrolü
- Landing page (ana sayfa koruması)

### 📊 Database
- PostgreSQL (production-ready)
- Mesaj kayıtları (delivered_at, read_at)
- Oda yönetimi (check-in/check-out tarihleri)
- Assistant ve takım yönetimi
- Oda-takım eşleştirmeleri
- QR kod ve davet sistemi
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
- Takım bazlı bildirimler
- Oda atama bildirimleri

### 🗺️ Harita Özellikleri
- **Mapbox Entegrasyonu:**
  - İnteraktif harita görünümü
  - Otel konumu gösterimi
  - Gerçek zamanlı kullanıcı konum takibi
  - Diğer misafirlerin konumlarını görme
  - Aktivite marker'ları (restoran, spa, sahil, vb.)
  - Konum arama (oda numarası veya alan adı)
  - Hızlı erişim chip'leri (Resepsiyon, Ana Restoran, Sahil, Beach Club)
  - Konum izni yönetimi
  - Ghost mode desteği (konum paylaşımını gizleme)
  - Smooth animasyonlar ve zoom kontrolleri

### 🍽️ Restoran Rezervasyonları
- **A'la Carte Rezervasyon Sistemi:**
  - Restoran listesi ve detay görünümü
  - Tarih ve seans seçimi
  - Müsaitlik takvimi (yeşil/sarı/kırmızı göstergeler)
  - Kişi sayısı seçimi (yetişkin/çocuk)
  - Otomatik masa atama algoritması
  - Fiyat hesaplama ve snapshot (rezervasyon anındaki fiyat korunur)
  - İptal kuralları ve son iptal tarihi kontrolü
  - Rezervasyon geçmişi ve yönetimi
  - Swipe ile iptal (mobil UX)
  - Çoklu dil desteği (TR/EN/DE/RU)

### 💆 SPA Rezervasyonları
- **SPA Booking Wizard:**
  - 5 adımlı rezervasyon akışı
  - Hizmet seçimi
  - Tarih seçimi (müsaitlik heat map ile)
  - Saat dilimi seçimi
  - Terapist seçimi (opsiyonel)
  - Onay ekranı ve not ekleme
  - Taleplerin durum takibi (Beklemede/Onaylandı/Reddedildi/İptal Edildi)
  - "En erken uygun" hızlı seçim butonu
  - Müsaitlik uyarıları (10 dakikadan eski veri)
  - Rezervasyon iptal etme
  - Misafir konaklama tarihlerine göre otomatik tarih aralığı

## 🌐 Arayüzler

### 1. Landing Page (`/`)
- Ana sayfa
- QR kod veya davet linki gerektiğini belirtir
- Token olmadan chat'e erişim yok

### 2. Misafir Chat (`/join?token=TOKEN`)
- Misafirlerin chat yaptığı sayfa
- Token ile erişim zorunlu
- WhatsApp benzeri arayüz
- Fotoğraf gönderme
- **Harita Sekmesi:**
  - İnteraktif harita görünümü
  - Konum takibi ve paylaşımı
  - Diğer misafirlerin konumlarını görme
  - Aktivite ve konum arama
- **Restoran Rezervasyonları Sekmesi:**
  - Restoran listesi ve detayları
  - Rezervasyon oluşturma
  - Rezervasyon geçmişi ve yönetimi
- **SPA Rezervasyonları Sekmesi:**
  - SPA hizmet rezervasyonu
  - 5 adımlı booking wizard
  - Rezervasyon durum takibi

### 3. Assistant Dashboard (`/assistant`)
- Assistant'ların takımlarına atanmış odaları görüp chat yaptığı sayfa
- WhatsApp benzeri mobil UI
- Liste/chat görünümü toggle
- Takımda olan assistant'lar için optimize edilmiş
- Assistant avatar'ı ve takım bilgisi gösterimi

### 4. Settings (`/settings`)
- **Admin Only** - Şifre korumalı (ileride eklenecek)
- Assistant yönetimi (CRUD)
- Takım yönetimi (CRUD)
- Oda-takım eşleştirmesi
- Eşleşmemiş odalar listesi
- QR kod oluşturma
- **Restoran Yönetimi:**
  - Restoran oluşturma ve düzenleme
  - Seans şablonları yönetimi
  - Masa envanteri ayarlama
  - Takvim görünümü ve seans örnekleri oluşturma
  - Fiyatlandırma ve iş kuralları yönetimi
- **Harita Konumları:**
  - Harita konumları yönetimi
  - Aktivite marker'ları ekleme/düzenleme

## 🚀 Kurulum

### Gereksinimler

- Node.js 18+ 
- npm veya yarn
- PostgreSQL (local veya Render'da)
- Claude API Key ([console.anthropic.com](https://console.anthropic.com/)) - Opsiyonel

### Adım 1: Projeyi İndir

```bash
git clone https://github.com/helesis/pwa.git
cd pwa
```

### Adım 2: Dependencies Yükle

```bash
npm install
```

### Adım 3: Konfigürasyon

`.env` dosyası oluşturun:

```bash
cp env.example .env
```

`.env` dosyasını düzenleyin:

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/voyage_chat
CLAUDE_API_KEY=your_actual_api_key_here  # Opsiyonel
FRONTEND_URL=http://localhost:3000
MAPBOX_TOKEN=your_mapbox_access_token  # Harita özellikleri için gerekli
```

**PostgreSQL Kurulumu (Local):**
- macOS: `brew install postgresql@14 && brew services start postgresql@14`
- Linux: `sudo apt-get install postgresql postgresql-contrib`
- Windows: [PostgreSQL installer](https://www.postgresql.org/download/windows/)

Database oluşturun:
```bash
createdb voyage_chat
```

Claude API Key almak için (Opsiyonel):
1. https://console.anthropic.com/ adresine gidin
2. API Keys bölümünden yeni key oluşturun
3. Key'i `.env` dosyasına yapıştırın

Mapbox Token almak için (Harita özellikleri için gerekli):
1. https://account.mapbox.com/ adresine gidin
2. Access tokens bölümünden yeni token oluşturun
3. Token'ı `.env` dosyasına yapıştırın
4. `public/index.html` içinde `MAPBOX_TOKEN` değişkenini güncelleyin

### Adım 4: Serveri Başlat

```bash
npm start
```

Ya da development modunda (auto-restart):

```bash
npm run dev
```

Database tabloları otomatik olarak oluşturulacaktır. İlk çalıştırmada test verileri oluşturulur (önümüzdeki 10 gün için random check-in'ler).

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

## 🎮 Kullanım Senaryoları

### Senaryo 1: Misafir Chat'e Katılma

1. Assistant Settings'ten bir misafir odası için QR kod oluşturur
2. Misafir QR kodu okutur veya link'e tıklar
3. `/join?token=TOKEN` sayfasına yönlendirilir
4. Chat'e başlar

### Senaryo 2: Assistant Takıma Katılma

1. Settings'ten bir takım oluşturulur
2. Takım QR kodu oluşturulur
3. Assistant QR kodu okutur veya link'e tıklar
4. Assistant ID girilir (ilk seferde)
5. Assistant otomatik olarak takıma katılır
6. Takıma atanmış odalar görünür

### Senaryo 3: Oda-Takım Eşleştirme

1. Settings > Eşleştirmeler sekmesine gidilir
2. Tarih filtrelenir
3. Eşleşmemiş odalar görüntülenir
4. Odaya tıklanır, takım seçilir
5. Oda takıma atanır
6. Takım üyeleri otomatik olarak odaya erişir

## 📊 API Endpoints

### REST API

#### Odalar
```
GET  /api/rooms                    - Tüm aktif odalar
GET  /api/rooms?start_date=X&end_date=Y  - Tarihe göre filtrelenmiş odalar
GET  /api/rooms/:number            - Oda detayları
POST /api/rooms                    - Yeni oda ekle
```

#### Mesajlar
```
GET  /api/messages/:number         - Oda mesajları
POST /api/messages                 - Yeni mesaj gönder
```

#### Assistant Yönetimi
```
GET    /api/assistants             - Tüm assistant'lar (takım bilgisi ile)
GET    /api/assistants/:id         - Assistant detayları
POST   /api/assistants             - Yeni assistant oluştur
PUT    /api/assistants/:id         - Assistant güncelle
DELETE /api/assistants/:id         - Assistant sil
GET    /api/assistant/:id/teams    - Assistant'ın takımları
GET    /api/assistant/:id/rooms?date=X  - Assistant'ın odaları
```

#### Takım Yönetimi
```
GET    /api/teams                  - Tüm takımlar (aktif oda sayısı ile)
GET    /api/teams/:id              - Takım detayları
GET    /api/teams/:id/assistants   - Takım assistant'ları
POST   /api/teams                  - Yeni takım oluştur
PUT    /api/teams/:id              - Takım güncelle
DELETE /api/teams/:id              - Takım sil
POST   /api/teams/:id/invite       - Takım QR kodu oluştur
POST   /api/teams/join             - Takıma katıl (token ile)
```

#### Eşleştirmeler
```
GET    /api/team-assignments       - Tüm eşleştirmeler
GET    /api/team-assignments?checkin_date=X  - Tarihe göre filtrelenmiş
POST   /api/team-assignments       - Yeni eşleştirme
DELETE /api/team-assignments/:id   - Eşleştirme sil
```

#### QR Kod ve Davetler
```
GET    /api/invite/:token          - Davet token doğrulama
POST   /api/assistant/:id/rooms/:roomNumber/invite  - Oda QR kodu oluştur
```

#### İstatistikler
```
GET  /api/stats                    - Genel istatistikler
GET  /api/alerts                   - Tone alert'ler
POST /api/alerts/:id/sent          - Alert'i okundu işaretle
```

#### Harita
```
GET  /api/map/locations            - Tüm harita konumları
GET  /api/location/users           - Aktif kullanıcı konumları
POST /api/location/update          - Kullanıcı konumunu güncelle
GET  /api/activities               - Aktivite marker'ları
```

#### Restoran Rezervasyonları
```
GET    /restaurants                - Müsait restoranlar listesi
GET    /restaurants/:id/availability - Tarih aralığı için müsaitlik
POST   /reservations               - Yeni rezervasyon oluştur
GET    /reservations?room_no=...   - Misafir rezervasyonları
DELETE /reservations/:id           - Rezervasyon iptal et
```

#### SPA Rezervasyonları
```
GET    /api/spa/services          - Müsait SPA hizmetleri
GET    /api/spa/availability       - Tarih aralığı için müsaitlik
POST   /api/spa/requests           - Yeni SPA talebi oluştur
GET    /api/spa/requests?mine=true - Kullanıcının SPA talepleri
POST   /api/spa/requests/:id/cancel - SPA talebini iptal et
```

### WebSocket Events

**Client → Server:**
```javascript
socket.emit('join_room', { roomNumber, checkinDate });
socket.emit('send_message', { roomNumber, checkinDate, senderType, senderName, message });
socket.emit('typing', { roomNumber, checkinDate, senderName });
socket.emit('stop_typing', { roomNumber, checkinDate });
socket.emit('message_delivered', { messageId, roomNumber, checkinDate });
socket.emit('message_read', { messageId, roomNumber, checkinDate });
```

**Server → Client:**
```javascript
socket.on('chat_history', messages);
socket.on('new_message', messageData);
socket.on('message_sent', { messageId, status });
socket.on('message_status_update', { messageId, status, deliveredAt, readAt });
socket.on('tone_analysis', analysis);
socket.on('tone_alert', alert);
socket.on('user_typing', data);
socket.on('user_stopped_typing');
socket.on('auto_join_room', { roomNumber, checkinDate, teamId });
```

## 🗄️ Database Schema

### Tablolar

- **messages**: Mesaj kayıtları (delivered_at, read_at ile)
- **rooms**: Oda bilgileri (guest_name, checkin_date, checkout_date)
- **assistants**: Assistant bilgileri (avatar ile)
- **teams**: Takım bilgileri (avatar ile)
- **assistant_teams**: Assistant-takım eşleştirmeleri
- **team_room_assignments**: Takım-oda eşleştirmeleri
- **room_invites**: Misafir davet token'ları
- **team_invites**: Takım davet token'ları
- **map_locations**: Harita konumları (restoran, spa, sahil, vb.)
- **user_locations**: Kullanıcı konum takibi (gerçek zamanlı)
- **restaurants**: Restoran tanımları (fiyat, kurallar, JSON)
- **session_templates**: Restoran seans şablonları (tekrarlayan zaman dilimleri)
- **session_instances**: Tarihli seans örnekleri
- **session_table_groups**: Seans başına masa envanteri
- **reservations**: Restoran rezervasyonları (fiyat snapshot ile)
- **reservation_table_assignments**: Rezervasyon-masa atamaları
- **spa_services**: SPA hizmet tanımları
- **spa_requests**: SPA rezervasyon talepleri

### Önemli İlişkiler

- `rooms(room_number, checkin_date)` - Unique constraint
- `assistant_teams(assistant_id, team_id)` - Unique constraint
- `team_room_assignments(team_id, room_number, checkin_date)` - Unique constraint

## 🎨 Customization

### Renk Teması Değiştirme

`public/index.html` ve `public/assistant.html` içinde CSS değişkenlerini düzenleyin:

```css
:root {
    --voyage-navy: #1A4D6D;      /* Ana renk */
    --voyage-blue: #2C6E8F;      /* İkincil renk */
    --voyage-gold: #C9A961;      /* Vurgu rengi */
    --voyage-sand: #F5F1E8;      /* Arka plan */
}
```

### Assistant ID Ayarlama

`public/assistant.html` içinde:

```javascript
const ASSISTANT_ID = 1; // Assistant ID'yi değiştirin
```

Veya local storage'dan otomatik alınır (QR kod ile takıma katılımda).

## 📈 Production Deployment

### Render.com (Önerilen) ⭐

Detaylı deployment rehberi için [DEPLOY.md](./DEPLOY.md) dosyasına bakın.

**Hızlı Başlangıç:**
1. GitHub'a push edin
2. Render Dashboard → New → Blueprint
3. Repository'nizi seçin (render.yaml otomatik algılanır)
4. PostgreSQL database oluşturun
5. Environment variables ekleyin:
   - `DATABASE_URL` (otomatik oluşturulur)
   - `FRONTEND_URL` (örn: https://voyage-chat-backend.onrender.com)
   - `CLAUDE_API_KEY` (opsiyonel)
   - `MAPBOX_TOKEN` (harita özellikleri için gerekli)
6. Deploy!

**Maliyet:** Ücretsiz (Starter plan) veya $7/ay (Standard plan)

### Diğer Platformlar

- **Railway.app**: Similar to Render
- **DigitalOcean**: VPS kullanımı
- **Vercel + Railway**: Frontend/Backend ayrı deploy

## 🔐 Güvenlik

### Production için:

1. **HTTPS kullanın** (Let's Encrypt veya Render otomatik sağlar)
2. **CORS ayarlayın:**
   ```javascript
   cors: {
     origin: process.env.FRONTEND_URL || "https://yourdomain.com",
     credentials: true
   }
   ```
3. **Rate limiting ekleyin:**
   ```bash
   npm install express-rate-limit
   ```
4. **Environment variables'ı güvenli tutun**
5. **Settings sayfasına şifre koruması ekleyin** (ileride)

## 💰 Maliyet

### Aylık İşletme Maliyeti

| Kalem | Tutar |
|-------|-------|
| Hosting (Render - Free) | $0 |
| PostgreSQL (Render - Free) | $0 |
| Claude API (15K mesaj/ay) | $7-15 (Opsiyonel) |
| Domain | $1 (Opsiyonel) |
| **TOPLAM** | **$0-16/ay** |

**Ücretsiz tier'de çalışabilir!**

## 🐛 Troubleshooting

### Port zaten kullanımda

```bash
# Portu değiştirin
PORT=3001 npm start
```

### WebSocket bağlanamıyor

Render free tier'de WebSocket bağlantıları geçici olarak kesilebilir. Socket.IO otomatik olarak yeniden bağlanır (polling fallback ile).

```javascript
// assistant.html'de polling öncelikli
transports: ['polling', 'websocket']
```

### Database hatası

```bash
# PostgreSQL bağlantısını kontrol edin
psql $DATABASE_URL -c "SELECT 1"

# Connection string formatı:
# postgresql://user:password@host:port/database
```

### Avatar görünmüyor

- Base64 formatında kaydedildiğinden emin olun
- Database'de `avatar` kolonu olduğunu kontrol edin
- Browser console'da hata var mı kontrol edin

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

## 🧪 Test

### Test Verileri

İlk çalıştırmada otomatik olarak test verileri oluşturulur:
- 1 test assistant (ID: 1)
- Önümüzdeki 10 gün için random check-in'ler
- Random misafir isimleri, ülkeler, acenteler

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
