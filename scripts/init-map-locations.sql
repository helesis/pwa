-- Map Search Locations table for harita search functionality
-- This table stores default coordinates for map search

CREATE TABLE IF NOT EXISTS map_search_locations (
    id INTEGER PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    distance_km DECIMAL(6, 2),
    geom GEOMETRY(Point, 4326),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PostGIS geometry kolonu için index
CREATE INDEX IF NOT EXISTS idx_map_search_locations_geom ON map_search_locations USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_map_search_locations_category ON map_search_locations(category);
