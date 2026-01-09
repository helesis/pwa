# A'la Carte Restaurant Reservations - Booking & Cancellation Logic

## 1. CREATE RESERVATION (Concurrency-Safe)

### Pseudocode

```
FUNCTION createReservation(request):
    INPUT:
        - restaurant_id
        - session_instance_id
        - pax_adult, pax_child
        - special_requests (optional)
        - room_no (from session)
        - guest_ids (from session)
        - guest_names (from session)
    
    BEGIN TRANSACTION
        TRY:
            // Step 1: Load and lock session instance
            session_instance = SELECT * FROM session_instances 
                WHERE id = session_instance_id 
                FOR UPDATE;
            
            IF session_instance IS NULL:
                ROLLBACK;
                RETURN 404 "Session not found";
            
            IF session_instance.status != 'open':
                ROLLBACK;
                RETURN 400 "Session is closed";
            
            // Step 2: Load restaurant and rules
            restaurant = SELECT * FROM restaurants 
                WHERE id = restaurant_id;
            
            IF restaurant IS NULL OR NOT restaurant.active:
                ROLLBACK;
                RETURN 404 "Restaurant not found or inactive";
            
            rules = restaurant.rules_json;
            cutoff_minutes = rules.cutoff_minutes;
            max_per_room_per_day = rules.max_reservation_per_room_per_day;
            
            // Step 3: Validate cutoff time
            session_start = session_instance.service_date + session_instance.start_time;
            cutoff_time = session_start - INTERVAL cutoff_minutes MINUTES;
            
            IF CURRENT_TIMESTAMP > cutoff_time:
                ROLLBACK;
                RETURN 400 "Booking cutoff time has passed";
            
            // Step 4: Validate per-room limit
            existing_count = SELECT COUNT(*) FROM reservations
                WHERE room_no = room_no
                AND DATE(created_at) = CURRENT_DATE
                AND status = 'confirmed'
                AND restaurant_id = restaurant_id;
            
            IF existing_count >= max_per_room_per_day:
                ROLLBACK;
                RETURN 400 "Maximum reservations per room per day exceeded";
            
            // Step 5: Calculate total party size
            total_pax = pax_adult + pax_child;
            
            IF total_pax <= 0:
                ROLLBACK;
                RETURN 400 "Invalid party size";
            
            // Step 6: Load and lock table groups (sorted by capacity ASC for best-fit)
            table_groups = SELECT * FROM session_table_groups
                WHERE session_instance_id = session_instance_id
                ORDER BY capacity ASC
                FOR UPDATE;
            
            // Step 7: Find best-fit table capacity
            selected_table_group = NULL;
            
            FOR EACH table_group IN table_groups:
                IF table_group.capacity >= total_pax:
                    IF table_group.assigned_count < table_group.table_count:
                        selected_table_group = table_group;
                        BREAK;
                    END IF
                END IF
            END FOR
            
            IF selected_table_group IS NULL:
                ROLLBACK;
                RETURN 409 "No available tables for party size";
            
            // Step 8: Calculate price (with child pricing policy)
            price_per_person = restaurant.price_per_person;
            child_price = 0;
            
            IF rules.child_pricing_policy == "free_under_12":
                child_price = 0;
            ELSE IF rules.child_pricing_policy == "half_price":
                child_price = price_per_person * 0.5;
            ELSE IF rules.child_pricing_policy == "full_price":
                child_price = price_per_person;
            END IF
            
            total_price = (pax_adult * price_per_person) + (pax_child * child_price);
            
            // Step 9: Insert reservation
            reservation_id = INSERT INTO reservations (
                room_no, guest_ids, guest_names,
                restaurant_id, session_instance_id,
                pax_adult, pax_child,
                price_per_person, total_price, currency,
                status, special_requests
            ) VALUES (
                room_no, guest_ids, guest_names,
                restaurant_id, session_instance_id,
                pax_adult, pax_child,
                price_per_person, total_price, restaurant.currency,
                'confirmed', special_requests
            ) RETURNING id;
            
            // Step 10: Insert table assignment
            INSERT INTO reservation_table_assignments (
                reservation_id, session_table_group_id, capacity
            ) VALUES (
                reservation_id, selected_table_group.id, selected_table_group.capacity
            );
            
            // Step 11: Increment assigned_count (atomic update)
            UPDATE session_table_groups
            SET assigned_count = assigned_count + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = selected_table_group.id;
            
            // Step 12: Commit transaction
            COMMIT;
            
            // Step 13: Return success response
            reservation = SELECT r.*, 
                rta.session_table_group_id,
                rta.capacity AS table_capacity
                FROM reservations r
                LEFT JOIN reservation_table_assignments rta ON r.id = rta.reservation_id
                WHERE r.id = reservation_id;
            
            RETURN 201 {
                success: true,
                data: reservation
            };
            
        CATCH error:
            ROLLBACK;
            LOG error;
            RETURN 500 "Internal server error";
        END TRY
    END TRANSACTION
END FUNCTION
```

