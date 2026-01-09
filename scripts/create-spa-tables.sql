-- SPA Tables Creation Script
-- Run this if tables were not created automatically

-- 1. Create spa_services table (if not exists)
CREATE TABLE IF NOT EXISTS spa_services (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  duration_min INTEGER NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'EUR',
  category VARCHAR(100),
  short_description TEXT,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for spa_services
CREATE INDEX IF NOT EXISTS idx_spa_services_active ON spa_services(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_spa_services_display_order ON spa_services(display_order);

-- 2. Create spa_availability table (if not exists)
CREATE TABLE IF NOT EXISTS spa_availability (
  id SERIAL PRIMARY KEY,
  service_id VARCHAR(50) NOT NULL REFERENCES spa_services(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  availability_status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
  therapist_id VARCHAR(50),
  therapist_display_name VARCHAR(255),
  therapist_level VARCHAR(50),
  therapist_tags JSONB DEFAULT '[]'::jsonb,
  last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for spa_availability
CREATE INDEX IF NOT EXISTS idx_spa_availability_service_date ON spa_availability(service_id, date);
CREATE INDEX IF NOT EXISTS idx_spa_availability_start_time ON spa_availability(start_time);
CREATE INDEX IF NOT EXISTS idx_spa_availability_status ON spa_availability(availability_status);
CREATE INDEX IF NOT EXISTS idx_spa_availability_last_updated ON spa_availability(last_updated_at);

-- Create unique index for slot + therapist (handling NULL therapist_id)
-- Note: This prevents duplicate therapist assignments to the same slot
CREATE UNIQUE INDEX IF NOT EXISTS idx_spa_availability_unique_slot_therapist 
ON spa_availability(service_id, date, start_time, COALESCE(therapist_id, ''));

-- 3. Create spa_requests table (if not exists)
CREATE TABLE IF NOT EXISTS spa_requests (
  id SERIAL PRIMARY KEY,
  request_id VARCHAR(100) UNIQUE NOT NULL,
  guest_unique_id VARCHAR(255) NOT NULL REFERENCES rooms(guest_unique_id) ON DELETE CASCADE,
  service_id VARCHAR(50) NOT NULL REFERENCES spa_services(id),
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  therapist_id VARCHAR(50),
  therapist_display_name VARCHAR(255),
  note TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  cancelled_at TIMESTAMP WITH TIME ZONE NULL,
  confirmed_at TIMESTAMP WITH TIME ZONE NULL,
  rejected_at TIMESTAMP WITH TIME ZONE NULL
);

-- Create indexes for spa_requests
CREATE INDEX IF NOT EXISTS idx_spa_requests_guest_unique_id ON spa_requests(guest_unique_id);
CREATE INDEX IF NOT EXISTS idx_spa_requests_status ON spa_requests(status);
CREATE INDEX IF NOT EXISTS idx_spa_requests_start_time ON spa_requests(start_time);
CREATE INDEX IF NOT EXISTS idx_spa_requests_service_id ON spa_requests(service_id);
CREATE INDEX IF NOT EXISTS idx_spa_requests_request_id ON spa_requests(request_id);

-- Verify tables were created
SELECT 
  table_name,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public' 
  AND table_name IN ('spa_services', 'spa_availability', 'spa_requests')
ORDER BY table_name;
