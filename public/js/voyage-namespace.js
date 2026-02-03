        const Voyage = {
            // State management reference
            state: AppState,
            
            // Internationalization
            i18n: {
                t: voyageT,
                apply: null,  // Will be set below
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