### Key Concurrency Safety Features

1. **Transaction Isolation**: All operations within a single transaction
2. **Row-Level Locks**: `FOR UPDATE` on `session_instances` and `session_table_groups`
3. **Atomic Updates**: `assigned_count` increment happens atomically
4. **Capacity Check**: Verified after lock acquisition, before commit
5. **Deadlock Prevention**: Always lock in same order (session_instance → table_groups)

---

## 2. CANCEL RESERVATION

### Pseudocode

```
FUNCTION cancelReservation(reservation_id, room_no):
    INPUT:
        - reservation_id
        - room_no (from session, for authorization)
    
    BEGIN TRANSACTION
        TRY:
            // Step 1: Load reservation with lock
            reservation = SELECT * FROM reservations
                WHERE id = reservation_id
                AND room_no = room_no
                FOR UPDATE;
            
            IF reservation IS NULL:
                ROLLBACK;
                RETURN 404 "Reservation not found";
            
            IF reservation.status == 'cancelled':
                ROLLBACK;
                RETURN 400 "Reservation already cancelled";
            
            // Step 2: Load restaurant rules
            restaurant = SELECT * FROM restaurants
                WHERE id = reservation.restaurant_id;
            
            rules = restaurant.rules_json;
            cancellation_deadline_minutes = rules.cancellation_deadline_minutes;
            
            // Step 3: Load session instance
            session_instance = SELECT * FROM session_instances
                WHERE id = reservation.session_instance_id;
            
            // Step 4: Validate cancellation deadline
            session_start = session_instance.service_date + session_instance.start_time;
            cancellation_deadline = session_start - INTERVAL cancellation_deadline_minutes MINUTES;
            
            IF CURRENT_TIMESTAMP > cancellation_deadline:
                ROLLBACK;
                RETURN 400 "Cancellation deadline has passed";
            
            // Step 5: Load table assignment
            assignment = SELECT * FROM reservation_table_assignments
                WHERE reservation_id = reservation_id;
            
            IF assignment IS NULL:
                ROLLBACK;
                RETURN 500 "Table assignment not found";
            
            // Step 6: Decrement assigned_count (atomic update)
            UPDATE session_table_groups
            SET assigned_count = assigned_count - 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = assignment.session_table_group_id
            AND assigned_count > 0; // Safety check
            
            // Step 7: Update reservation status
            UPDATE reservations
            SET status = 'cancelled',
                cancelled_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = reservation_id;
            
            // Step 8: Commit transaction
            COMMIT;
            
            // Step 9: Return success response
            cancelled_reservation = SELECT * FROM reservations
                WHERE id = reservation_id;
            
            RETURN 200 {
                success: true,
                data: cancelled_reservation
            };
            
        CATCH error:
            ROLLBACK;
            LOG error;
            RETURN 500 "Internal server error";
        END TRY
    END TRANSACTION
END FUNCTION
```

