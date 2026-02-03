# AppState - Centralized State Management

## 📋 Overview

`AppState` is a centralized state management module that organizes all global variables into a structured, maintainable pattern.

## 🏗️ Architecture

### State Structure

```javascript
AppState = {
    auth: {
        uniqueId: string | null,
        name: string,
        surname: string | null,
        roomNumber: string | null,
        checkinDate: string | null,
        checkoutDate: string | null,
        teamId: string | null,
        isAuthenticated: boolean,
        profilePhoto: string | null,
        teamAvatar: string | null,
        infoLoaded: boolean
    },
    
    network: {
        socket: Socket | null,
        isTyping: boolean,
        typingTimeout: number | null,
        connectionTimeout: number | null,
        serverUrl: string
    },
    
    activities: {
        currentDate: string,
        currentCategory: string,
        data: Array
    },
    
    dailyProgram: {
        START_HOUR: 6,
        END_HOUR: 23,
        HOUR_WIDTH: 120,
        EVENT_HEIGHT: 92,
        EVENT_GAP: 12,
        reminderTimers: Object,
        eventCache: Object,
        hiddenEvents: Array,
        reminders: Object
    },
    
    reminders: {
        restaurant: Object,
        spa: Object
    },
    
    localization: {
        currentLanguage: string,
        translations: Object
    },
    
    booking: {
        spa: {
            step: string,
            serviceId: number | null,
            date: string | null,
            slot: Object | null,
            therapistId: number | null,
            note: string
        },
        restaurant: {
            allDates: Array,
            currentDateIndex: number,
            selectedDateElement: Element | null,
            selectedDate: string | null,
            dateRange: Object | null
        }
    }
}
```

## 🔑 API Methods

### `AppState.get(path)`
Get a nested property value.

```javascript
// Examples
const userId = AppState.get('auth.uniqueId');
const socket = AppState.get('network.socket');
const currentLang = AppState.get('localization.currentLanguage');
```

### `AppState.set(path, value)`
Set a nested property and auto-sync to localStorage if applicable.

```javascript
// Examples
AppState.set('auth.uniqueId', 'guest-123');
AppState.set('localization.currentLanguage', 'en');
AppState.set('activities.currentDate', '2026-01-20');
```

### `AppState.getState()`
Get direct reference to the entire state object (for complex operations).

```javascript
const state = AppState.getState();
state.dailyProgram.reminderTimers['event-1'] = setTimeout(...);
```

### `AppState.on(path, callback)`
Subscribe to state changes.

```javascript
AppState.on('localization.currentLanguage', (newLang) => {
    console.log('Language changed to:', newLang);
    applyTranslations();
});
```

### `AppState.clearAuth()`
Clear all authentication data (logout).

```javascript
AppState.clearAuth();
// Clears: auth state + localStorage
```

## 🔄 LocalStorage Auto-Sync

These paths automatically sync to localStorage:

| State Path | LocalStorage Key |
|------------|------------------|
| `auth.uniqueId` | `guest_unique_id` |
| `auth.name` | `guest_name` |
| `auth.surname` | `guest_surname` |
| `auth.roomNumber` | `room_number` |
| `auth.checkinDate` | `checkin_date` |
| `auth.checkoutDate` | `checkout_date` |
| `auth.teamId` | `team_id` |
| `localization.currentLanguage` | `appLanguage` |
| `dailyProgram.hiddenEvents` | `dailyProgramHiddenEvents` |
| `dailyProgram.reminders` | `dailyProgramReminders` |

## 🔌 Backward Compatibility

Legacy global variables are proxied to AppState:

```javascript
// These still work (proxied)
GUEST_UNIQUE_ID = 'abc';  // -> AppState.set('auth.uniqueId', 'abc')
const name = GUEST_NAME;  // -> AppState.get('auth.name')
socket = io();            // -> AppState.set('network.socket', io())
```

