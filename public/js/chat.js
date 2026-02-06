// Chat klavye yönetimi - Optimized versiyon
function scrollChatToBottom() {
    const chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;
    
    setTimeout(() => {
        const allMessages = chatContainer.querySelectorAll('.message');
        if (allMessages.length > 0) {
            const lastMessage = allMessages[allMessages.length - 1];
            const targetScroll = (lastMessage.offsetTop + lastMessage.offsetHeight) - chatContainer.clientHeight + 20;
            chatContainer.scrollTop = targetScroll;
        }
    }, 50);
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
        }
    }
    
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', handleKeyboardResize);
        window.visualViewport.addEventListener('scroll', handleKeyboardResize);
    }
    
    if (messageInput) {
        messageInput.addEventListener('focus', () => setTimeout(handleKeyboardResize, 100));
        messageInput.addEventListener('blur', () => setTimeout(handleKeyboardResize, 300));
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
    document.addEventListener('DOMContentLoaded', setupChatKeyboardHandling);
} else {
    // Sayfa zaten yüklenmişse hemen çalıştır
    setupChatKeyboardHandling();
}