# SPA Backend API Implementation

## Overview

This document describes the backend API implementation for the SPA booking feature. The backend uses PostgreSQL database with snapshot-based availability data.

## Database Schema

### Tables Created

1. **spa_services** - Stores SPA service definitions
   - `id` (VARCHAR(50), PRIMARY KEY) - Service identifier
   - `name` (VARCHAR(255)) - Service name
   - `duration_min` (INTEGER) - Service duration in minutes
   - `price` (DECIMAL) - Service price
   - `currency` (VARCHAR(3)) - Currency code (default: EUR)
   - `category` (VARCHAR(100)) - Service category
   - `short_description` (TEXT) - Brief description
   - `description` (TEXT) - Full description
   - `is_active` (BOOLEAN) - Active status
   - `display_order` (INTEGER) - Display order
   - `created_at`, `updated_at` (TIMESTAMP)

2. **spa_availability** - Snapshot table from MSSQL replica
   - `id` (SERIAL, PRIMARY KEY)
   - `service_id` (VARCHAR(50), FK) - References spa_services
   - `date` (DATE) - Date of availability
   - `start_time` (TIMESTAMP WITH TIME ZONE) - Slot start time
   - `end_time` (TIMESTAMP WITH TIME ZONE) - Slot end time
   - `availability_status` (VARCHAR(20)) - AVAILABLE/LIMITED/FULL
   - `therapist_id` (VARCHAR(50)) - Therapist identifier (nullable)
   - `therapist_display_name` (VARCHAR(255)) - Therapist name
   - `therapist_level` (VARCHAR(50)) - Senior/Standard/etc
   - `therapist_tags` (JSONB) - Array of therapist tags
   - `last_updated_at` (TIMESTAMP) - Snapshot timestamp
   - UNIQUE constraint on `(service_id, date, start_time, COALESCE(therapist_id, ''))`

3. **spa_requests** - Guest booking requests
   - `id` (SERIAL, PRIMARY KEY)
   - `request_id` (VARCHAR(100), UNIQUE) - Unique request identifier
   - `guest_unique_id` (VARCHAR(255), FK) - References rooms(guest_unique_id)
   - `service_id` (VARCHAR(50), FK) - References spa_services
   - `start_time` (TIMESTAMP WITH TIME ZONE) - Requested start time
   - `end_time` (TIMESTAMP WITH TIME ZONE) - Requested end time
   - `therapist_id` (VARCHAR(50)) - Selected therapist
   - `therapist_display_name` (VARCHAR(255)) - Therapist name (cached)
   - `note` (TEXT) - Guest note/request
   - `status` (VARCHAR(20)) - PENDING/CONFIRMED/REJECTED/CANCELLED/EXPIRED
   - `created_at`, `updated_at` (TIMESTAMP)
   - `cancelled_at`, `confirmed_at`, `rejected_at` (TIMESTAMP, nullable)

## API Endpoints

### 1. GET /api/spa/services
Returns list of active SPA services.

**Response:**
```json
[
  {
    "id": "svc_1",
    "name": "Swedish Massage",
    "durationMin": 50,
    "price": 120,
    "currency": "EUR",
    "category": "Massage",
    "shortDescription": "Relaxing full-body massage"
  }
]
```

### 2. GET /api/spa/availability
Returns availability data for a service within a date range.

**Query Parameters:**
- `serviceId` (required) - Service identifier
- `from` (required) - Start date (YYYY-MM-DD)
- `to` (required) - End date (YYYY-MM-DD)

**Response:**
```json
{
  "serviceId": "svc_1",
  "from": "2026-01-10",
  "to": "2026-01-16",
  "lastUpdatedAt": "2026-01-10T10:05:00Z",
  "days": [
    {
      "date": "2026-01-10",
      "heat": "GREEN",
      "slots": [
        {
          "start": "2026-01-10T09:00:00+03:00",
          "end": "2026-01-10T09:50:00+03:00",
          "availability": "AVAILABLE",
          "therapists": [
            {
              "id": "t_1",
              "displayName": "Ayşe",
              "level": "Senior",
              "tags": ["Relax"]
            }
          ]
        }
      ]
    }
  ]
}
```

