import datetime
from datetime import timedelta

# --- CONFIGURATION ---
# Set the real-world Gregorian date when Q1C1 Day 1 starts
START_DATE_STR = "2025-12-29"  # Format: YYYY-MM-DD
YEARS_TO_GENERATE = 5           # How many years of this calendar to create
OUTPUT_FILE = "cyclic_calendar.ics"

# Structure derived from your JSON
CALENDAR_STRUCTURE = [
    {"name": "Q1C1", "length": 28},
    {"name": "Q1C2", "length": 28},
    {"name": "Q1C3", "length": 28},
    {"name": "Reset Week 1", "length": 7},
    {"name": "Q2C1", "length": 28},
    {"name": "Q2C2", "length": 28},
    {"name": "Q2C3", "length": 28},
    {"name": "Reset Week 2", "length": 7},
    {"name": "Q3C1", "length": 28},
    {"name": "Q3C2", "length": 28},
    {"name": "Q3C3", "length": 28},
    {"name": "Reset Week 3", "length": 7},
    {"name": "Q4C1", "length": 28},
    {"name": "Q4C2", "length": 28},
    {"name": "Q4C3", "length": 28},
    {"name": "Reset Week 4", "length": 7},
]

def generate_ics():
    start_date = datetime.datetime.strptime(START_DATE_STR, "%Y-%m-%d")
    current_date = start_date
    
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Cyclic Calendar//EN",
        "X-WR-CALNAME:Cyclic Calendar",
        "X-WR-TIMEZONE:UTC"
    ]

    for year_num in range(1, YEARS_TO_GENERATE + 1):
        for span in CALENDAR_STRUCTURE:
            name = f"Year {year_num}: {span['name']}"
            end_date = current_date + timedelta(days=span['length'])
            
            # Create a 'Month' or 'Reset' event block
            lines.append("BEGIN:VEVENT")
            lines.append(f"SUMMARY:{name}")
            lines.append(f"DTSTART;VALUE=DATE:{current_date.strftime('%Y%m%d')}")
            lines.append(f"DTEND;VALUE=DATE:{end_date.strftime('%Y%m%d')}")
            lines.append("DESCRIPTION:Cyclic Calendar Period")
            lines.append("STATUS:CONFIRMED")
            lines.append("TRANSP:TRANSPARENT") # Makes it an 'overlay' (doesn't block time)
            lines.append("END:VEVENT")
            
            # Move pointer forward
            current_date = end_date

    lines.append("END:VCALENDAR")

    with open(OUTPUT_FILE, "w") as f:
        f.write("\n".join(lines))
    
    print(f"Success! {OUTPUT_FILE} created with {YEARS_TO_GENERATE} years of data.")

if __name__ == "__main__":
    generate_ics() 