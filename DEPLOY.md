# 🚀 Render Deployment Guide

Bu rehber, Voyage Sorgun Chat uygulamasını Render'a deploy etmek için adım adım talimatlar içerir.

## 📋 Ön Gereksinimler

1. **GitHub hesabı** - Kodunuz GitHub'da olmalı
2. **Render hesabı** - [render.com](https://render.com) üzerinden ücretsiz hesap oluşturun
3. **Claude API Key** - [console.anthropic.com](https://console.anthropic.com/) adresinden alın

## 🔧 Adım 1: GitHub'a Push

```bash
# Git repository'yi başlat (eğer yoksa)
git init

# Tüm dosyaları ekle
git add .

# İlk commit
git commit -m "Initial commit: PostgreSQL migration and Render ready"

# GitHub'da yeni repository oluştur ve push et
git remote add origin https://github.com/KULLANICI_ADI/REPO_ADI.git
git branch -M main
git push -u origin main
```

## 🗄️ Adım 2: Render'da PostgreSQL Database Oluştur

1. Render Dashboard'a giriş yapın
2. **New +** → **PostgreSQL** seçin
3. Ayarlar:
   - **Name**: `voyage-chat-db`
   - **Database**: `voyage_chat`
   - **User**: `voyage_chat_user`
   - **Region**: Size en yakın bölgeyi seçin
   - **Plan**: Starter (ücretsiz) veya daha yüksek
4. **Create Database** tıklayın
5. Database oluşturulduktan sonra, **Connections** sekmesinden **Internal Database URL**'i kopyalayın (bu otomatik olarak `DATABASE_URL` olarak ayarlanacak)

## 🌐 Adım 3: Web Service Oluştur

### Seçenek 1: render.yaml ile (Önerilen)

1. Render Dashboard → **New +** → **Blueprint**
2. GitHub repository'nizi seçin
3. Render otomatik olarak `render.yaml` dosyasını okuyacak ve gerekli servisleri oluşturacak
4. Environment variables'ı kontrol edin ve gerekirse ekleyin

### Seçenek 2: Manuel Oluşturma

1. Render Dashboard → **New +** → **Web Service**
2. GitHub repository'nizi bağlayın
3. Ayarlar:
   - **Name**: `voyage-chat-backend`
   - **Region**: Database ile aynı bölge
   - **Branch**: `main`
   - **Root Directory**: (boş bırakın)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. **Advanced** → **Add Environment Variable**:
   - `NODE_ENV` = `production`
   - `CLAUDE_API_KEY` = (Claude API key'inizi yapıştırın)
   - `DATABASE_URL` = (PostgreSQL database'inizin Internal Database URL'i - otomatik olarak eklenebilir)
   - `FRONTEND_URL` = (Render URL'iniz, örn: `https://voyage-chat-backend.onrender.com`)
5. **Create Web Service**

## 🔗 Adım 4: Database Bağlantısı

Render'da Web Service oluşturduktan sonra:

1. Web Service sayfasında **Environment** sekmesine gidin
2. **Link Database** butonuna tıklayın
3. Oluşturduğunuz PostgreSQL database'i seçin
4. Bu otomatik olarak `DATABASE_URL` environment variable'ını ekleyecek

## ✅ Adım 5: Deploy ve Test

1. Render otomatik olarak deploy başlatacak
2. **Logs** sekmesinden deploy sürecini takip edin
3. Deploy tamamlandıktan sonra, **URL**'inizi kopyalayın (örn: `https://voyage-chat-backend.onrender.com`)
4. Tarayıcıda açın ve test edin:
   - Ana sayfa: `https://voyage-chat-backend.onrender.com`
   - Health check: `https://voyage-chat-backend.onrender.com/health`
   - API test: `https://voyage-chat-backend.onrender.com/api/stats`

## 🔐 Environment Variables

Render Dashboard'da şu environment variables'ları ayarlayın:

| Variable | Value | Açıklama |
|----------|-------|----------|
| `NODE_ENV` | `production` | Production modu |
| `PORT` | `10000` | Render otomatik verir |
| `DATABASE_URL` | (otomatik) | PostgreSQL connection string |
| `CLAUDE_API_KEY` | `sk-ant-...` | Claude API anahtarınız |
| `FRONTEND_URL` | `https://your-app.onrender.com` | CORS için frontend URL |

## 🐛 Troubleshooting

### Database bağlantı hatası

```bash
# Logs'da şunu görüyorsanız:
# "Connection refused" veya "ECONNREFUSED"

# Çözüm:
1. Database'in aynı region'da olduğundan emin olun
2. Internal Database URL kullandığınızdan emin (External değil)
3. Database'in aktif olduğundan emin
```

### Build hatası

```bash
# "Cannot find module 'pg'" hatası

# Çözüm:
1. package.json'da pg dependency'sinin olduğundan emin olun
2. npm install komutunun çalıştığından emin olun
```

### CORS hatası

```bash
# Frontend'den bağlanamıyorsanız

# Çözüm:
1. FRONTEND_URL environment variable'ını doğru ayarlayın
2. server.js'de CORS ayarlarını kontrol edin
```

### Service Worker hatası

```bash
# PWA çalışmıyorsa

# Çözüm:
1. HTTPS kullanıldığından emin olun (Render otomatik sağlar)
2. manifest.json ve service-worker.js dosyalarının public/ klasöründe olduğundan emin
```

## 📱 PWA Test

1. Mobil cihazınızda Render URL'inizi açın
2. Tarayıcı menüsünden **"Ana Ekrana Ekle"** seçeneğini bulun
3. Uygulamayı ana ekrana ekleyin
4. Uygulama artık native app gibi çalışacak!

## 🔄 Otomatik Deploy

Render, GitHub'a push yaptığınızda otomatik olarak deploy yapar. Manuel deploy için:

1. Render Dashboard → Web Service
2. **Manual Deploy** → **Deploy latest commit**

## 📊 Monitoring

- **Logs**: Real-time log görüntüleme
- **Metrics**: CPU, Memory, Request count
- **Events**: Deploy geçmişi ve olaylar

## 💰 Maliyet

- **Starter Plan**: Ücretsiz (sleep mode var)
- **Standard Plan**: $7/ay (her zaman çalışır)
- **PostgreSQL Starter**: Ücretsiz (90 gün sonra sleep mode)

## 🎯 Sonraki Adımlar

1. Custom domain ekleyin (Render Dashboard → Settings → Custom Domain)
2. SSL sertifikası otomatik olarak sağlanır
3. Monitoring ve alerting ayarlayın
4. Backup stratejisi oluşturun

---

**Başarılar! 🚀**

