# A'la Carte Restaurant Reservations Module - Quick Reference

## 📋 Deliverables Overview

This module provides a complete restaurant reservation system for the resort hotel PWA. All documentation is provided in separate files:

1. **RESTAURANT-RESERVATIONS-DESIGN.md** - System architecture and design decisions
2. **scripts/restaurant-reservations-schema.sql** - PostgreSQL DDL schema
3. **RESTAURANT-RESERVATIONS-API.md** - REST API endpoint specifications with sample JSON
4. **RESTAURANT-RESERVATIONS-LOGIC.md** - Pseudocode for booking and cancellation logic
5. **RESTAURANT-RESERVATIONS-UI.md** - UI integration guide for settings.html and index.html

---

## 🚀 Quick Start

### 1. Database Setup
```bash
# Run the schema SQL
psql $DATABASE_URL -f scripts/restaurant-reservations-schema.sql
```

### 2. API Implementation
Add endpoints to `server.js` following patterns in:
- `RESTAURANT-RESERVATIONS-API.md` (endpoint specs)
- `RESTAURANT-RESERVATIONS-LOGIC.md` (business logic)

### 3. UI Integration
- **Admin (settings.html)**: Add "A'la Carte Reservations" section with 5 tabs
- **Guest (index.html)**: Add restaurant list, detail, booking, and reservations views

---

## 🏗️ Architecture Summary

### Core Entities
- **Restaurants**: Basic info, pricing, rules (JSON)
- **Session Templates**: Recurring time slots (e.g., "Dinner 1" daily 18:30-20:00)
- **Session Instances**: Dated instances from templates
- **Session Table Groups**: Capacity buckets per instance (2-top, 4-top, etc.)
- **Reservations**: Guest bookings with price snapshot
- **Reservation Table Assignments**: Links reservation to table group

### Key Features
- ✅ Concurrency-safe booking (transaction + row locks)
- ✅ Best-fit table assignment algorithm
- ✅ Price snapshot on reservation
- ✅ Per-session table inventory (not shared)
- ✅ Business rules engine (JSON per restaurant)
- ✅ Cutoff time validation
- ✅ Per-room limit enforcement

---

## 📊 Database Schema Quick Reference

### Tables
1. `restaurants` - Restaurant definitions
2. `session_templates` - Recurring session patterns
3. `session_instances` - Dated session instances
4. `session_table_groups` - Table inventory per instance
5. `reservations` - Guest bookings
6. `reservation_table_assignments` - Table assignment records

### Key Indexes
- `session_instances(restaurant_id, service_date)` - Availability queries
- `reservations(room_no, service_date)` - Per-room limit checks
- `session_table_groups(session_instance_id)` - Booking locks

---

## 🔌 API Endpoints Summary

### Admin (15 endpoints)
- `POST /admin/restaurants` - Create restaurant
- `PUT /admin/restaurants/:id` - Update restaurant
- `GET /admin/restaurants` - List restaurants
- `POST /admin/restaurants/:id/session-templates` - Create session template
- `PUT /admin/session-templates/:id` - Update template
- `PUT /admin/session-templates/:id/table-defaults` - Set table inventory
- `POST /admin/session-instances/generate` - Generate dated instances
- `PUT /admin/session-instances/:id/close` - Close session
- `PUT /admin/session-instances/:id/open` - Open session
- `PUT /admin/session-instances/:id/tables` - Override inventory

### Guest (5 endpoints)
- `GET /restaurants` - List available restaurants
- `GET /restaurants/:id/availability` - Get availability for date range
- `POST /reservations` - Create reservation (concurrency-safe)
- `GET /reservations?room_no=...` - Get guest reservations
- `DELETE /reservations/:id` - Cancel reservation

---

## 🔒 Concurrency Safety

### Booking Transaction Flow
1. Begin transaction
2. Lock `session_instances` row `FOR UPDATE`
3. Lock `session_table_groups` rows `FOR UPDATE`
4. Validate rules (cutoff, limits)
5. Find best-fit table capacity
6. Check capacity (assigned_count < table_count)
7. Insert reservation + assignment
8. Increment assigned_count
9. Commit

