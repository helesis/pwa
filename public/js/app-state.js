// app-state.js
// Centralized AppState IIFE extracted from original index.html
const AppState = (() => {
    // Private state object
    const state = {
        // Authentication & User Profile
        auth: {
            uniqueId: localStorage.getItem('guest_unique_id') || null,
            name: localStorage.getItem('guest_name') || 'Misafir',
            surname: localStorage.getItem('guest_surname') || null,
            roomNumber: localStorage.getItem('room_number') || null,
            checkinDate: localStorage.getItem('checkin_date') || null,
            checkoutDate: localStorage.getItem('checkout_date') || null,
            teamId: localStorage.getItem('team_id') || null,
            isAuthenticated: false,
            profilePhoto: null,
            teamAvatar: null,
            infoLoaded: false
        },
        
        // Network & Communication
        network: {
            socket: null,
            isTyping: false,
            typingTimeout: null,
            connectionTimeout: null,
            serverUrl: window.location.origin
        },
        
        // Activities & Timeline
        activities: {
            currentDate: new Date().toISOString().split('T')[0],
            currentCategory: 'All',
            data: []
        },
        
        // Daily Program & Reminders
        dailyProgram: {
            // Constants
            START_HOUR: 6,
            END_HOUR: 23,
            HOUR_WIDTH: 120,
            EVENT_HEIGHT: 92,
            EVENT_GAP: 12,
            
            // Runtime data
            reminderTimers: {},
            eventCache: {},
            hiddenEvents: JSON.parse(localStorage.getItem('dailyProgramHiddenEvents') || '[]'),
            reminders: JSON.parse(localStorage.getItem('dailyProgramReminders') || '{}')
        },
        
        // Reminders (Restaurant & Spa)
        reminders: {
            restaurant: {},
            spa: {}
        },
        
        // Localization
        localization: {
            currentLanguage: localStorage.getItem('appLanguage') || 'tr',
            translations: {} // Will be populated later
        },
        
        // Messaging System
        messaging: {
            observer: null,
            isLoadingOlder: false,
            oldestTimestamp: null
        },
        
        // Map & Location
        map: {
            instance: null,
            markers: {
                user: null,
                hotel: null,
                others: {},
                activities: [],
                search: [],
                temp: null
            },
            location: {
                watchId: null,
                lastUpdateTime: null,
                updateInterval: null,
                permissionState: null,
                isCreatingUserMarker: false
            },
            animation: {
                hasPlayedCinematic: false
            },
            data: {
                locations: {},
                searchTimeout: null
            },
            config: {
                token: 'pk.eyJ1IjoiYWxpbXVyc2l0IiwiYSI6ImNtazRnYTRjZjAwa2IzZXF2cWJnaW9ocDcifQ.EL6OVUXoR22l0vrNPzVyoQ'
            }
        },
        
        // Avatar System - REMOVED: Now using profile photo on map
        
        // Booking State
        booking: {
            spa: {
                step: 'service',
                serviceId: null,
                date: null,
                slot: null,
                therapistId: null,
                note: '',
                // Extended SPA state
                allDates: [],
                currentDateIndex: 0,
                selectedDateElement: null,
                selectedDate: null,
                dateRange: null,
                availableServices: [],
                currentServiceIndex: 0,
                selectedServiceElement: null,
                dateSlotsByService: null,
                availableTherapists: [],
                currentTherapistIndex: 0,
                selectedTherapistElement: null,
                selectedTherapistId: null,
                availabilityDays: [],
                currentAvailability: null
            },
            restaurant: {
                allDates: [],
                currentDateIndex: 0,
                selectedDateElement: null,
                selectedDate: null,
                dateRange: null,
                // Extended Restaurant state
                currentForReservation: null,
                availableRestaurants: [],
                currentIndex: 0,
                selectedRestaurantId: null,
                selectedRestaurantElement: null
            }
        }
    };
    
    // Event listeners for state changes
    const listeners = {};
    
    // Public API
    return {
        // Get nested property (e.g., 'auth.uniqueId')
        get(path) {
            const keys = path.split('.');
            let value = state;
            for (const key of keys) {
                value = value?.[key];
            }
            return value;
        },
        
        // Set nested property with localStorage sync
        set(path, value) {
            const keys = path.split('.');
            const lastKey = keys.pop();
            let target = state;
            
            for (const key of keys) {
                target = target[key];
            }
            
            target[lastKey] = value;
            
            // Auto-sync critical data to localStorage
            this.syncToLocalStorage(path, value);
            
            // Notify listeners
            this.notify(path, value);
            
            return value;
        },
        
        // Direct access to state (for complex operations)
        getState() {
            return state;
        },
        
        // Subscribe to state changes
        on(path, callback) {
            if (!listeners[path]) listeners[path] = [];
            listeners[path].push(callback);
        },
        
        // Notify listeners
        notify(path, value) {
            listeners[path]?.forEach(cb => cb(value));
        },
        
        // Sync to localStorage
        syncToLocalStorage(path, value) {
            const syncMap = {
                'auth.uniqueId': 'guest_unique_id',
                'auth.name': 'guest_name',
                'auth.surname': 'guest_surname',
                'auth.roomNumber': 'room_number',
                'auth.checkinDate': 'checkin_date',
                'auth.checkoutDate': 'checkout_date',
                'auth.teamId': 'team_id',
                'localization.currentLanguage': 'appLanguage',
                'dailyProgram.hiddenEvents': 'dailyProgramHiddenEvents',
                'dailyProgram.reminders': 'dailyProgramReminders'
            };
            
            const storageKey = syncMap[path];
            if (storageKey) {
                if (value === null || value === undefined) {
                    localStorage.removeItem(storageKey);
                } else if (typeof value === 'object') {
                    localStorage.setItem(storageKey, JSON.stringify(value));
                } else {
                    localStorage.setItem(storageKey, value);
                }
            }
        },
        
        // Clear all auth data (logout)
        clearAuth() {
            state.auth = {
                uniqueId: null,
                name: 'Misafir',
                surname: null,
                roomNumber: null,
                checkinDate: null,
                checkoutDate: null,
                teamId: null,
                isAuthenticated: false,
                profilePhoto: null,
                teamAvatar: null,
                infoLoaded: false
            };
            
            // Clear localStorage
            ['guest_unique_id', 'guest_name', 'guest_surname', 'room_number', 
             'checkin_date', 'checkout_date', 'team_id'].forEach(key => {
                localStorage.removeItem(key);
            });
        }
    };
})();

// Export to global window for legacy code that expects AppState global
window.AppState = AppState;
