# A'la Carte Restaurant Reservations - UI Integration Guide

## SETTINGS.HTML (Admin Interface)

### Overview
Add a new section/tab: **"A'la Carte Reservations"** to the existing settings.html admin interface.

---

### 1. RESTAURANTS TAB

#### 1.1 Restaurant List View
**Location:** Main content area of "Restaurants" tab

**Display:**
- Table or card grid showing all restaurants
- Columns/Cards: Name, Description (truncated), Price, Currency, Active status, Actions (Edit/Delete)
- "Add New Restaurant" button at top

**Data Fetch:**
```javascript
GET /admin/restaurants
```

**Render:**
- Loop through restaurants array
- Show active/inactive badge
- Edit button → opens edit modal
- Delete button → soft delete (sets deleted_at)

---

#### 1.2 Create/Edit Restaurant Modal
**Location:** Modal overlay (opens from list view)

**Form Fields:**
- **Name** (text input, required)
- **Description** (textarea, optional)
- **Photos** (file upload multiple, or URL input array)
  - Display uploaded photos as thumbnails
  - Allow remove photo
- **Active** (toggle/checkbox)
- **Price Per Person** (number input, required, min: 0)
- **Currency** (select dropdown: TRY, USD, EUR, etc.)
- **Rules JSON** (collapsible section or form fields):
  - Max Reservation Per Room Per Day (number, default: 1)
  - Max Reservation Per Stay (number, optional/null)
  - Cutoff Minutes (number, default: 120)
  - Cancellation Deadline Minutes (number, default: 240)
  - Child Pricing Policy (select: "free_under_12", "half_price", "full_price")
  - Allow Mix Table (checkbox, default: false)
  - Deposit Required (checkbox, default: false)

**Actions:**
- Save button → `POST /admin/restaurants` or `PUT /admin/restaurants/:id`
- Cancel button → close modal

**Validation:**
- Name required
- Price >= 0
- Cutoff minutes > 0
- Show inline errors

---

### 2. SESSIONS TAB

#### 2.1 Restaurant Selector
**Location:** Top of "Sessions" tab

**Display:**
- Dropdown/select to choose restaurant
- "Add New Session Template" button (disabled if no restaurant selected)

**Data Fetch:**
```javascript
GET /admin/restaurants (filter active only)
```

---

#### 2.2 Session Templates List
**Location:** Below restaurant selector

**Display:**
- Table/list of session templates for selected restaurant
- Columns: Name, Start Time, End Time, Active Weekdays, Active Status, Actions
- "Add New Session" button

**Data Fetch:**
```javascript
GET /admin/restaurants/:id/session-templates
// Or include in restaurant detail response
```

**Render:**
- Show weekdays as badges (Mon, Tue, Wed, etc.)
- Active/inactive toggle
- Edit button → opens edit modal
- Delete button → soft delete

---

#### 2.3 Create/Edit Session Template Modal
**Location:** Modal overlay

**Form Fields:**
- **Name** (text input, e.g., "Dinner 1", "Lunch")
- **Start Time** (time input, required)
- **End Time** (time input, required, must be > start_time)
- **Active Weekdays** (checkboxes: Mon, Tue, Wed, Thu, Fri, Sat, Sun)
- **Active** (toggle)

**Actions:**
- Save → `POST /admin/restaurants/:id/session-templates` or `PUT /admin/session-templates/:id`
- Cancel

**Validation:**
- End time > start time
- At least one weekday selected

---

### 3. TABLE SETUP TAB

#### 3.1 Session Template Selector
**Location:** Top of "Table Setup" tab

**Display:**
- Restaurant dropdown (filter)
- Session Template dropdown (filtered by restaurant)

---

#### 3.2 Table Inventory Form
**Location:** Below selectors

**Display:**
- Form to set default table inventory for selected session template
- Dynamic table group rows:
  - Capacity (number input, e.g., 2, 4, 5, 8)
  - Table Count (number input, min: 0)
  - Remove button
- "Add Table Group" button

**Example Display:**
```
Capacity | Table Count | Actions
---------|-------------|--------
2        | 10          | [Remove]
4        | 5           | [Remove]
5        | 6           | [Remove]
8        | 2           | [Remove]
[Add Table Group]
```

**Actions:**
- Save → `PUT /admin/session-templates/:id/table-defaults`
- Clear form after save

**Data Fetch:**
- Load existing defaults if available (may need new endpoint or include in template response)

---

### 4. CALENDAR TAB

#### 4.1 Restaurant & Date Range Selector
**Location:** Top of "Calendar" tab

