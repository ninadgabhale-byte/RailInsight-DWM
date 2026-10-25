"""Generate realistic railway dataset for testing RailInsight.
Matches the exact schema profiled in docs/data_dictionary.md.
"""
import csv
import random
from datetime import datetime, timedelta
from pathlib import Path

STATIONS = {
    "Central": ["CST", "Dadar", "Kurla", "Ghatkopar", "Thane", "Dombivli", "Kalyan"],
    "Western": ["Churchgate", "Mumbai Central", "Dadar", "Bandra", "Andheri", "Borivali"],
    "Harbour": ["CST", "Wadala", "Kurla", "Vashi", "Nerul", "Belapur", "Panvel"],
    "Pune": ["Pune Jn", "Shivajinagar", "Khadki", "Dapodi", "Kasardi", "Pimpri", "Akurdi"],
}

TICKET_TYPES = ["Single", "Return", "Monthly Pass"]
BOOKING_MODES = ["Paperless", "Paper"]
PAYMENT_TYPES = ["UPI", "Cash", "Wallet", "Debit Card", "Credit Card"]

FARE_MAP = {
    "Single": [10, 15, 20, 30, 45, 60],
    "Return": [20, 30, 40, 60, 90, 120],
    "Monthly Pass": [100, 160, 220, 315, 410, 530],
}

def generate(num_rows=6000, output_paths=None):
    start_date = datetime(2024, 1, 1)
    rows = []
    
    for i in range(1, num_rows + 1):
        booking_id = random.randint(10001, 99999)
        day_offset = random.randint(0, 364)
        curr_date = start_date + timedelta(days=day_offset)
        
        # Rush hours: 8-10 AM and 5-8 PM
        if random.random() < 0.65:
            hour = random.choice([8, 9, 10, 17, 18, 19, 20])
        else:
            hour = random.randint(5, 23)
        minute = random.randint(0, 59)
        second = random.randint(0, 59)
        time_str = f"{hour:02d}:{minute:02d}:{second:02d}"
        
        line = random.choices(["Central", "Western", "Harbour", "Pune"], weights=[35, 30, 20, 15])[0]
        city = "Pune" if line == "Pune" else "Mumbai"
        
        stations = STATIONS[line]
        from_st = random.choice(stations)
        to_candidates = [s for s in stations if s != from_st]
        to_st = random.choice(to_candidates)
        
        ticket_type = random.choices(TICKET_TYPES, weights=[65, 25, 10])[0]
        mode = random.choices(BOOKING_MODES, weights=[75, 25])[0]
        payment = random.choices(PAYMENT_TYPES, weights=[45, 25, 15, 10, 5])[0]
        passengers = random.choices([1, 2, 3, 4], weights=[60, 25, 10, 5])[0]
        
        base_fare = random.choice(FARE_MAP[ticket_type])
        total_fare = base_fare if ticket_type == "Monthly Pass" else base_fare * passengers
        
        rows.append({
            "Booking_ID": booking_id,
            "Date": curr_date.strftime("%Y-%m-%d"),
            "Month": curr_date.strftime("%b"),
            "Week": curr_date.isocalendar()[1],
            "Time": time_str,
            "Ticket_Type": ticket_type,
            "Booking_Mode": mode,
            "From_Station": from_st,
            "To_Station": to_st,
            "Passengers": passengers,
            "Total_Fare": total_fare,
            "Payment_Type": payment,
            "Railway_Line": line,
            "City": city,
        })
        
    fieldnames = [
        "Booking_ID", "Date", "Month", "Week", "Time", "Ticket_Type",
        "Booking_Mode", "From_Station", "To_Station", "Passengers",
        "Total_Fare", "Payment_Type", "Railway_Line", "City"
    ]
    
    if output_paths:
        for p in output_paths:
            path = Path(p)
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)
            print(f"Generated {len(rows):,} rows in {path}")

if __name__ == "__main__":
    generate(num_rows=6000, output_paths=[
        "datasets/raw/Uts_Data.csv",
        "datasets/raw/sample_railway_data.csv"
    ])
