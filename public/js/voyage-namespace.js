// Translation helper function
function voyageT(key) {
  const translations = AppState.get('localization.translations');
  const lang = AppState.get('localization.currentLanguage');
  return translations[lang]?.[key] || translations['tr']?.[key] || key;
}

// Backward compatibility alias
const t = voyageT;

function applyTranslations() {
    // Tüm data-i18n attribute'larına sahip elementleri bul ve çevir
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        if (key) {
            element.textContent = t(key);
        }
    });
    
    // Map chips için özel işlem (Oda 101, Oda 102, vs.)
    document.querySelectorAll('[data-i18n-room]').forEach(element => {
        const roomNumber = element.getAttribute('data-i18n-room');
        const roomText = t('room');
        element.textContent = `${roomText} ${roomNumber}`;
    });
    
    // Placeholder'ları çevir
    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        const key = element.getAttribute('data-i18n-placeholder');
        if (key) {
            element.placeholder = t(key);
        }
    });
    
    // Mevcut dili göster
    const langNames = {
        'tr': 'Türkçe',
        'en': 'English',
        'de': 'Deutsch',
        'ru': 'Русский'
    };
    const currentLang = AppState.get('localization.currentLanguage');
    const currentLangDisplay = document.getElementById('currentLanguageDisplay');
    if (currentLangDisplay) {
        currentLangDisplay.textContent = langNames[currentLang] || 'Türkçe';
    }
    
    // Dil seçim modal'ındaki check işaretlerini güncelle
    ['tr', 'en', 'de', 'ru'].forEach(lang => {
        const checkEl = document.getElementById('langCheck' + lang.charAt(0).toUpperCase() + lang.slice(1));
        if (checkEl) {
            checkEl.style.display = (lang === currentLang) ? 'inline' : 'none';
        }
    });
}

        const Voyage = {
            // State management reference
            state: AppState,
            
            // Internationalization
            i18n: {
                t: voyageT,
                apply: applyTranslations,
                changeLanguage: null,
                openSelector: null,
                closeSelector: null
            },
            
            // Guest management
            guest: {
                updateHeader: null,
                updateTeamAvatar: null,
                updateProfilePhoto: null,
                continueAsGuest: null,
                requireAuth: null,
                updateProfileInfo: null
            },
            
            // Messaging system
            messaging: {
                display: null,
                updateStatus: null,
                fixAlignment: null,
                initObserver: null,
                addWelcome: null,
                scrollToBottom: null,
                format: {
                    time: null,
                    escapeHtml: null
                }
            },
            
            // Map functionality
            map: {
                init: null,
                addLocationButton: null,
                showPermissionModal: null,
                focusOnUser: null,
                stopTracking: null,
                updateUserAvatar: null,
                setupChips: null,
                setupSearch: null,
                clearSearchMarkers: null,
                getUserLocation: null,
                setup3DView: null
            },
            
            // SPA booking system
            spa: {
                closeWizard: null,
                showStep: null,
                selectService: null,
                renderCalendar: null,
                selectEarliestSlot: null,
                selectDate: null,
                selectTimeSlot: null,
                renderTherapists: null,
                selectTherapist: null,
                renderConfirm: null,
                renderTimeSlots: null,
                renderCalendarInline: null,
                renderCalendarGrid: null,
                renderDateGrid: null,
                renderServiceGrid: null,
                navigateServiceGrid: null,
                renderTherapistGrid: null,
                navigateTherapistGrid: null,
                navigateDateGrid: null,
                navigateCalendar: null,
                showAvailableSlotsSorted: null,
                showDaySlotsWithTherapistFilter: null,
                showDaySlots: null,
                showRequestDetails: null,
                scheduleReminder: null
            },
            
            // Restaurant booking system
            restaurant: {
                renderDateGrid: null,
                navigateDateGrid: null,
                renderGrid: null,
                navigateGrid: null,
                openReservationModal: null,
                closeReservationModal: null,
                addAdditionalRoom: null,
                removeAdditionalRoom: null,
                calculateTotalPax: null,
                selectTablePreference: null,
                scheduleReminder: null
            },
            
            // Activities & Timeline
            activities: {
                open: null,
                closeStory: null,
                renderTimeline: null,
                updateNowPlaying: null,
                switchDate: null,
                filterByCategory: null,
                startCountdownTimers: null,
                toggleFavorite: null,
                showOnMap: null,
                format: {
                    time: null,
                    date: null,
                    escapeHtml: null
                },
                dailyProgram: {
                    remove: null,
                    scheduleReminder: null
                }
            },
            
            // Notifications
            notifications: {
                play: null,
                send: null,
                toggle: null,
                updateToggle: null
            },
            
            // UI utilities
            ui: {
                showPhotoModal: null,
                closePhotoModal: null,
                takePhoto: null,
                selectFromGallery: null,
                resizeImage: null,
                showWelcomePopup: null,
                updateNavigationVisibility: null,
                switchSection: null,
                openLocationSettingsGuide: null,
                setupPostActions: null,
                generateAvatars: null,
                switchAvatarStyle: null,
                updateAvatarPreview: null,
                toggleGhostMode: null
            },
            
            // General utilities
            utils: {
                isIOS: null,
                isStandalone: null,
                toAbsoluteUrl: null,
                getCookie: null,
                timeAgo: null,
                simpleHash: null,
                getStoredArray: null,
                getStoredObject: null,
                parseTimeToMinutes: null,
                formatTimeFromDate: null,
                getDateKey: null,
                buildDateTime: null,
                buildTimelineEventId: null
            },
            
            // PWA functionality
            pwa: {
                setupFullscreen: null,
                setupScrollListener: null,
                refreshSafeArea: null,
                setupKeyboardHandling: null,
                setupSafeAreaRefresh: null
            },
            
            // Reservations
            reservations: {
                updateInfo: null
            }
        };

// Export to global window
window.Voyage = Voyage;