**Display:**
- Restaurant dropdown
- Date range picker (from/to)
- "Generate Sessions" button

**Actions:**
- Generate → `POST /admin/session-instances/generate`
  - Shows confirmation: "Generate sessions for next 14 days?"
  - On success, refresh calendar view

---

#### 4.2 Calendar View
**Location:** Main content area

**Display:**
- Calendar grid (month view recommended, using FullCalendar if available)
- Each day shows:
  - Date
  - List of session instances for that day
  - Status badge (open/closed)
  - Available capacity summary (e.g., "2-top: 3/10, 4-top: 2/5")

**Data Fetch:**
```javascript
// Custom endpoint or aggregate from session_instances
GET /admin/session-instances?restaurant_id=:id&from=:from&to=:to
```

**Interactions:**
- Click session instance → opens detail/override modal
- Toggle open/closed status
- Override table inventory

---

#### 4.3 Session Instance Detail Modal
**Location:** Modal overlay (opens from calendar)

**Display:**
- Session info: Date, Time, Template Name, Status
- Current table inventory (editable):
  - Same form as Table Setup tab
- Actions:
  - Open/Close toggle
  - Override Tables → `PUT /admin/session-instances/:id/tables`
  - Save

**Data Fetch:**
```javascript
GET /admin/session-instances/:id
// Include table_groups in response
```

---

### 5. PRICING & RULES TAB

#### 5.1 Restaurant Selector
**Location:** Top of tab

**Display:**
- Restaurant dropdown

---

#### 5.2 Pricing Form
**Location:** Below selector

**Form Fields:**
- **Price Per Person** (number input)
- **Currency** (select)
- **Rules JSON** (same fields as Restaurant create/edit modal)

**Actions:**
- Save → `PUT /admin/restaurants/:id`
  - Updates price and rules
  - Note: Existing reservations keep price snapshot

**Display Warning:**
- "Note: Price changes will only affect new reservations. Existing reservations keep their original price."

---

## INDEX.HTML (Guest Interface)

### Overview
Add new sections/screens for restaurant reservations in the guest-facing PWA.

---

### 1. RESTAURANT LIST VIEW

#### 1.1 Navigation Entry
**Location:** Main navigation menu or home screen card

**Display:**
- Menu item: "Restaurants" or "Dining Reservations"
- Icon: Utensils/fork-knife icon

---

#### 1.2 Restaurant Grid/List
**Location:** New screen/page (e.g., `#restaurants` route)

**Display:**
- Grid or list of available restaurants
- Each card shows:
  - Restaurant photo (first photo or placeholder)
  - Name
  - Description (truncated, 2-3 lines)
  - Price per person + currency
  - "View Details" or "Book Now" button

**Data Fetch:**
```javascript
GET /restaurants?active_only=true
```

**Render:**
- Responsive grid (2 columns on mobile, 3-4 on tablet/desktop)
- Lazy load images
- Click card → navigate to restaurant detail

---

### 2. RESTAURANT DETAIL VIEW

#### 2.1 Restaurant Header
**Location:** Top of detail screen

**Display:**
- Photo carousel/gallery (all photos)
- Name
- Description (full)
- Price per person + currency

**Data Fetch:**
```javascript
GET /restaurants/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns restaurant info + availability
```

---

#### 2.2 Available Sessions List
**Location:** Below header

**Display:**
- Date picker or date tabs (next 7-14 days)
- For selected date, show sessions:
  - Session name (e.g., "Dinner 1")
  - Time range (e.g., "18:30 - 20:00")
  - Availability summary:
    - "2-top: 3 available"
    - "4-top: 2 available"
    - "5-top: 6 available"
  - "Book" button (disabled if sold out or cutoff passed)
  - Status badge (Open/Closed/Sold Out)

**Data Source:**
- From `/restaurants/:id/availability` response
- Filter by selected date

**Interactions:**
- Click "Book" → opens booking form

---

### 3. BOOKING FORM

#### 3.1 Booking Modal/Page
**Location:** Modal overlay or new screen

**Display:**
- Selected restaurant name
- Selected session: Date, Time, Session name
- Party size inputs:
  - Adults (number input, min: 1, default: 1)
  - Children (number input, min: 0, default: 0)
  - Total party size display (calculated)
- Special requests (textarea, optional)
- Price summary:
  - Adults: X × price = subtotal
  - Children: Y × price (or free/half) = subtotal
  - Total price
- Policies:
  - Cancellation deadline info
  - Cutoff time info
