-- Migration: Replace working_hours with opening_hour and closing_hour
-- Date: 2026-01-11
-- Description: Split working_hours field into two separate time fields

-- Step 1: Add new columns
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS opening_hour VARCHAR(5);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS closing_hour VARCHAR(5);

-- Step 2: Migrate existing data from working_hours to new columns
-- Parse existing working_hours format: "HH:MM - HH:MM" or "HH:MM-HH:MM"
UPDATE restaurants
SET 
    opening_hour = CASE 
        WHEN working_hours IS NOT NULL AND working_hours != '' THEN
            -- Extract opening hour (first part before '-' or ' - ')
            TRIM(SPLIT_PART(REPLACE(working_hours, ' ', ''), '-', 1))
        ELSE NULL
    END,
    closing_hour = CASE 
        WHEN working_hours IS NOT NULL AND working_hours != '' THEN
            -- Extract closing hour (second part after '-' or ' - ')
            TRIM(SPLIT_PART(REPLACE(working_hours, ' ', ''), '-', 2))
        ELSE NULL
    END
WHERE (opening_hour IS NULL OR closing_hour IS NULL)
  AND working_hours IS NOT NULL 
  AND working_hours != '';

-- Step 3: (Optional) Drop old column after verifying data migration
-- Uncomment the following line after verifying the migration:
-- ALTER TABLE restaurants DROP COLUMN working_hours;
