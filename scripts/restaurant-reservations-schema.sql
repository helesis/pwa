-- ============================================================================
-- A'la Carte Restaurant Reservations Module - PostgreSQL Schema
-- ============================================================================
-- This schema supports restaurant reservations with session-based table management
-- and concurrency-safe booking logic.

-- ============================================================================
-- 1. RESTAURANTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS restaurants (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    photos JSONB DEFAULT '[]'::jsonb, -- Array of photo URLs/paths
    active BOOLEAN DEFAULT true,
    price_per_person DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'TRY',
    rules_json JSONB DEFAULT '{
        "max_reservation_per_room_per_day": 1,
        "max_reservation_per_stay": null,
        "cutoff_minutes": 120,
        "cancellation_deadline_minutes": 240,
        "child_pricing_policy": "free_under_12",
        "allow_mix_table": false,
        "deposit_required": false
    }'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE NULL
);

CREATE INDEX idx_restaurants_active ON restaurants(active) WHERE deleted_at IS NULL;
CREATE INDEX idx_restaurants_deleted ON restaurants(deleted_at) WHERE deleted_at IS NOT NULL;

-- ============================================================================
-- 2. SESSION TEMPLATES
-- ============================================================================
-- Templates define recurring sessions (e.g., "Dinner 1" every day 18:30-20:00)
CREATE TABLE IF NOT EXISTS session_templates (
    id SERIAL PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL, -- e.g., "Dinner 1", "Lunch", "Breakfast"
    start_time TIME NOT NULL, -- e.g., '18:30:00'
    end_time TIME NOT NULL, -- e.g., '20:00:00'
    active_weekdays INTEGER[] DEFAULT ARRAY[1,2,3,4,5,6,7], -- 1=Monday, 7=Sunday
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE NULL,
    CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

CREATE INDEX idx_session_templates_restaurant ON session_templates(restaurant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_session_templates_active ON session_templates(active, restaurant_id) WHERE deleted_at IS NULL;

-- ============================================================================
-- 3. SESSION INSTANCES
-- ============================================================================
-- Dated instances derived from templates (e.g., "Dinner 1" on 2024-03-15)
CREATE TABLE IF NOT EXISTS session_instances (
    id SERIAL PRIMARY KEY,
    session_template_id INTEGER NOT NULL REFERENCES session_templates(id) ON DELETE CASCADE,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    service_date DATE NOT NULL, -- The actual date of service
    start_time TIME NOT NULL, -- Can override template
    end_time TIME NOT NULL, -- Can override template
    status VARCHAR(20) DEFAULT 'open', -- 'open', 'closed', 'cancelled'
    table_inventory_override JSONB NULL, -- Override default table inventory for this instance
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE NULL,
    CONSTRAINT unique_session_instance UNIQUE (restaurant_id, service_date, start_time),
    CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

CREATE INDEX idx_session_instances_restaurant_date ON session_instances(restaurant_id, service_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_session_instances_template ON session_instances(session_template_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_session_instances_status ON session_instances(status, service_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_session_instances_date_range ON session_instances(service_date) WHERE deleted_at IS NULL AND status = 'open';

-- ============================================================================
-- 4. SESSION TABLE GROUPS
-- ============================================================================
-- Table inventory per session instance (capacity buckets: 2-top, 4-top, 5-top, etc.)
CREATE TABLE IF NOT EXISTS session_table_groups (
    id SERIAL PRIMARY KEY,
    session_instance_id INTEGER NOT NULL REFERENCES session_instances(id) ON DELETE CASCADE,
    capacity INTEGER NOT NULL, -- Table capacity: 2, 4, 5, 8, etc.
    table_count INTEGER NOT NULL DEFAULT 0, -- Number of tables with this capacity
    assigned_count INTEGER NOT NULL DEFAULT 0, -- Number of tables currently assigned
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT positive_capacity CHECK (capacity > 0),
    CONSTRAINT positive_table_count CHECK (table_count >= 0),
    CONSTRAINT valid_assigned_count CHECK (assigned_count >= 0 AND assigned_count <= table_count),
    CONSTRAINT unique_capacity_per_session UNIQUE (session_instance_id, capacity)
);

CREATE INDEX idx_session_table_groups_instance ON session_table_groups(session_instance_id);
CREATE INDEX idx_session_table_groups_availability ON session_table_groups(session_instance_id, capacity) 
    WHERE assigned_count < table_count;

-- ============================================================================
-- 5. RESERVATIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS reservations (
    id SERIAL PRIMARY KEY,
    room_no VARCHAR(50) NOT NULL, -- From PMS/session
    guest_ids JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of guest IDs from PMS
    guest_names JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of guest names
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
    session_instance_id INTEGER NOT NULL REFERENCES session_instances(id) ON DELETE RESTRICT,
    pax_adult INTEGER NOT NULL DEFAULT 0,
    pax_child INTEGER NOT NULL DEFAULT 0,
    total_pax INTEGER GENERATED ALWAYS AS (pax_adult + pax_child) STORED,
    -- Price snapshot (captured at booking time)
    price_per_person DECIMAL(10, 2) NOT NULL,
    total_price DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(20) DEFAULT 'confirmed', -- 'confirmed', 'cancelled', 'completed', 'no_show'
    special_requests TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    cancelled_at TIMESTAMP WITH TIME ZONE NULL,
    CONSTRAINT positive_pax CHECK (pax_adult >= 0 AND pax_child >= 0 AND total_pax > 0),
    CONSTRAINT positive_price CHECK (price_per_person >= 0 AND total_price >= 0)
);

CREATE INDEX idx_reservations_room_date ON reservations(room_no, (DATE(created_at))) WHERE status != 'cancelled';
CREATE INDEX idx_reservations_session ON reservations(session_instance_id, status);
CREATE INDEX idx_reservations_restaurant ON reservations(restaurant_id, status);
CREATE INDEX idx_reservations_created ON reservations(created_at DESC);
CREATE INDEX idx_reservations_status ON reservations(status);

-- ============================================================================
-- 6. RESERVATION TABLE ASSIGNMENTS
-- ============================================================================
-- Links reservation to a table group (capacity bucket)
CREATE TABLE IF NOT EXISTS reservation_table_assignments (
    id SERIAL PRIMARY KEY,
    reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    session_table_group_id INTEGER NOT NULL REFERENCES session_table_groups(id) ON DELETE RESTRICT,
    capacity INTEGER NOT NULL, -- Snapshot of capacity at assignment time
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_reservation_assignment UNIQUE (reservation_id)
);

CREATE INDEX idx_reservation_assignments_reservation ON reservation_table_assignments(reservation_id);
CREATE INDEX idx_reservation_assignments_table_group ON reservation_table_assignments(session_table_group_id);

-- ============================================================================
-- 7. TRIGGERS
-- ============================================================================

-- Update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_restaurants_updated_at
    BEFORE UPDATE ON restaurants
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_session_templates_updated_at
    BEFORE UPDATE ON session_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_session_instances_updated_at
    BEFORE UPDATE ON session_instances
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_session_table_groups_updated_at
    BEFORE UPDATE ON session_table_groups
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_reservations_updated_at
    BEFORE UPDATE ON reservations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 8. HELPER FUNCTIONS
-- ============================================================================

-- Function to get availability for a session instance
CREATE OR REPLACE FUNCTION get_session_availability(p_session_instance_id INTEGER)
RETURNS TABLE (
    capacity INTEGER,
    total_tables INTEGER,
    available_tables INTEGER,
    assigned_tables INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        stg.capacity,
        stg.table_count AS total_tables,
        (stg.table_count - stg.assigned_count) AS available_tables,
        stg.assigned_count AS assigned_tables
    FROM session_table_groups stg
    WHERE stg.session_instance_id = p_session_instance_id
    ORDER BY stg.capacity;
END;
$$ LANGUAGE plpgsql;

-- Function to check if reservation is within cutoff time
CREATE OR REPLACE FUNCTION is_within_cutoff(
    p_session_instance_id INTEGER,
    p_cutoff_minutes INTEGER
)
RETURNS BOOLEAN AS $$
DECLARE
    v_session_start TIMESTAMP WITH TIME ZONE;
BEGIN
    SELECT (service_date + start_time) INTO v_session_start
    FROM session_instances
    WHERE id = p_session_instance_id;
    
    RETURN (v_session_start - INTERVAL '1 minute' * p_cutoff_minutes) > CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 9. SAMPLE DATA (Optional - for testing)
-- ============================================================================

-- Uncomment to insert sample data:
/*
INSERT INTO restaurants (name, description, photos, price_per_person, currency) VALUES
('Fine Dining Restaurant', 'Elegant dining experience', '["/uploads/restaurant1.jpg"]'::jsonb, 500.00, 'TRY'),
('Beachside Bistro', 'Casual beachfront dining', '["/uploads/restaurant2.jpg"]'::jsonb, 350.00, 'TRY');

INSERT INTO session_templates (restaurant_id, name, start_time, end_time, active_weekdays) VALUES
(1, 'Dinner 1', '18:30:00', '20:00:00', ARRAY[1,2,3,4,5,6,7]),
(1, 'Dinner 2', '20:15:00', '21:45:00', ARRAY[1,2,3,4,5,6,7]),
(2, 'Lunch', '12:00:00', '14:30:00', ARRAY[1,2,3,4,5,6,7]);
*/