### Key Features

1. **Authorization**: Verify `room_no` matches reservation
2. **Deadline Check**: Validate cancellation deadline before processing
3. **Atomic Decrement**: Safely decrement `assigned_count`
4. **Status Update**: Mark reservation as cancelled with timestamp
5. **Transaction Safety**: All operations in single transaction

---

## 3. GET AVAILABILITY (No Transaction Needed)

### Pseudocode

```
FUNCTION getRestaurantAvailability(restaurant_id, from_date, to_date):
    INPUT:
        - restaurant_id
        - from_date (YYYY-MM-DD)
        - to_date (YYYY-MM-DD)
    
    // Step 1: Load restaurant
    restaurant = SELECT * FROM restaurants
        WHERE id = restaurant_id AND active = true;
    
    IF restaurant IS NULL:
        RETURN 404 "Restaurant not found";
    
    rules = restaurant.rules_json;
    cutoff_minutes = rules.cutoff_minutes;
    
    // Step 2: Load session instances in date range
    session_instances = SELECT 
        si.id AS session_instance_id,
        si.service_date,
        si.start_time,
        si.end_time,
        si.status,
        st.name AS session_name
        FROM session_instances si
        JOIN session_templates st ON si.session_template_id = st.id
        WHERE si.restaurant_id = restaurant_id
        AND si.service_date >= from_date
        AND si.service_date <= to_date
        AND si.deleted_at IS NULL
        ORDER BY si.service_date, si.start_time;
    
    // Step 3: For each session instance, get table availability
    availability_list = [];
    
    FOR EACH session_instance IN session_instances:
        // Get table groups with availability
        table_availability = SELECT 
            capacity,
            table_count AS total,
            assigned_count,
            (table_count - assigned_count) AS available
            FROM session_table_groups
            WHERE session_instance_id = session_instance.id
            ORDER BY capacity;
        
        // Check if cutoff has passed
        session_start = session_instance.service_date + session_instance.start_time;
        cutoff_time = session_start - INTERVAL cutoff_minutes MINUTES;
        cutoff_passed = CURRENT_TIMESTAMP > cutoff_time;
        
        // Check if can book (status open and cutoff not passed)
        can_book = (session_instance.status == 'open' AND NOT cutoff_passed);
        
        availability_list.append({
            session_instance_id: session_instance.id,
            service_date: session_instance.service_date,
            session_name: session_instance.session_name,
            start_time: session_instance.start_time,
            end_time: session_instance.end_time,
            status: session_instance.status,
            table_availability: table_availability,
            can_book: can_book,
            cutoff_passed: cutoff_passed
        });
    END FOR
    
    RETURN 200 {
        success: true,
        data: {
            restaurant: restaurant,
            availability: availability_list
        }
    };
END FUNCTION
```

---

## 4. BEST-FIT TABLE ASSIGNMENT ALGORITHM

### Pseudocode

```
FUNCTION findBestFitTable(total_pax, table_groups):
    INPUT:
        - total_pax (total party size)
        - table_groups (array of {capacity, table_count, assigned_count})
    
    // Sort by capacity ascending (smallest first)
    sorted_groups = SORT table_groups BY capacity ASC;
    
    FOR EACH group IN sorted_groups:
        IF group.capacity >= total_pax:
            IF group.assigned_count < group.table_count:
                RETURN group; // Found best-fit
            END IF
        END IF
    END FOR
    
    RETURN NULL; // No available table
END FUNCTION
```

### Example Scenarios

**Scenario 1:** Party of 3, available tables: 2-top (0 left), 4-top (2 left), 5-top (1 left)
- Result: Assign 4-top (smallest capacity that fits)

**Scenario 2:** Party of 2, available tables: 2-top (1 left), 4-top (2 left)
- Result: Assign 2-top (exact fit)

