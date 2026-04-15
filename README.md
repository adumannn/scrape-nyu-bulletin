## 📚 NYU Bulletin Course Scraper

A script that scrapes course data from [bulletins.nyu.edu](https://bulletins.nyu.edu) for all undergraduate schools.

### Features
- Extracts:
  - Course codes
  - Course names
  - Credits
  - Descriptions
  - Prerequisites
- Supports filtering by school and subject
- Outputs structured JSON files

---

### Usage

Run the script using Node.js:

```bash
# Scrape all schools
node scripts/scrape-bulletin.mjs

# Scrape a specific school
node scripts/scrape-bulletin.mjs --school shanghai

# Scrape a specific subject within a school
node scripts/scrape-bulletin.mjs --school shanghai --subject csci-shu

# List all available schools
node scripts/scrape-bulletin.mjs --list-schools

# List all subjects for a specific school
node scripts/scrape-bulletin.mjs --list-subjects

📂 Output

The scraper generates JSON files containing structured course data, ready for further processing or analysis.

🛠 Requirements
Node.js (v18+ recommended)
