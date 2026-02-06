// Chat klavye yönetimi - Optimized versiyon
function scrollChatToBottom() {
    const chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;
    
    setTimeout(() => {
        // iOS ve Android için optimize edilmiş scroll
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        const isAndroid = /Android/.test(navigator.userAgent);
        
        if (isIOS) {
            // iOS için: scrollIntoView daha güvenilir
            const allMessages = chatContainer.querySelectorAll('.message');
            if (allMessages.length > 0) {
                const lastMessage = allMessages[allMessages.length - 1];
                lastMessage.scrollIntoView({ 
                    behavior: 'smooth', 
                    block: 'end',
                    inline: 'nearest'
                });
            }
        } else if (isAndroid) {
            // Android için: scrollTop daha hızlı
            chatContainer.scrollTop = chatContainer.scrollHeight;
        } else {
            // Desktop/diğer platformlar için hybrid yaklaşım
            const allMessages = chatContainer.querySelectorAll('.message');
            if (allMessages.length > 0) {
                chatContainer.scrollTop = chatContainer.scrollHeight;
            }
        }
    }, isIOS ? 100 : 50); // iOS için biraz daha fazla gecikme
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
            
            // Klavye açıldığında scroll (iOS/Android için optimize)
            setTimeout(scrollChatToBottom, 150);
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
            
            // Klavye kapandığında scroll (layout değişikliği sonrası)
            setTimeout(scrollChatToBottom, 200);
        }
    }
    
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            handleKeyboardResize();
            // Visual viewport resize sonrası scroll (iOS/Android için kritik)
            setTimeout(scrollChatToBottom, 100);
        });
        window.visualViewport.addEventListener('scroll', handleKeyboardResize);
    }
    
    if (messageInput) {
        messageInput.addEventListener('focus', () => {
            setTimeout(handleKeyboardResize, 100);
            // iOS için focus sonrası ek scroll
            if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
                setTimeout(scrollChatToBottom, 300);
            }
        });
        messageInput.addEventListener('blur', () => {
            setTimeout(handleKeyboardResize, 300);
        });
    }
    
    // İlk çalıştırma
    handleKeyboardResize();
    
    // Input focus/click olduğunda scroll
    if (messageInput) {
        messageInput.addEventListener('focus', scrollChatToBottom);
        messageInput.addEventListener('click', scrollChatToBottom);
    }

    // Chat section ilk açıldığında scroll
    setTimeout(scrollChatToBottom, 500);
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
                    // Section aktif olduğunda scroll (iOS/Android için optimize)
                    setTimeout(scrollChatToBottom, /iPad|iPhone|iPod/.test(navigator.userAgent) ? 400 : 300);
                }
            });
            observer.observe(chatSection, { attributes: true, attributeFilter: ['class'] });
        }
    }, 1000); // Section loader'ın çalışması için bekle
}