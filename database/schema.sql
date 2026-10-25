-- =====================================================================
-- RailInsight - Railway Analytics Data Warehouse Star Schema (MySQL)
-- Academic Project: Data Warehousing and Data Mining (B.Tech IT)
-- =====================================================================

CREATE DATABASE IF NOT EXISTS railinsight_dw
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE railinsight_dw;

-- Drop foreign keys and tables if rebuilding schema
DROP TABLE IF EXISTS fact_bookings;
DROP TABLE IF EXISTS dim_route;
DROP TABLE IF EXISTS dim_ticket;
DROP TABLE IF EXISTS dim_passenger;
DROP TABLE IF EXISTS dim_train;
DROP TABLE IF EXISTS dim_station;
DROP TABLE IF EXISTS dim_date;

-- ---------------------------------------------------------------------
-- 1. Date Dimension (Conformed Dimension for time hierarchy)
-- Hierarchy: Day -> Month -> Quarter -> Year
-- ---------------------------------------------------------------------
CREATE TABLE dim_date (
    date_key INT PRIMARY KEY,                       -- e.g. 20240115
    full_date DATE NOT NULL UNIQUE,
    day_number INT NOT NULL,
    month_number INT NOT NULL,
    month_name VARCHAR(15) NOT NULL,
    quarter INT NOT NULL,
    year_number INT NOT NULL,
    week_of_year INT NOT NULL,
    day_of_week INT NOT NULL,                       -- 1 (Mon) to 7 (Sun)
    day_name VARCHAR(15) NOT NULL,
    is_weekend TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_dim_date_month_year (year_number, month_number),
    INDEX idx_dim_date_full (full_date)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 2. Station Dimension (Geographic dimension)
-- ---------------------------------------------------------------------
CREATE TABLE dim_station (
    station_key INT AUTO_INCREMENT PRIMARY KEY,
    station_code VARCHAR(20) NOT NULL UNIQUE,
    station_name VARCHAR(100) NOT NULL,
    city VARCHAR(50) DEFAULT 'Mumbai',
    railway_line VARCHAR(50) DEFAULT 'Central',
    zone VARCHAR(50) DEFAULT 'Central Railway',
    INDEX idx_station_city (city),
    INDEX idx_station_line (railway_line)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 3. Train Dimension
-- ---------------------------------------------------------------------
CREATE TABLE dim_train (
    train_key INT AUTO_INCREMENT PRIMARY KEY,
    train_number VARCHAR(20) NOT NULL UNIQUE,
    train_name VARCHAR(100) NOT NULL,
    train_type VARCHAR(50) DEFAULT 'Local Suburban',
    INDEX idx_train_type (train_type)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 4. Passenger Profile Dimension
-- ---------------------------------------------------------------------
CREATE TABLE dim_passenger (
    passenger_key INT AUTO_INCREMENT PRIMARY KEY,
    passenger_type VARCHAR(50) DEFAULT 'Regular',   -- General, Student, Senior Citizen, Child
    age_group VARCHAR(50) DEFAULT 'Adult (26-59)',  -- Youth, Adult, Senior
    gender VARCHAR(20) DEFAULT 'Unknown',
    INDEX idx_pax_type (passenger_type)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 5. Ticket Dimension (Booking mode, Ticket type, Payment method)
-- ---------------------------------------------------------------------
CREATE TABLE dim_ticket (
    ticket_key INT AUTO_INCREMENT PRIMARY KEY,
    ticket_type VARCHAR(50) NOT NULL,              -- Single, Return, Monthly Pass
    booking_mode VARCHAR(50) NOT NULL,             -- Paperless, Paper
    payment_method VARCHAR(50) NOT NULL,           -- UPI, Cash, Wallet, Card
    class_type VARCHAR(50) DEFAULT 'Second Class', -- First Class, Second Class, AC
    UNIQUE KEY uq_ticket_combo (ticket_type, booking_mode, payment_method, class_type)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 6. Route Dimension (Source -> Destination pair)
-- ---------------------------------------------------------------------
CREATE TABLE dim_route (
    route_key INT AUTO_INCREMENT PRIMARY KEY,
    source_station_key INT NOT NULL,
    dest_station_key INT NOT NULL,
    route_name VARCHAR(120) NOT NULL,              -- e.g. "CST -> Kurla"
    railway_line VARCHAR(50) DEFAULT 'Central',
    distance_km DECIMAL(6,2) DEFAULT 0.00,
    CONSTRAINT fk_route_source FOREIGN KEY (source_station_key) REFERENCES dim_station(station_key),
    CONSTRAINT fk_route_dest FOREIGN KEY (dest_station_key) REFERENCES dim_station(station_key),
    UNIQUE KEY uq_route (source_station_key, dest_station_key)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 7. Fact Table: fact_bookings
-- Grain: One railway ticket transaction / booking record
-- Measures: passengers_count, fare_amount, distance_km
-- Degenerate Dimensions: booking_id
-- ---------------------------------------------------------------------
CREATE TABLE fact_bookings (
    booking_fact_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    booking_id VARCHAR(50) NOT NULL,               -- Degenerate dimension (UTS ID / PNR)
    date_key INT NOT NULL,
    time_of_day TIME NULL,
    source_station_key INT NOT NULL,
    dest_station_key INT NOT NULL,
    route_key INT NULL,
    ticket_key INT NOT NULL,
    train_key INT NULL,
    passenger_key INT NULL,
    passengers_count INT NOT NULL DEFAULT 1,
    fare_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    booking_status VARCHAR(30) NOT NULL DEFAULT 'Confirmed',
    is_cancelled TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Foreign Key Constraints
    CONSTRAINT fk_fact_date FOREIGN KEY (date_key) REFERENCES dim_date(date_key),
    CONSTRAINT fk_fact_source FOREIGN KEY (source_station_key) REFERENCES dim_station(station_key),
    CONSTRAINT fk_fact_dest FOREIGN KEY (dest_station_key) REFERENCES dim_station(station_key),
    CONSTRAINT fk_fact_route FOREIGN KEY (route_key) REFERENCES dim_route(route_key),
    CONSTRAINT fk_fact_ticket FOREIGN KEY (ticket_key) REFERENCES dim_ticket(ticket_key),
    CONSTRAINT fk_fact_train FOREIGN KEY (train_key) REFERENCES dim_train(train_key),
    CONSTRAINT fk_fact_pax FOREIGN KEY (passenger_key) REFERENCES dim_passenger(passenger_key),

    -- Performance Indexes for OLAP Aggregations
    INDEX idx_fact_date (date_key),
    INDEX idx_fact_route (route_key),
    INDEX idx_fact_ticket (ticket_key),
    INDEX idx_fact_source_dest (source_station_key, dest_station_key),
    INDEX idx_fact_status (is_cancelled, booking_status)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- OLTP vs OLAP Architecture Comparison:
-- ---------------------------------------------------------------------
-- OLTP (Online Transaction Processing):
-- - Normalized to 3NF to minimize data redundancy and avoid update anomalies.
-- - Optimized for high-throughput single-row INSERT, UPDATE, DELETE operations.
-- - Highly detailed operational transactions (e.g., ticket booking counter).
--
-- OLAP (Online Analytical Processing):
-- - Denormalized Dimensional Model (Star Schema / Snowflake Schema).
-- - Optimized for read-intensive analytical queries, aggregations (SUM, AVG, COUNT).
-- - Supports slicing, dicing, drilling down, and rolling up along dimensions.
-- =====================================================================