### Lock Strategy
- Row-level locks (`SELECT ... FOR UPDATE`)
- Transaction isolation: READ COMMITTED
- Always lock in same order (prevent deadlocks)

---

## 🎨 UI Components Summary

### settings.html (Admin)
1. **Restaurants Tab**: List, create/edit modal
2. **Sessions Tab**: Template list, create/edit modal
3. **Table Setup Tab**: Set default inventory per template
4. **Calendar Tab**: Generate instances, view/edit calendar
5. **Pricing & Rules Tab**: Update pricing and business rules

### index.html (Guest)
1. **Restaurant List**: Grid/list of available restaurants
2. **Restaurant Detail**: Photos, description, availability calendar
3. **Booking Form**: Select session, party size, confirm
4. **My Reservations**: List of bookings, cancel option

---

## 📝 Business Rules (JSON per Restaurant)

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

---

## 🔄 Booking Flow

1. Guest views restaurant list
2. Guest selects restaurant → sees availability
3. Guest selects date + session
4. Guest enters party size (adults/children)
5. System validates:
   - Cutoff time not passed
   - Per-room limit not exceeded
   - Capacity available
6. System assigns best-fit table
7. Reservation confirmed
8. Guest can view/cancel in "My Reservations"

---

## ⚠️ Important Notes

### v1 Limitations
- Table assignment by capacity bucket (not explicit table IDs)
- No table splitting (one reservation = one table)
- No waitlist functionality
- No deposit collection

### Future Enhancements
- Explicit table ID assignment
- Table splitting across multiple tables
- Waitlist queue
- Deposit/payment integration
- Email/SMS notifications
- Guest preferences

### Price Snapshot
- Always store `price_per_person` and `total_price` on reservation
- Prevents price changes from affecting past bookings
- Currency stored per restaurant, snapshot on reservation

### Session Management
- Templates define recurring patterns
- Instances are dated copies
- Each instance has its own table inventory
- Can override inventory per instance

---

## 🧪 Testing Checklist

### Admin Flow
- [ ] Create restaurant
- [ ] Create session template
- [ ] Set table defaults
- [ ] Generate session instances
- [ ] Override table inventory for specific date
- [ ] Close/open session instance

### Guest Flow
- [ ] View restaurant list
- [ ] View availability
- [ ] Create reservation (success)
- [ ] Create reservation (sold out)
- [ ] Create reservation (cutoff passed)
- [ ] Create reservation (limit exceeded)
- [ ] View my reservations
- [ ] Cancel reservation (success)
- [ ] Cancel reservation (deadline passed)

### Concurrency Tests
- [ ] Two simultaneous bookings for last table (one should fail)
- [ ] Verify assigned_count increments correctly
- [ ] Verify transaction rollback on error

---

## 📚 File Reference

| File | Purpose |
|------|---------|
| `RESTAURANT-RESERVATIONS-DESIGN.md` | System architecture and design |
| `scripts/restaurant-reservations-schema.sql` | PostgreSQL DDL |
| `RESTAURANT-RESERVATIONS-API.md` | API endpoint specifications |
| `RESTAURANT-RESERVATIONS-LOGIC.md` | Booking/cancellation pseudocode |
| `RESTAURANT-RESERVATIONS-UI.md` | UI integration guide |
| `RESTAURANT-RESERVATIONS-SUMMARY.md` | This file - quick reference |

---

## 🎯 Next Steps

1. **Review Documentation**: Read all 5 documentation files
2. **Database Setup**: Run schema SQL
3. **API Implementation**: Add endpoints to server.js
4. **UI Implementation**: Add sections to settings.html and index.html
5. **Testing**: Test all flows, especially concurrency
6. **Deployment**: Deploy and monitor

---

## 💡 Tips

- Start with database schema and API endpoints
- Test booking logic thoroughly (especially concurrency)
- Use existing UI patterns from settings.html and index.html
- Cache restaurant list (low update frequency)
- Show clear error messages to guests (sold out, cutoff passed, etc.)
- Use transactions for all booking operations
- Log all errors for debugging

---

**Questions?** Refer to the detailed documentation files for implementation specifics.
