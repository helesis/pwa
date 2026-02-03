# A'la Carte Restaurant Reservations - API Specification

## Base URL
- Admin: `/admin/*`
- Guest: `/restaurants/*`, `/reservations/*`

## Authentication
- Admin endpoints: Assume admin session (existing pattern)
- Guest endpoints: Assume guest session with `room_no` available

---

## ADMIN ENDPOINTS

### 1. Create Restaurant
**POST** `/admin/restaurants`

**Request Body:**
```json
{
  "name": "Fine Dining Restaurant",
  "description": "Elegant dining experience with ocean view",
  "photos": ["/uploads/restaurant1.jpg", "/uploads/restaurant2.jpg"],
  "active": true,
  "price_per_person": 500.00,
  "currency": "TRY",
  "rules_json": {
    "max_reservation_per_room_per_day": 1,
    "max_reservation_per_stay": null,
    "cutoff_minutes": 120,
    "cancellation_deadline_minutes": 240,
    "child_pricing_policy": "free_under_12",
    "allow_mix_table": false,
    "deposit_required": false
  }
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Fine Dining Restaurant",
    "description": "Elegant dining experience with ocean view",
    "photos": ["/uploads/restaurant1.jpg", "/uploads/restaurant2.jpg"],
    "active": true,
    "price_per_person": 500.00,
    "currency": "TRY",
    "rules_json": { ... },
    "created_at": "2024-03-15T10:00:00Z",
    "updated_at": "2024-03-15T10:00:00Z"
  }
}
```

---

### 2. Update Restaurant
**PUT** `/admin/restaurants/:id`

**Request Body:** (same as create, all fields optional)

**Response (200 OK):**
```json
{
  "success": true,
  "data": { ... }
}
```

---

### 3. Get All Restaurants (Admin)
**GET** `/admin/restaurants`

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Fine Dining Restaurant",
      "description": "...",
      "photos": [...],
      "active": true,
      "price_per_person": 500.00,
      "currency": "TRY",
      "rules_json": { ... },
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

---

### 4. Create Session Template
**POST** `/admin/restaurants/:id/session-templates`

**Request Body:**
```json
{
  "name": "Dinner 1",
  "start_time": "18:30:00",
  "end_time": "20:00:00",
  "active_weekdays": [1, 2, 3, 4, 5, 6, 7],
  "active": true
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "restaurant_id": 1,
    "name": "Dinner 1",
    "start_time": "18:30:00",
    "end_time": "20:00:00",
    "active_weekdays": [1, 2, 3, 4, 5, 6, 7],
    "active": true,
    "created_at": "...",
    "updated_at": "..."
  }
}
```

---

### 5. Update Session Template
**PUT** `/admin/session-templates/:id`

**Request Body:** (same as create, all fields optional)

**Response (200 OK):**
```json
{
  "success": true,
  "data": { ... }
}
```

---

### 6. Set Default Table Inventory for Session Template
**PUT** `/admin/session-templates/:id/table-defaults`

**Request Body:**
```json
{
  "table_groups": [
    { "capacity": 2, "table_count": 10 },
    { "capacity": 4, "table_count": 5 },
    { "capacity": 5, "table_count": 6 },
    { "capacity": 8, "table_count": 2 }
  ]
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Table defaults saved. Will be applied to new session instances."
}
```

**Note:** This stores defaults on the template. When generating instances, these defaults are copied to `session_table_groups`.

---

### 7. Generate Session Instances
**POST** `/admin/session-instances/generate`

**Request Body:**
```json
{
  "restaurant_id": 1,
  "from_date": "2024-03-15",
  "to_date": "2024-03-29",
  "session_template_ids": [1, 2] // Optional: specific templates, or all if omitted
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "generated_count": 28,
    "instances": [
      {
        "id": 101,
        "session_template_id": 1,
        "restaurant_id": 1,
        "service_date": "2024-03-15",
        "start_time": "18:30:00",
        "end_time": "20:00:00",
        "status": "open"
      }
    ]
  }
}
```

---

### 8. Close Session Instance
**PUT** `/admin/session-instances/:id/close`

**Request Body:** (empty or optional reason)

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": 101,
    "status": "closed",
    "updated_at": "..."
  }
}
```

---

### 9. Open Session Instance
**PUT** `/admin/session-instances/:id/open`

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": 101,
    "status": "open",
    "updated_at": "..."
  }
}
```

---

### 10. Override Table Inventory for Session Instance
**PUT** `/admin/session-instances/:id/tables`

**Request Body:**
```json
{
  "table_groups": [
    { "capacity": 2, "table_count": 8 },
    { "capacity": 4, "table_count": 4 },
    { "capacity": 5, "table_count": 5 }
  ]
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "session_instance_id": 101,
    "table_groups": [
      { "id": 201, "capacity": 2, "table_count": 8, "assigned_count": 0 },
      { "id": 202, "capacity": 4, "table_count": 4, "assigned_count": 0 },
      { "id": 203, "capacity": 5, "table_count": 5, "assigned_count": 0 }
    ]
  }
}
```

**Note:** This replaces existing table groups for this instance. If reservations exist, ensure new inventory >= current assignments.

---

## GUEST ENDPOINTS

### 11. Get Available Restaurants
**GET** `/restaurants`

