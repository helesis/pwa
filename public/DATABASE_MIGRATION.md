# Database Migration: Restaurant Working Hours

## Changes Required

The restaurant table needs to be updated to replace the `working_hours` field (TEXT) with two separate fields:

1. `opening_hour` (TIME or VARCHAR) - Opening time (e.g., "19:00")
2. `closing_hour` (TIME or VARCHAR) - Closing time (e.g., "23:00")

## Migration SQL (PostgreSQL Example)

```sql
-- Add new columns
ALTER TABLE restaurants ADD COLUMN opening_hour VARCHAR(5);
ALTER TABLE restaurants ADD COLUMN closing_hour VARCHAR(5);

-- Migrate existing data (if any)
-- Parse existing working_hours format: "HH:MM - HH:MM" or "HH:MM-HH:MM"
UPDATE restaurants
SET 
    opening_hour = SPLIT_PART(REPLACE(working_hours, ' ', ''), '-', 1),
    closing_hour = SPLIT_PART(REPLACE(working_hours, ' ', ''), '-', 2)
WHERE working_hours IS NOT NULL AND working_hours != '';

-- Drop old column (after verifying data migration)
-- ALTER TABLE restaurants DROP COLUMN working_hours;
```

## Migration SQL (MySQL Example)

```sql
-- Add new columns
ALTER TABLE restaurants ADD COLUMN opening_hour VARCHAR(5);
ALTER TABLE restaurants ADD COLUMN closing_hour VARCHAR(5);

-- Migrate existing data (if any)
UPDATE restaurants
SET 
    opening_hour = SUBSTRING_INDEX(REPLACE(working_hours, ' ', ''), '-', 1),
    closing_hour = SUBSTRING_INDEX(REPLACE(working_hours, ' ', ''), '-', -1)
WHERE working_hours IS NOT NULL AND working_hours != '';

-- Drop old column (after verifying data migration)
-- ALTER TABLE restaurants DROP COLUMN working_hours;
```

## API Changes

Backend API endpoints should now accept and return:
- `opening_hour` (string, format: "HH:MM")
- `closing_hour` (string, format: "HH:MM")

Instead of:
- `working_hours` (string, format: "HH:MM - HH:MM")

## Frontend Changes (Completed)

✅ settings.html: Form inputs changed to `opening_hour` and `closing_hour` time inputs
✅ index.html: Cutoff calculation now uses `opening_hour` directly
✅ index.html: Restaurant display now combines `opening_hour` and `closing_hour` for display
