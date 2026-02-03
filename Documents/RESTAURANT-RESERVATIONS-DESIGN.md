# A'la Carte Restaurant Reservations Module - System Design

## 1. Architecture Overview

### 1.1 Core Components
- **Data Layer**: PostgreSQL database with transaction-safe booking logic
- **API Layer**: RESTful endpoints for admin and guest operations
- **UI Layer**: Admin interface (settings.html) and guest interface (index.html)
- **Business Logic**: Concurrency-safe reservation system with capacity management

### 1.2 Data Flow
```
Guest Booking Flow:
1. Guest views restaurant list → GET /restaurants
2. Guest selects restaurant → GET /restaurants/:id/availability
3. Guest selects session + pax → POST /reservations (with transaction lock)
4. System assigns table capacity bucket (best-fit algorithm)
5. Reservation confirmed → GET /reservations?room_no=...

Admin Management Flow:
1. Admin creates restaurant → POST /admin/restaurants
2. Admin creates session templates → POST /admin/restaurants/:id/session-templates
3. Admin sets table defaults → PUT /admin/session-templates/:id/table-defaults
4. Admin generates session instances → POST /admin/session-instances/generate
5. Admin manages availability → PUT /admin/session-instances/:id/close|open
```

### 1.3 Key Design Decisions

**Table Assignment Strategy (v1)**
- Use capacity buckets (2-top, 4-top, 5-top, custom) rather than individual table IDs
- Best-fit algorithm: smallest capacity that fits party size
- No table splitting (one reservation = one table group)
- Future: Can extend to explicit table IDs without schema changes

**Concurrency Control**
- PostgreSQL transactions with `SELECT ... FOR UPDATE` on session_table_groups
- Pessimistic locking prevents double-booking
- Transaction isolation level: READ COMMITTED (default)

**Session Management**
- Template-based: Define once, generate instances for dates
- Instance-level overrides: Close/open specific dates, override table inventory
- Automatic generation: Admin can generate next N days from templates

**Price Snapshot**
- Store `price_per_person` and `total_price` on reservation record
- Prevents price changes from affecting past bookings
- Currency stored per restaurant, snapshot on reservation

## 2. Data Model

### 2.1 Entity Relationships
```
restaurants (1) ──< (N) session_templates
session_templates (1) ──< (N) session_instances
session_instances (1) ──< (N) session_table_groups
session_instances (1) ──< (N) reservations
reservations (1) ──< (1) reservation_table_assignments
```

### 2.2 Core Entities

**Restaurant**
- Basic info: name, description, photos (JSON array)
- Pricing: price_per_person, currency
- Rules: JSON object (max_reservation_per_room_per_day, cutoff_minutes, etc.)
- Status: active flag

**Session Template**
- Belongs to restaurant
- Time slots: start_time, end_time
- Recurrence: active_weekdays (bitmask or JSON array)
- Default table inventory (copied to instances)

**Session Instance**
- Dated instance: service_date, start_time, end_time
- Status: open/closed (can override template)
- Links to template for defaults

**Session Table Groups**
- Per session instance
- Capacity buckets: capacity (INT), table_count (INT)
- Tracks: assigned_count (INT) - incremented on booking
- Locked during booking transaction

**Reservation**
- Guest info: room_no, guest_ids (JSON array), guest_names (JSON array)
- Party: pax_adult, pax_child
- Session: restaurant_id, session_instance_id
- Pricing snapshot: price_per_person, total_price, currency
- Status: confirmed, cancelled, completed
- Timestamps: created_at, cancelled_at

**Reservation Table Assignment**
- Links reservation to table group
- Stores: session_table_group_id, capacity
- One assignment per reservation (v1)

## 3. Business Rules Engine

Rules stored as JSON per restaurant (can be overridden per session):
```json
{
  "max_reservation_per_room_per_day": 1,
  "max_reservation_per_stay": null,
  "cutoff_minutes": 120,
  "cancellation_deadline_minutes": 240,
  "child_pricing_policy": "free_under_12",
  "allow_mix_table": false,
  "deposit_required": false
}
```

**Validation Points:**
1. **Booking Time**: Check cutoff_minutes before session start
2. **Per-Room Limit**: Count existing reservations for room_no + service_date
3. **Capacity Check**: Verify table_group.assigned_count < table_count
4. **Session Status**: Ensure session_instance.status = 'open'
5. **Cancellation**: Check cancellation_deadline_minutes before session start

## 4. Concurrency Safety

### 4.1 Booking Transaction Flow
```sql
BEGIN;
  -- 1. Lock session instance and table groups
  SELECT * FROM session_instances WHERE id = $1 FOR UPDATE;
  SELECT * FROM session_table_groups 
    WHERE session_instance_id = $1 
    FOR UPDATE;
  
  -- 2. Validate rules (cutoff, limits)
  -- 3. Find best-fit capacity
  -- 4. Check capacity: assigned_count < table_count
  -- 5. Insert reservation
  -- 6. Insert assignment
  -- 7. Increment assigned_count
COMMIT;
```

### 4.2 Lock Strategy
- **Row-level locks**: `FOR UPDATE` on session_table_groups prevents concurrent modifications
- **Transaction isolation**: READ COMMITTED ensures consistent reads
- **Deadlock prevention**: Always lock in same order (session_instance → table_groups)

## 5. API Design Principles

### 5.1 Admin Endpoints
- Prefix: `/admin/*`
- Authentication: Assume admin session (existing pattern)
- Response: JSON with success/error

### 5.2 Guest Endpoints
- Prefix: `/restaurants/*`, `/reservations/*`
- Authentication: Assume guest session (room_no from session)
- Response: JSON with data or error

### 5.3 Error Handling
- 400: Bad request (validation errors)
- 404: Not found
- 409: Conflict (sold out, already booked)
- 500: Server error

## 6. UI Integration Points

### 6.1 settings.html Structure
- Tab-based navigation: Restaurants, Sessions, Table Setup, Calendar, Pricing & Rules
- Forms for CRUD operations
- Calendar view for session instance management
- Real-time availability display

### 6.2 index.html Structure
- Restaurant list/grid view
- Restaurant detail modal/page
- Session selection with availability
- Booking confirmation screen
- My Reservations list
- Cancellation flow

## 7. Performance Considerations

### 7.1 Database Indexes
- `session_instances(service_date, restaurant_id)` - availability queries
- `reservations(room_no, service_date)` - per-room limit checks
- `reservations(session_instance_id, status)` - capacity calculations
- `session_table_groups(session_instance_id)` - booking locks

### 7.2 Query Optimization
- Use `EXPLAIN ANALYZE` for slow queries
- Cache restaurant list (low update frequency)
- Batch session instance generation
- Aggregate availability counts in single query

## 8. Future Enhancements (Out of Scope for v1)

- Explicit table ID assignment (vs capacity buckets)
- Table splitting (multiple tables per reservation)
- Waitlist functionality
- Deposit collection
- Email/SMS notifications
- Guest preferences (window seat, etc.)
- Recurring reservations
- Group bookings (multiple rooms)
