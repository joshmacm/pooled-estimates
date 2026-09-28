# FHIP Pooled Estimates

An end-to-end hydrological flood frequency estimation suite combining an automated **R scientific modelling pipeline** (`UKFE 2.15.1`, NRFA Peak Flows V15) with an ultra-lightweight, zero-server **web application** hosted on GitHub Pages.

---

## Architecture & Unified Project Structure

```text
FHIP Pooled Estimates/
├── index.html                    # Lightweight client-side dashboard (GitHub Pages entrypoint)
├── css/
│   └── styles.css                # Dashboard styling, theme & layout definitions
├── js/
│   └── app.js                    # Interactive logic (Leaflet map, Plotly curves, DataTables)
├── data/
│   ├── stations_data.js          # JavaScript data bundle (for instant offline & CORS-free execution)
│   ├── stations_data.json        # Standard JSON export of all modelling outputs
│   ├── nrfa_station_info.csv     # NRFA catalogue metadata
│   └── csv/                      # Downloadable consolidated CSVs
│       ├── all_stations_summary.csv
│       ├── all_design_flows.csv
│       ├── all_pooling_groups.csv
│       └── all_zdists.csv
│
├── R/
│   └── station_calculation.R     # Modular hydrological calculation function (UKFE, pooling, L-moments, CI)
├── scripts/
│   ├── main.R                    # Batch parallel processing pipeline across all suitable UK stations
│   └── export_webapp.R           # Serialisation script converting R outputs into Web App bundles
├── Output/                       # Full calculation outputs
│   ├── all_stations_summary.csv
│   ├── all_design_flows.csv
│   ├── all_pooling_groups.csv
│   ├── all_zdists.csv
│   ├── all_results.rds           # Complete high-fidelity R results object
│   └── Individual Results/       # Per-station CSV exports (552 gauging stations)
│
├── FHIP Pooled Estimates.Rproj    # RStudio project file
├── .nojekyll                     # Ensures GitHub Pages serves all JS/CSS assets cleanly
├── .gitignore                    # Ignores R session files, history, and OS metadata
└── README.md
```

---

## 1. Viewing the Dashboard Locally

No servers, Docker containers, or R installations are required to view and interact with the results:

* Simply **double-click [`index.html`](index.html)** in Finder / File Explorer to open the dashboard in your web browser.
* Alternatively, run a local Python or R preview server:
  ```bash
  python3 -m http.server 8080
  ```
  Then open `http://localhost:8080` in your browser.

---

## 2. Re-Running the R Hydrological Pipeline

Whenever a new peak flow dataset is released (e.g., Peak Flows V16) or calculation parameters need updating:

1. Open `FHIP Pooled Estimates.Rproj` in **RStudio**.
2. Run the batch pipeline:
   ```r
   source("scripts/main.R")
   ```
3. **What happens automatically:**
   - Detects all stations flagged as suitable for pooling in `PeakFlowData`.
   - Executes parallel pooled frequency analysis via `station_calculation.R` (pooling group formation, de-urbanisation, distribution selection via minimum absolute Z-score, growth curve derivation, and 95% confidence intervals).
   - Writes consolidated CSVs and `all_results.rds` to `Output/`.
   - **Automatically triggers `scripts/export_webapp.R`**, updating `data/stations_data.js` and `data/stations_data.json` directly.

---

## 3. Updating the Live Public Web App (GitHub Pages)

Because the web application lives at the root of the repository, publishing changes to your public GitHub Pages URL is as simple as pushing a Git commit:

```bash
cd "/Users/joshuamacmillan/Documents/R Projects/FHIP Pooled Estimates"
git add .
git commit -m "Update flood frequency estimates dataset"
git push origin main
```

Within 1–2 minutes, GitHub Pages will automatically refresh your live site.

---

## Hydrological Standards & Methodology

* **National Guidance**: Flood Estimation Handbook (FEH) and CIRIA C753 / Environment Agency & NRW operational guidelines.
* **Peak Flows Version**: National River Flow Archive (NRFA) Peak Flows V15 / WINFAP-FEH files.
* **Software**: `UKFE` version 2.15.1.
* **Target Pooling Group Size**: 800 station-years per pooling group.
* **De-Urbanisation**: Applied to donor stations with $\text{URBEXT2015} > 0.03$.
* **Distribution Selection**: Automatic candidate distribution fitting (GEV, GenLog, Gumbel, Kappa 3-parameter) with best-fit selected by minimum $|Z|$ distance against the 1.645 statistical threshold.
* **Confidence Intervals**: 95% error bounds calculated via UKFE Factorial Standard Error ($FSE$) formulations.