**Supported legacy variables:**
- `GUEST_UNIQUE_ID`
- `GUEST_NAME`
- `GUEST_SURNAME`
- `ROOM_NUMBER`
- `CHECKIN_DATE`
- `CHECKOUT_DATE`
- `TEAM_ID`
- `IS_AUTHENTICATED`
- `socket`
- `isTyping`
- `typingTimeout`
- `guestProfilePhoto`
- `teamAvatar`
- `guestInfoLoaded`
- `currentLanguage`
- `currentActivityDate`
- `currentActivityCategory`
- `activitiesData`

## 📝 Usage Examples

### Authentication Flow
```javascript
// Login
AppState.set('auth.uniqueId', userData.guest_unique_id);
AppState.set('auth.name', userData.guest_name);
AppState.set('auth.isAuthenticated', true);

// Check auth
if (AppState.get('auth.isAuthenticated')) {
    console.log('User logged in:', AppState.get('auth.name'));
}

// Logout
AppState.clearAuth();
```

### Language Change
```javascript
// Change language
AppState.set('localization.currentLanguage', 'en');
// Auto-syncs to localStorage['appLanguage']

// Get current language
const lang = AppState.get('localization.currentLanguage');
```

### Activities Management
```javascript
// Update activities
AppState.set('activities.data', newActivities);
AppState.set('activities.currentDate', '2026-01-20');

// Get activities
const activities = AppState.get('activities.data');
```

### Socket Connection
```javascript
// Set socket
AppState.set('network.socket', io(SERVER_URL));

// Get socket
const socket = AppState.get('network.socket');
socket.on('message', handleMessage);
```

## 🎯 Benefits

1. **Organization**: All state in one place, categorized logically
2. **Maintainability**: Easy to find and update state
3. **Auto-persistence**: Critical data auto-saves to localStorage
4. **Type Safety**: Clear structure for IDE autocomplete
5. **Debugging**: Single point to inspect entire app state
6. **Scalability**: Easy to add new state properties
7. **Backward Compatible**: Existing code continues to work

## 🚀 Migration Guide

### Before (Old Way)
```javascript
let GUEST_NAME = 'Misafir';
GUEST_NAME = 'John';
console.log(GUEST_NAME);
```

### After (New Way - Recommended)
```javascript
AppState.set('auth.name', 'John');
console.log(AppState.get('auth.name'));
```

### After (Legacy Compatible)
```javascript
GUEST_NAME = 'John';  // Still works via proxy
console.log(GUEST_NAME);
```

## 🔧 Debugging

### Inspect entire state
```javascript
console.log('AppState:', AppState.getState());
```

### Watch for changes
```javascript
AppState.on('auth.uniqueId', (newId) => {
    console.log('User ID changed:', newId);
});
```

### Check localStorage sync
```javascript
AppState.set('auth.name', 'Test');
console.log(localStorage.getItem('guest_name')); // 'Test'
```

## 📚 Best Practices

1. **Use AppState.get/set** for new code
2. **Keep legacy variables** for backward compatibility during transition
3. **Subscribe to changes** for reactive updates
4. **Use getState()** only for complex timer/cache objects
5. **Clear auth** properly on logout using `clearAuth()`

## 🎓 Advanced Usage

### Reactive Updates
```javascript
// Subscribe to language changes
AppState.on('localization.currentLanguage', (lang) => {
    applyTranslations(lang);
    updateUI();
});

// Change language - subscribers automatically notified
AppState.set('localization.currentLanguage', 'de');
```

### Complex State Updates
```javascript
// For objects/arrays, get reference and mutate
const timers = AppState.getState().dailyProgram.reminderTimers;
timers['event-123'] = setTimeout(() => {...}, 5000);

// Or use set for full replacement
AppState.set('activities.data', [...oldData, newActivity]);
```

---

**Created**: 2026-01-20  
**Version**: 1.0.0  
**Pattern**: Module Pattern + Observer Pattern  
**Compatibility**: Vanilla JS (ES6+)
