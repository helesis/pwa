// Chat klavye yönetimi - Reverse Chat Optimized
function scrollChatToTop() {
    const chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;
    
    setTimeout(() => {
        // Reverse chat: Her zaman en üste scroll (son mesaj input altında)
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        const isAndroid = /Android/.test(navigator.userAgent);
        
        if (isIOS) {
            // iOS için: smooth scroll to top
            chatContainer.scrollTo({ 
                top: 0, 
                behavior: 'smooth' 
            });
        } else if (isAndroid) {
            // Android için: instant scroll to top
            chatContainer.scrollTop = 0;
        } else {
            // Desktop: smooth scroll to top
            chatContainer.scrollTo({ 
                top: 0, 
                behavior: 'smooth' 
            });
        }
    }, isIOS ? 50 : 20); // Reverse chat'te daha hızlı response
}

function setupChatKeyboardHandling() {
    const chatContainer = document.getElementById('chatContainer');
    const inputContainer = document.querySelector('.input-container');
    const header = document.querySelector('#chatSection .section-header');
    const bottomNav = document.querySelector('.bottom-nav');
    const messageInput = document.getElementById('messageInput');
    
    if (!chatContainer || !inputContainer || !header || !bottomNav) return;
    
    console.log('🎹 Chat Keyboard Handling initialized');
    
    function handleKeyboardResize() {
        const viewport = window.visualViewport;
        if (!viewport) return;
        
        const headerHeight = 80;
        const bottomNavHeight = 84;
        const inputHeight = inputContainer.offsetHeight;
        
        const keyboardOffset = window.innerHeight - viewport.height - viewport.offsetTop;
        const isKeyboardOpen = keyboardOffset > 50;
        
        if (isKeyboardOpen) {
            // Klavye AÇIK
            const headerOffset = viewport.offsetTop;
            
            // Chat container'ı viewport scroll'una göre ayarla (header sabit kalması için)
            chatContainer.style.top = `${headerHeight + headerOffset}px`;
            
            const availableHeight = viewport.height - headerHeight - inputHeight - bottomNavHeight;
            chatContainer.style.height = `${availableHeight}px`;
            
            inputContainer.style.transform = `translateY(-${keyboardOffset}px)`;
            bottomNav.style.transform = `translateY(-${keyboardOffset}px)`;
            
            console.log('🎹 Keyboard OPEN:', {
                keyboardOffset,
                headerOffset,
                availableHeight,
                chatTop: chatContainer.style.top
            });
            
            // Klavye açıldığında scroll (Reverse chat: üste scroll)
            setTimeout(scrollChatToTop, 100);
        } else {
            // Klavye KAPALI
            chatContainer.style.top = '80px';
            
            const availableHeight = window.innerHeight - headerHeight - inputHeight - bottomNavHeight;
            chatContainer.style.height = `${availableHeight}px`;
            
            inputContainer.style.transform = 'translateY(0)';
            bottomNav.style.transform = 'translateY(0)';
            
            console.log('🎹 Keyboard CLOSED:', {
                availableHeight,
                chatTop: chatContainer.style.top
            });
            
            // Klavye kapandığında scroll (Reverse chat: üste scroll)
            setTimeout(scrollChatToTop, 150);
        }
    }
    
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            handleKeyboardResize();
            // Visual viewport resize sonrası scroll (Reverse chat)
            setTimeout(scrollChatToTop, 50);
        });
        window.visualViewport.addEventListener('scroll', handleKeyboardResize);
    }
    
    if (messageInput) {
        messageInput.addEventListener('focus', () => {
            setTimeout(handleKeyboardResize, 100);
            // iOS için focus sonrası ek scroll (Reverse chat)
            if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
                setTimeout(scrollChatToTop, 200);
            }
        });
        messageInput.addEventListener('blur', () => {
            setTimeout(handleKeyboardResize, 300);
        });
    }
    
    // İlk çalıştırma
    handleKeyboardResize();
    
    // Input focus/click olduğunda scroll (Reverse chat)
    if (messageInput) {
        messageInput.addEventListener('focus', scrollChatToTop);
        messageInput.addEventListener('click', scrollChatToTop);
    }

    // Chat section ilk açıldığında scroll (Reverse chat)
    setTimeout(scrollChatToTop, 300);
}

// Chat section açıldığında otomatik başlat
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setupChatKeyboardHandling();
        setupChatSectionObserver();
    });
} else {
    // Sayfa zaten yüklenmişse hemen çalıştır
    setupChatKeyboardHandling();
    setupChatSectionObserver();
}

// Chat section aktivasyon kontrolü
function setupChatSectionObserver() {
    // Section loader için gecikme
    setTimeout(() => {
        const chatSection = document.getElementById('chatSection');
        if (chatSection) {
            const observer = new MutationObserver(() => {
                if (chatSection.classList.contains('active')) {
                    console.log('🎹 Chat section activated, scrolling to bottom');
                    // Section aktif olduğunda scroll (Reverse chat)
                    setTimeout(scrollChatToTop, /iPad|iPhone|iPod/.test(navigator.userAgent) ? 300 : 200);
                }
            });
            observer.observe(chatSection, { attributes: true, attributeFilter: ['class'] });
        }
    }, 1000); // Section loader'ın çalışması için bekle
}