**Scenario 3:** Party of 6, available tables: 2-top (5 left), 4-top (2 left), 8-top (1 left)
- Result: Assign 8-top (smallest that fits, no splitting allowed)

---

## 5. GENERATE SESSION INSTANCES

### Pseudocode

```
FUNCTION generateSessionInstances(restaurant_id, from_date, to_date, template_ids):
    INPUT:
        - restaurant_id
        - from_date (YYYY-MM-DD)
        - to_date (YYYY-MM-DD)
        - template_ids (optional array, or all if null)
    
    // Step 1: Load session templates
    IF template_ids IS NULL:
        templates = SELECT * FROM session_templates
            WHERE restaurant_id = restaurant_id
            AND active = true
            AND deleted_at IS NULL;
    ELSE:
        templates = SELECT * FROM session_templates
            WHERE restaurant_id = restaurant_id
            AND id IN template_ids
            AND active = true
            AND deleted_at IS NULL;
    END IF
    
    generated_instances = [];
    
    // Step 2: For each date in range
    current_date = from_date;
    
    WHILE current_date <= to_date:
        weekday = DAY_OF_WEEK(current_date); // 1=Monday, 7=Sunday
        
        // Step 3: For each template
        FOR EACH template IN templates:
            IF weekday IN template.active_weekdays:
                // Check if instance already exists
                existing = SELECT * FROM session_instances
                    WHERE restaurant_id = restaurant_id
                    AND service_date = current_date
                    AND start_time = template.start_time
                    AND deleted_at IS NULL;
                
                IF existing IS NULL:
                    // Create instance
                    instance_id = INSERT INTO session_instances (
                        session_template_id,
                        restaurant_id,
                        service_date,
                        start_time,
                        end_time,
                        status
                    ) VALUES (
                        template.id,
                        restaurant_id,
                        current_date,
                        template.start_time,
                        template.end_time,
                        'open'
                    ) RETURNING id;
                    
                    // Step 4: Create table groups from template defaults
                    // (Assume template has default table inventory stored)
                    default_tables = GET template default table inventory;
                    
                    FOR EACH table_group IN default_tables:
                        INSERT INTO session_table_groups (
                            session_instance_id,
                            capacity,
                            table_count,
                            assigned_count
                        ) VALUES (
                            instance_id,
                            table_group.capacity,
                            table_group.table_count,
                            0
                        );
                    END FOR
                    
                    generated_instances.append(instance_id);
                END IF
            END IF
        END FOR
        
        current_date = current_date + 1 DAY;
    END WHILE
    
    RETURN {
        success: true,
        data: {
            generated_count: LENGTH(generated_instances),
            instances: generated_instances
        }
    };
END FUNCTION
```

---

## 6. VALIDATION HELPERS

### Check Cutoff Time
```
FUNCTION isWithinCutoff(session_instance_id, cutoff_minutes):
    session_instance = SELECT * FROM session_instances WHERE id = session_instance_id;
    session_start = session_instance.service_date + session_instance.start_time;
    cutoff_time = session_start - INTERVAL cutoff_minutes MINUTES;
    RETURN CURRENT_TIMESTAMP <= cutoff_time;
END FUNCTION
```

### Check Per-Room Limit
```
FUNCTION checkPerRoomLimit(room_no, restaurant_id, service_date, max_per_day):
    count = SELECT COUNT(*) FROM reservations
        WHERE room_no = room_no
        AND restaurant_id = restaurant_id
        AND DATE(created_at) = service_date
        AND status = 'confirmed';
    RETURN count < max_per_day;
END FUNCTION
```

### Check Cancellation Deadline
```
FUNCTION isWithinCancellationDeadline(session_instance_id, deadline_minutes):
    session_instance = SELECT * FROM session_instances WHERE id = session_instance_id;
    session_start = session_instance.service_date + session_instance.start_time;
    deadline = session_start - INTERVAL deadline_minutes MINUTES;
    RETURN CURRENT_TIMESTAMP <= deadline;
END FUNCTION
```
