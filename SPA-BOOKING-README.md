# SPA Booking Feature Implementation

## Overview

This document describes the SPA Reservation frontend flow that has been added to the existing mobile PWA.

## Features Implemented

### 1. SPA Booking Wizard
A multi-step booking flow accessible from the "Spa Rezervasyonları" section:
- **Step 1: Service Selection** - Choose from available SPA services
- **Step 2: Date Selection** - Calendar view showing availability heat indicators (GREEN/YELLOW/RED)
- **Step 3: Time Slot Selection** - Available time slots for the selected date
- **Step 4: Therapist Selection** - Choose from available therapists for the selected slot
- **Step 5: Confirmation** - Review and submit the request with optional note

### 2. SPA Reservations Management
- **"Spa Rezervasyonları" Section**: Shows all SPA requests with status badges
- **"Rezervasyonlarım" Section**: Includes a new "SPA Taleplerim" card showing SPA requests
- Status badges: PENDING (yellow), CONFIRMED (green), REJECTED/CANCELLED/EXPIRED (gray/red)
- Request details modal with cancel functionality

### 3. API Client
Located in `spaApi` object with methods:
- `getServices()` - Fetch available SPA services
- `getAvailability(serviceId, from, to)` - Get availability for date range
- `createRequest(payload)` - Submit a new SPA request
- `listMyRequests()` - Get user's SPA requests
- `cancelRequest(requestId)` - Cancel a request

## Integration Points

### Entry Point
The booking wizard is accessible via:
- **"Spa Rezervasyonları" section**: "Yeni SPA Talebi Oluştur" button
- Function: `openSpaBookingWizard()`

### Navigation
- The feature integrates with existing section navigation
- When switching to "reservations" section, SPA requests are automatically loaded
- Function: `loadSpaReservations()` and `loadSpaReservationsForMyReservations()`

## API Endpoints Required

The frontend expects the following backend endpoints:

1. `GET /api/spa/services` - Returns array of service objects
2. `GET /api/spa/availability?serviceId=...&from=YYYY-MM-DD&to=YYYY-MM-DD` - Returns availability data
3. `POST /api/spa/requests` - Creates a new request
4. `GET /api/spa/requests?mine=true` - Returns user's requests
5. `POST /api/spa/requests/:requestId/cancel` - Cancels a request

## Guest Stay Range

The booking wizard automatically calculates the available date range:
- `from = max(todayLocal, arrivalDate)`
- `to = departureDateMinusOne` (departure date - 1 day)

Uses guest session data: `CHECKIN_DATE` and `CHECKOUT_DATE`

## UX Features

1. **Availability Warnings**: Shows warning if availability data is older than 10 minutes
2. **"En erken uygun" Button**: Quick-selects the first available slot across the stay range
3. **Status Indicators**: Visual heat map on calendar (GREEN/YELLOW/RED)
4. **Slot Availability**: Shows AVAILABLE/LIMITED/FULL states
5. **Disclaimer**: Always shows "Bu bir taleptir. SPA ekibi onayladıktan sonra kesinleşir." on confirmation screen

## Styling

All styles are added inline in the main HTML file. Key classes:
- `.spa-booking-modal` - Main modal container
- `.spa-booking-step` - Individual wizard steps
- `.spa-calendar-day` - Calendar day cells with heat indicators
- `.spa-status-badge` - Status badges for requests
- `.spa-request-item` - Request list items

## Internationalization

Translations added for:
- Turkish (tr) - Default
- English (en)
- German (de)
- Russian (ru)

Key translation keys:
- `spaRequests`, `newSpaRequest`, `spaBookingTitle`, `selectService`, `selectDate`, `selectTime`, `selectTherapist`, `confirmRequest`, `requestNote`, `submitRequest`, `earliestAvailable`, `lastUpdate`, `availabilityWarning`, `requestPending`, `requestConfirmed`, `requestRejected`, `requestCancelled`, `requestExpired`, `cancelRequest`, `requestDetails`

## Timezone

Date rendering uses browser's locale settings. For Europe/Istanbul timezone, ensure:
- Server returns dates in ISO format with timezone
- Client uses `toLocaleDateString('tr-TR', ...)` for Turkish locale formatting

## Testing Checklist

- [ ] Service list loads correctly
- [ ] Calendar shows correct date range (arrival to departure-1)
- [ ] Heat indicators display correctly
- [ ] Time slots show availability states
- [ ] Therapist selection works
- [ ] Request submission succeeds
- [ ] Request list displays with correct statuses
- [ ] Cancel functionality works
- [ ] "En erken uygun" button selects earliest slot
- [ ] Warning appears when availability data is stale (>10 min)
- [ ] Translations work for all languages

## Notes

- The booking wizard is a modal overlay, not a separate route
- All state is managed in `spaBookingState` object
- Error handling includes user-friendly alerts
- The feature gracefully handles missing data (no services, no availability, etc.)