**Query Parameters:**
- `active_only` (optional, default: true) - Filter active restaurants only

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Fine Dining Restaurant",
      "description": "Elegant dining experience with ocean view",
      "photos": ["/uploads/restaurant1.jpg"],
      "price_per_person": 500.00,
      "currency": "TRY"
    }
  ]
}
```

---

### 12. Get Restaurant Availability
**GET** `/restaurants/:id/availability`

**Query Parameters:**
- `from` (required) - Start date: `YYYY-MM-DD`
- `to` (required) - End date: `YYYY-MM-DD`

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "restaurant": {
      "id": 1,
      "name": "Fine Dining Restaurant",
      "description": "...",
      "photos": [...],
      "price_per_person": 500.00,
      "currency": "TRY"
    },
    "availability": [
      {
        "session_instance_id": 101,
        "service_date": "2024-03-15",
        "session_name": "Dinner 1",
        "start_time": "18:30:00",
        "end_time": "20:00:00",
        "status": "open",
        "table_availability": [
          { "capacity": 2, "available": 8, "total": 10 },
          { "capacity": 4, "available": 3, "total": 5 },
          { "capacity": 5, "available": 6, "total": 6 }
        ],
        "can_book": true,
        "cutoff_passed": false
      },
      {
        "session_instance_id": 102,
        "service_date": "2024-03-15",
        "session_name": "Dinner 2",
        "start_time": "20:15:00",
        "end_time": "21:45:00",
        "status": "open",
        "table_availability": [...],
        "can_book": true,
        "cutoff_passed": false
      }
    ]
  }
}
```

---

### 13. Create Reservation
**POST** `/reservations`

**Request Body:**
```json
{
  "restaurant_id": 1,
  "session_instance_id": 101,
  "pax_adult": 2,
  "pax_child": 1,
  "special_requests": "Window seat preferred"
}
```

**Note:** `room_no`, `guest_ids`, `guest_names` are extracted from session (PMS integration).

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": 501,
    "room_no": "101",
    "guest_ids": ["guest_123", "guest_124"],
    "guest_names": ["John Doe", "Jane Doe"],
    "restaurant_id": 1,
    "session_instance_id": 101,
    "pax_adult": 2,
    "pax_child": 1,
    "total_pax": 3,
    "price_per_person": 500.00,
    "total_price": 1000.00,
    "currency": "TRY",
    "status": "confirmed",
    "special_requests": "Window seat preferred",
    "table_assignment": {
      "capacity": 4,
      "table_group_id": 202
    },
    "created_at": "2024-03-14T15:30:00Z"
  }
}
```

**Error Response (409 Conflict - Sold Out):**
```json
{
  "success": false,
  "error": "No available tables for party size",
  "code": "SOLD_OUT"
}
```

**Error Response (400 Bad Request - Cutoff Passed):**
```json
{
  "success": false,
  "error": "Booking cutoff time has passed",
  "code": "CUTOFF_PASSED",
  "cutoff_time": "2024-03-15T16:30:00Z"
}
```

**Error Response (400 Bad Request - Limit Exceeded):**
```json
{
  "success": false,
  "error": "Maximum reservations per room per day exceeded",
  "code": "LIMIT_EXCEEDED"
}
```

---

### 14. Get Guest Reservations
**GET** `/reservations`

**Query Parameters:**
- `room_no` (required) - Room number from session
- `status` (optional) - Filter by status: `confirmed`, `cancelled`, `completed`
- `from_date` (optional) - Filter from date: `YYYY-MM-DD`
- `to_date` (optional) - Filter to date: `YYYY-MM-DD`

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "id": 501,
      "room_no": "101",
      "restaurant": {
        "id": 1,
        "name": "Fine Dining Restaurant",
        "photos": [...]
      },
      "session": {
        "session_instance_id": 101,
        "service_date": "2024-03-15",
        "session_name": "Dinner 1",
        "start_time": "18:30:00",
        "end_time": "20:00:00"
      },
      "pax_adult": 2,
      "pax_child": 1,
      "total_pax": 3,
      "price_per_person": 500.00,
      "total_price": 1000.00,
      "currency": "TRY",
      "status": "confirmed",
      "special_requests": "Window seat preferred",
      "table_assignment": {
        "capacity": 4
      },
      "can_cancel": true,
      "cancellation_deadline": "2024-03-15T14:30:00Z",
      "created_at": "2024-03-14T15:30:00Z"
    }
  ]
}
```

---

### 15. Cancel Reservation
**DELETE** `/reservations/:id`

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": 501,
    "status": "cancelled",
    "cancelled_at": "2024-03-14T16:00:00Z"
  }
}
```

**Error Response (400 Bad Request - Cancellation Deadline Passed):**
```json
{
  "success": false,
  "error": "Cancellation deadline has passed",
  "code": "CANCELLATION_DEADLINE_PASSED",
  "deadline": "2024-03-15T14:30:00Z"
}
```

---

## ERROR RESPONSES

All endpoints may return:

**400 Bad Request:**
```json
{
  "success": false,
  "error": "Validation error message",
  "code": "VALIDATION_ERROR",
  "details": { ... }
}
```

**404 Not Found:**
```json
{
  "success": false,
  "error": "Resource not found",
  "code": "NOT_FOUND"
}
```

**500 Internal Server Error:**
```json
{
  "success": false,
  "error": "Internal server error",
  "code": "INTERNAL_ERROR"
}
```