**Heat Indicators:**
- `GREEN`: >=60% slots available
- `YELLOW`: 30-60% slots available
- `RED`: <30% slots available

**Availability Status:**
- `AVAILABLE`: 3+ therapists available
- `LIMITED`: 1-2 therapists available
- `FULL`: No therapists available

### 3. POST /api/spa/requests
Creates a new SPA booking request.

**Authentication:** Required (guest_unique_id cookie)

**Request Body:**
```json
{
  "serviceId": "svc_1",
  "start": "2026-01-10T09:00:00+03:00",
  "end": "2026-01-10T09:50:00+03:00",
  "therapistId": "t_1",
  "note": "No strong pressure please"
}
```

**Response:**
```json
{
  "requestId": "req_123",
  "status": "PENDING",
  "createdAt": "2026-01-10T10:06:00Z"
}
```

### 4. GET /api/spa/requests?mine=true
Returns the authenticated guest's SPA requests.

**Authentication:** Required (guest_unique_id cookie)

**Query Parameters:**
- `mine` (required) - Must be "true"

**Response:**
```json
[
  {
    "requestId": "req_123",
    "serviceName": "Swedish Massage",
    "start": "2026-01-10T09:00:00+03:00",
    "end": "2026-01-10T09:50:00+03:00",
    "therapistDisplayName": "Ayşe",
    "status": "PENDING",
    "updatedAt": "2026-01-10T10:06:00Z"
  }
]
```

**Status Values:**
- `PENDING` - Awaiting SPA desk confirmation
- `CONFIRMED` - Request confirmed
- `REJECTED` - Request rejected
- `CANCELLED` - Request cancelled by guest
- `EXPIRED` - Request expired

### 5. POST /api/spa/requests/:requestId/cancel
Cancels a SPA request.

**Authentication:** Required (guest_unique_id cookie)

**Path Parameters:**
- `requestId` - Request identifier

**Response:**
```json
{
  "ok": true
}
```

**Validation:**
- Only allows cancellation of PENDING or CONFIRMED requests
- Request must belong to the authenticated guest

## Availability Data Source

The `spa_availability` table is designed to be populated from MSSQL replica snapshots. The snapshot process should:

1. Sync availability data periodically (e.g., every 5-10 minutes)
2. Update `last_updated_at` timestamp for tracking freshness
3. Store slot-level availability with therapist details
4. Handle FULL slots by either:
   - Not including rows for that slot, OR
   - Including one row with `availability_status='FULL'` and `therapist_id=NULL`

## Initial Data Setup

To populate initial SPA services, insert into `spa_services`:

```sql
INSERT INTO spa_services (id, name, duration_min, price, currency, category, short_description, display_order)
VALUES 
  ('svc_1', 'Swedish Massage', 50, 120.00, 'EUR', 'Massage', 'Relaxing full-body massage', 1),
  ('svc_2', 'Deep Tissue Massage', 60, 150.00, 'EUR', 'Massage', 'Intensive muscle therapy', 2),
  ('svc_3', 'Hot Stone Massage', 75, 180.00, 'EUR', 'Massage', 'Heated stones for deep relaxation', 3);
```

## Error Handling

All endpoints return appropriate HTTP status codes:
- `200` - Success
- `201` - Created (for POST requests)
- `400` - Bad Request (missing/invalid parameters)
- `401` - Unauthorized (authentication required)
- `404` - Not Found (resource not found)
- `500` - Internal Server Error (database/server errors)

Error responses follow format:
```json
{
  "error": "Error message"
}
```

## Notes

1. **Timezone**: All timestamps use `TIMESTAMP WITH TIME ZONE` and are stored in UTC. The frontend handles timezone conversion to Europe/Istanbul.

2. **Snapshot Freshness**: The `last_updated_at` field in availability data is used by the frontend to show freshness warnings (>10 minutes).

3. **Therapist Grouping**: Availability query groups therapists by slot (date + start_time + end_time). Slot availability is calculated based on therapist count:
   - 0 therapists → FULL
   - 1-2 therapists → LIMITED
   - 3+ therapists → AVAILABLE

4. **Request ID Format**: Uses format `req_{timestamp}_{random}` for uniqueness.

5. **Database Migrations**: Tables are automatically created on first run via `addNewTablesIfNeeded()` function.
