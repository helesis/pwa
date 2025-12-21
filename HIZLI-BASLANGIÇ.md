# 🚀 HIZLI BAŞLANGIÇ REHBERİ

## 5 Dakikada Çalıştırın!

### 1️⃣ Dosyaları İndirin

Tüm dosyaları bir klasöre kaydedin:
```
voyage-chat/
├── server.js
├── package.json
├── env.example (bunu .env olarak yeniden adlandırın)
├── README.md
└── public/
    └── index.html
```

### 2️⃣ Terminal Açın

**Windows:**
- `Win + R` → `cmd` yazın → Enter

**Mac/Linux:**
- Terminal uygulamasını açın

Klasöre gidin:
```bash
cd voyage-chat
```

### 3️⃣ Node.js Kontrol

```bash
node --version
```

Eğer **hata verirse**: https://nodejs.org/ adresinden indirin (LTS versiyonu)

### 4️⃣ Dependencies Yükle

```bash
npm install
```

Bekleyin (1-2 dakika)...

### 5️⃣ Claude API Key Alın

1. https://console.anthropic.com/ adresine gidin
2. Sign up / Login yapın
3. Sol menüden "API Keys" → "Create Key"
4. Key'i kopyalayın (örn: `sk-ant-api03-...`)

### 6️⃣ Konfigürasyon

`env.example` dosyasını `.env` olarak yeniden adlandırın

`.env` dosyasını açın ve düzenleyin:

```env
CLAUDE_API_KEY=sk-ant-api03-BURAYA_ACTUAL_KEY_YAPIŞTIRIN
PORT=3000
```

**ÖNEMLİ:** Gerçek API key'inizi yapıştırın!

### 7️⃣ Serveri Başlat

```bash
npm start
```

Şunu görmelisiniz:
```
🏨 ════════════════════════════════════════════
   Voyage Sorgun Chat Server
   ════════════════════════════════════════════

   🌐 Server: http://localhost:3000
   🔌 WebSocket: ws://localhost:3000
   📊 API: http://localhost:3000/api

   ✅ Database: SQLite (voyage-chat.db)
   ✅ Real-time: Socket.IO
   ✅ Tone Analysis: Claude AI

🏨 ════════════════════════════════════════════
```

### 8️⃣ Tarayıcıda Aç

```
http://localhost:3000
```

### 9️⃣ Test Edin!

Chat'te yazın:

**Negatif test:**
```
Klima çalışmıyor, çok kötü!
```

**Pozitif test:**
```
Harika bir otel, çok teşekkürler!
```

Tone analizi sonuçlarını göreceksiniz! 🎯

## 📱 Mobilde Test

### iPhone:
1. Safari'de aç
2. Paylaş → Ana Ekrana Ekle
3. App gibi kullan!

### Android:
1. Chrome'da aç
2. Menü → Ana ekrana ekle
3. App gibi kullan!

## 🆘 Sorun mu var?

### "npm not found"
→ Node.js yükleyin: https://nodejs.org/

### "Cannot find module 'express'"
→ `npm install` komutunu çalıştırın

### "Port 3000 is already in use"
→ `.env` dosyasında `PORT=3001` yapın

### "Claude API error"
→ API key'i kontrol edin, doğru mu yapıştırdınız?

### Hala çalışmıyor?
→ Terminal'de hata mesajını kopyalayın, Google'da aratın

## ✅ Çalıştı mı?

Tebrikler! 🎉

Artık:
- ✅ Gerçek zamanlı chat çalışıyor
- ✅ Tone analizi aktif
- ✅ Database mesajları kaydediyor
- ✅ WebSocket bağlantısı var

## 📚 Sonraki Adımlar

1. **README.md** dosyasını okuyun (detaylı dökümantasyon)
2. **API Endpoints** test edin
3. **Tone analizi** algoritmasını özelleştirin
4. **Production'a** deploy edin

## 💡 İpuçları

- Kodu değiştirdiğinizde **Ctrl+C** → `npm start` yapın
- **Console**'u açın (F12) detaylı log'lar için
- **Database** dosyası: `voyage-chat.db` (SQLite Browser ile açabilirsiniz)

## 🎯 Tone Analizi Nasıl Çalışıyor?

1. Mesaj gelir
2. Claude API'ye gönderilir
3. AI analiz eder (sentiment, urgency, category)
4. Sonuç döner
5. Negatif ise → Alert oluşturulur
6. Database'e kaydedilir

Konsol'da görebilirsiniz:
```
🎯 Claude Analysis: {
  sentiment: 'negative',
  urgency: 'high',
  category: 'teknik sorun',
  alert_manager: true
}
```

---

**Başarılar! 🚀**