- "Confirm Booking" button

**Validation:**
- Total party size > 0
- Party size <= max table capacity available
- Show error if cutoff passed (shouldn't reach here if UI disabled button)

**Actions:**
- Confirm → `POST /reservations`
  - Show loading spinner
  - On success: Show success message, navigate to "My Reservations"
  - On error: Show error message (sold out, limit exceeded, etc.)

---

### 4. MY RESERVATIONS VIEW

#### 4.1 Navigation Entry
**Location:** Main navigation menu

**Display:**
- Menu item: "My Reservations"
- Badge showing count of upcoming confirmed reservations (optional)

---

#### 4.2 Reservations List
**Location:** New screen/page

**Display:**
- List of reservations (grouped by date or status)
- Each reservation card shows:
  - Restaurant photo + name
  - Date + Time + Session name
  - Party size (X adults, Y children)
  - Total price
  - Status badge (Confirmed/Cancelled/Completed)
  - Table assignment (e.g., "Table for 4")
  - "Cancel" button (if can_cancel = true)
  - Special requests (if any)

**Data Fetch:**
```javascript
GET /reservations?room_no=:room_no&status=confirmed
// room_no from session
```

**Filtering:**
- Tabs or filter: All / Upcoming / Past / Cancelled

**Interactions:**
- Click reservation → show detail (optional)
- Click "Cancel" → confirm dialog → `DELETE /reservations/:id`
  - On success: Remove from list or update status
  - On error: Show error (deadline passed, etc.)

---

### 5. CANCELLATION FLOW

#### 5.1 Cancel Confirmation Dialog
**Location:** Modal overlay (opens from "My Reservations")

**Display:**
- Warning message: "Are you sure you want to cancel this reservation?"
- Reservation details summary
- Cancellation deadline info
- "Cancel Reservation" button (primary, red)
- "Keep Reservation" button (secondary)

**Actions:**
- Cancel Reservation → `DELETE /reservations/:id`
  - Show loading
  - On success: Close dialog, update list
  - On error: Show error message

---

## UI COMPONENT PATTERNS

### Reusable Components

1. **Restaurant Card**
   - Photo, name, description, price
   - Used in list and detail views

2. **Session Card**
   - Date, time, availability summary
   - Book button with disabled state

3. **Reservation Card**
   - Restaurant info, date/time, party size, price
   - Status badge, cancel button

4. **Price Summary**
   - Breakdown of adults/children pricing
   - Total calculation

5. **Availability Badge**
   - Color-coded: Green (available), Yellow (limited), Red (sold out)

---

## DATA FETCHING PATTERNS

### Example: Restaurant List
```javascript
async function loadRestaurants() {
    try {
        const response = await fetch('/restaurants?active_only=true');
        const data = await response.json();
        if (data.success) {
            renderRestaurantList(data.data);
        }
    } catch (error) {
        showError('Failed to load restaurants');
    }
}
```

### Example: Availability Check
```javascript
async function loadAvailability(restaurantId, fromDate, toDate) {
    const response = await fetch(
        `/restaurants/${restaurantId}/availability?from=${fromDate}&to=${toDate}`
    );
    const data = await response.json();
    return data.data.availability;
}
```

### Example: Create Reservation
```javascript
async function createReservation(bookingData) {
    const response = await fetch('/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingData)
    });
    const data = await response.json();
    if (data.success) {
        showSuccess('Reservation confirmed!');
        navigateToReservations();
    } else {
        showError(data.error);
    }
}
```

---

## INTEGRATION NOTES

### Routing (if using client-side routing)
- `/restaurants` → Restaurant list
- `/restaurants/:id` → Restaurant detail
- `/reservations` → My Reservations
- `/reservations/:id` → Reservation detail (optional)

### State Management
- Cache restaurant list (low update frequency)
- Refresh availability on date change
- Refresh reservations list after booking/cancellation

### Error Handling
- Network errors: Show retry button
- Validation errors: Show inline field errors
- Business logic errors: Show toast/alert (sold out, limit exceeded)

### Loading States
- Show skeleton loaders for lists
- Show spinner for form submissions
- Disable buttons during API calls

### Responsive Design
- Mobile-first approach
- Touch-friendly buttons (min 44px height)
- Modal full-screen on mobile, centered on desktop

---

## STYLING CONSISTENCY

Use existing CSS variables from index.html:
- `--voyage-navy`, `--voyage-blue`, `--voyage-gold`
- Existing button styles
- Existing card/modal styles
- Consistent spacing and typography
